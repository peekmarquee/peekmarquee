// Claude Code transcript line (parsed JSON) -> wire events.
// Everything that leaves this module is already redacted and truncated. Nothing here does I/O.
//
// Never emitted: thinking text, usage, cwd, gitBranch, folder names, attachments, api-request*, file-history-*.
// Absolute paths are rewritten: cwd -> ".", home -> "~", other users' homes -> "…/<basename>".

import path from 'node:path';
import { classifyTool, clipBytes, scrubSensitiveLines } from './shared/redact/index.js';
import { LIMITS } from './shared/schema/index.js';

const PRE_CAP = 64 * 1024; // chars looked at before redaction; everything after is dropped by the final clip anyway
const PATH_KEYS = new Set(['file_path', 'path', 'pattern', 'notebook_path', 'glob', 'url']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const INJECTED_PREFIXES = ['<system-reminder', '<command-', '<local-command', '<task-notification', '<browser_', 'Caveat:'];
const MAX_PENDING = 500;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createNormalizer({ cwd, home, redactor, noPrompts = false }) {
  const roots = [...new Set([cwd].filter((c) => c && c.length > 1))].sort((a, b) => b.length - a.length);
  const rootRes = roots.map((r) => new RegExp(`${esc(r)}(?=$|[/\\s"'\`:,;)\\]}>])`, 'g'));
  const homeRe = home && home.length > 1 ? new RegExp(`${esc(home)}(?=$|[/\\s"'\`:,;)\\]}>])`, 'g') : null;
  const otherHomeRe = /\/(?:Users|home)\/[^/\s"'`:]+/g;

  const stats = { toolCalls: 0, edits: 0, events: 0, unknownShapes: 0 };
  const pending = new Map(); // tool_use id -> { tool, hidden, path, writeLines, writeHead }
  let thinkingSent = false;

  function scrubPaths(s) {
    if (!s) return s;
    for (const re of rootRes) s = s.replace(re, '.');
    if (homeRe) s = s.replace(homeRe, '~');
    // a leftover /Users/<name> that is not our home must not leak the user name
    return s.replace(otherHomeRe, '/~other');
  }

  function relPath(p) {
    if (typeof p !== 'string') return '';
    let s = p;
    if (path.isAbsolute(s)) {
      for (const r of roots) {
        if (s === r) return '.';
        if (s.startsWith(r + '/')) return s.slice(r.length + 1);
      }
      if (home && s.startsWith(home + '/')) return '~/' + s.slice(home.length + 1);
      if (/^\/(?:Users|home)\//.test(s)) return '…/' + path.basename(s);
    }
    return s;
  }

  const clean = (s, { entropy = true } = {}) => redactor.text(scrubPaths(String(s).slice(0, PRE_CAP)), { entropy });
  const clipChars = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const clip = (s, n) => clipBytes(s, n).text;

  function summarize(tool, input) {
    const i = input && typeof input === 'object' ? input : {};
    const str = (v) => (typeof v === 'string' ? v : '');
    switch (tool) {
      case 'Bash': return clipChars(clean(str(i.command)), LIMITS.SUMMARY_BASH_MAX);
      case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
        return clip(clean(relPath(str(i.file_path || i.notebook_path)), { entropy: false }), 300);
      case 'Grep': case 'Glob': return clip(clean(str(i.pattern), { entropy: false }), 300);
      case 'Agent': case 'Task': return clip(`subagent: ${clean(str(i.description || i.subagent_type || ''))}`, 300);
      case 'WebFetch': return clip(clean(str(i.url), { entropy: false }), 300);
      case 'WebSearch': return clip(clean(str(i.query)), 300);
      case 'TodoWrite': return 'update todos';
      default: return clip(tool, 120); // MCP tools: just the tool name
    }
  }

  // Prune a tool input object: strings <= 1 KB, total <= 4 KB, redacted. `hide` keeps only path-ish keys.
  function pruneArgs(tool, input, hide) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    const conv = (v, key, depth) => {
      if (typeof v === 'string') {
        if (hide && !PATH_KEYS.has(key) && key !== 'command') return '[hidden]';
        const val = PATH_KEYS.has(key) && path.isAbsolute(v) ? relPath(v) : v;
        return clip(clean(val, { entropy: !PATH_KEYS.has(key) }), LIMITS.ARG_VALUE_MAX_BYTES);
      }
      if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
      if (depth >= 3) return '[…]';
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => conv(x, key, depth + 1));
      if (typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = conv(x, k, depth + 1);
        return o;
      }
      return undefined;
    };
    for (const [k, v] of Object.entries(input).slice(0, 30)) {
      const c = conv(v, k, 0);
      if (c !== undefined) out[k] = c;
    }
    // total <= 4 KB: shorten the longest strings until it fits
    for (let n = 0; n < 40 && Buffer.byteLength(JSON.stringify(out)) > LIMITS.ARGS_TOTAL_MAX_BYTES; n++) {
      let longestKey = null;
      let longest = 0;
      for (const [k, v] of Object.entries(out)) {
        const len = typeof v === 'string' ? v.length : JSON.stringify(v).length;
        if (len > longest) { longest = len; longestKey = k; }
      }
      if (!longestKey || longest < 64) break;
      const v = out[longestKey];
      out[longestKey] = typeof v === 'string' ? v.slice(0, Math.floor(v.length / 2)) : '[…]';
    }
    return out;
  }

  function resultText(content) {
    // returns { text, image } with at most PRE_CAP chars and the original byte size
    if (typeof content === 'string') return { text: content.slice(0, PRE_CAP), bytes: Buffer.byteLength(content), image: false };
    if (!Array.isArray(content)) return { text: '', bytes: 0, image: false };
    let image = false;
    let bytes = 0;
    const parts = [];
    let have = 0;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image') { image = true; continue; }
      if (b.type === 'text' && typeof b.text === 'string') {
        bytes += Buffer.byteLength(b.text);
        if (have < PRE_CAP) { parts.push(b.text.slice(0, PRE_CAP - have)); have += parts[parts.length - 1].length; }
      }
    }
    return { text: parts.join('\n'), bytes, image };
  }

  function countPatch(patch) {
    let added = 0;
    let removed = 0;
    const lines = [];
    for (const h of Array.isArray(patch) ? patch : []) {
      for (const l of Array.isArray(h && h.lines) ? h.lines : []) {
        if (typeof l !== 'string') continue;
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
        if (lines.join('\n').length < PRE_CAP) lines.push(l);
      }
    }
    return { added, removed, snippet: lines.join('\n') };
  }

  const lineCount = (s) => (s ? s.split('\n').length : 0);

  function pushPending(id, rec) {
    pending.set(id, rec);
    if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  }

  // ---- per line ----
  function feed(obj) {
    const out = [];
    if (!obj || typeof obj !== 'object') return out;
    if (obj.type !== 'user' && obj.type !== 'assistant') return out; // everything else is dropped unread
    if (obj.isSidechain === true) return out; // subagent traffic: only the Agent tool call/result in the main thread is shown
    const msg = obj.message;
    if (!msg || typeof msg !== 'object') { stats.unknownShapes++; return out; }
    const content = msg.content;

    if (obj.type === 'assistant') {
      if (msg.model === '<synthetic>') return out;
      if (!Array.isArray(content)) { stats.unknownShapes++; return out; }
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'thinking') {
          if (!thinkingSent) { thinkingSent = true; out.push({ type: 'status', data: { state: 'thinking' } }); }
        } else if (b.type === 'text') {
          if (typeof b.text !== 'string' || !b.text.trim()) continue;
          thinkingSent = false;
          out.push({ type: 'text', data: { text: clip(clean(b.text), LIMITS.TEXT_MAX_BYTES) } });
        } else if (b.type === 'tool_use') {
          thinkingSent = false;
          out.push(toolCall(b));
        }
      }
      return out;
    }

    // ---- user ----
    if (typeof content === 'string') {
      const p = humanPrompt(obj, content);
      if (p) out.push(p);
      return out;
    }
    if (!Array.isArray(content)) { stats.unknownShapes++; return out; }
    const results = content.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      thinkingSent = false;
      for (const r of results) out.push(...toolResult(r, obj.toolUseResult));
      return out;
    }
    // human prompt as text blocks (Claude Code 2.1 writes prompts this way)
    const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (text) {
      const p = humanPrompt(obj, text);
      if (p) out.push(p);
    }
    return out;
  }

  function humanPrompt(obj, text) {
    if (obj.isMeta === true) return null;
    const kind = obj.origin && typeof obj.origin === 'object' ? obj.origin.kind : undefined;
    if (kind !== undefined && kind !== 'human') return null; // peer / task-notification / system injected
    const t = text.trimStart();
    if (!t || INJECTED_PREFIXES.some((p) => t.startsWith(p))) return null;
    thinkingSent = false;
    if (noPrompts) return null;
    return { type: 'prompt', data: { text: clip(clean(text), LIMITS.PROMPT_MAX_BYTES) } };
  }

  function toolCall(b) {
    const tool = typeof b.name === 'string' ? b.name : 'unknown';
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const id = typeof b.id === 'string' ? b.id : `x_${stats.toolCalls}`;
    const cls = classifyTool(tool, input);
    const rec = { tool, hidden: cls.hidden, path: cls.path || '', file: typeof input.file_path === 'string' ? input.file_path : '' };
    if (EDIT_TOOLS.has(tool)) {
      const body = typeof input.content === 'string' ? input.content : typeof input.new_string === 'string' ? input.new_string : '';
      rec.writeLines = lineCount(body);
      rec.writeHead = body.slice(0, 4096);
      rec.oldLines = typeof input.old_string === 'string' ? lineCount(input.old_string) : 0;
    }
    pushPending(id, rec);
    stats.toolCalls++;
    return {
      type: 'tool_call',
      data: { id, tool, summary: summarize(tool, input), args: pruneArgs(tool, input, cls.hidden !== null) },
    };
  }

  function toolResult(r, tur) {
    const forId = typeof r.tool_use_id === 'string' ? r.tool_use_id : '';
    const rec = pending.get(forId) || { tool: '', hidden: null };
    pending.delete(forId);
    const isError = r.is_error === true;
    const { text, bytes, image } = resultText(r.content);
    const imageFlag = image || (tur && typeof tur === 'object' && tur.isImage === true);

    if (rec.hidden) {
      redactor.bump(rec.hidden);
      const base = rec.hidden === 'env_dump' ? '[output hidden: environment dump]'
        : `[file hidden: ${path.basename(rec.path || rec.file || 'file').replace(/[^\w.@+-]/g, '_').slice(0, 60)}]`;
      if (EDIT_TOOLS.has(rec.tool) && !isError) {
        stats.edits++;
        const pc = countPatch(tur && tur.structuredPatch);
        return [{ type: 'edit', data: {
          path: clip(clean(relPath(rec.file), { entropy: false }), 300),
          added: pc.added || rec.writeLines || 0, removed: pc.removed || rec.oldLines || 0, snippet: '[edit hidden]',
        } }];
      }
      return [{ type: 'tool_result', data: { forId, text: base, bytes, truncated: false, isError, hidden: rec.hidden } }];
    }

    if (imageFlag && !text) {
      return [{ type: 'tool_result', data: { forId, text: '[image]', bytes, truncated: false, isError, hidden: 'binary' } }];
    }

    if (EDIT_TOOLS.has(rec.tool) && !isError) {
      const pc = countPatch(tur && tur.structuredPatch);
      let { added, removed, snippet } = pc;
      if (!snippet && rec.writeHead) {
        added = rec.writeLines;
        removed = rec.oldLines || 0;
        snippet = rec.writeHead.split('\n').slice(0, 40).map((l) => `+${l}`).join('\n');
      }
      stats.edits++;
      const p = (tur && typeof tur.filePath === 'string' && tur.filePath) || rec.file;
      return [{ type: 'edit', data: {
        path: clip(clean(relPath(p), { entropy: false }), 300), added, removed,
        snippet: clip(clean(snippet), LIMITS.SNIPPET_MAX_BYTES),
      } }];
    }

    let body = text;
    if (rec.tool === 'Grep' || rec.tool === 'Bash') {
      const s = scrubSensitiveLines(body);
      if (s.hidden) { redactor.bump('sensitive_path', s.hidden); body = s.text; }
    }
    const c = clipBytes(clean(body), LIMITS.RESULT_MAX_BYTES);
    return [{ type: 'tool_result', data: {
      forId, text: c.text, bytes, truncated: c.truncated || bytes > PRE_CAP, isError, hidden: null,
    } }];
  }

  return { feed, stats, relPath, scrubPaths };
}
