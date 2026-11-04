// Orchestration: detect session -> tail -> normalize + redact -> (dry-run print | relay).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { createRedactor, compileHide } from './shared/redact/index.js';
import { LIMITS, makeEvent } from './shared/schema/index.js';
import { parseArgs, HELP } from './args.js';
import { Tailer } from './tail.js';
import { findSessions, waitForSession, readHead } from './session.js';
import { createNormalizer } from './normalize.js';
import { fitEvent } from './events.js';
import { isValidWallet } from './wallet.js';
import { relayBases, createStream, deleteStream, RelayClient, ApiError } from './relay.js';
import { saveStream, readStreams, removeStream, storePath } from './store.js';
import { statusLine, fmtDuration, printQr } from './ui.js';

export const DEFAULT_RELAY = 'wss://peekmarquee.live';
const IDLE_MS = 20_000;
const ENDED_MS = 30 * 60_000;
const ROTATE_IDLE_MS = 180_000;
const WAIT_MS = 10 * 60_000;

export function cliVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
}

const cleanTitle = (t) => String(t).replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.TITLE_MAX);

function ask(q, input, output) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test hooks: env, cwd, home, stdout, stderr, stdin, fetchImpl, loadWs, signal (AbortSignal = Ctrl+C), waitMs
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const home = deps.home || os.homedir();
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const fetchImpl = deps.fetchImpl || fetch;
  const loadWs = deps.loadWs || (async () => (await import('ws')).default);
  const version = cliVersion();

  const a = parseArgs(argv);
  if (a.errors.length) { err.write(`${a.errors.join('\n')}\nTry: peekmarquee --help\n`); return 2; }
  if (a.help) { out.write(HELP); return 0; }
  if (a.version) { out.write(`${version}\n`); return 0; }

  const relay = a.relay || env.PEEKMARQUEE_RELAY || DEFAULT_RELAY;
  let bases;
  try { bases = relayBases(relay); } catch { err.write(`invalid relay URL: ${relay}\n`); return 2; }

  if (a.command === 'delete') return deleteCommand(a, { bases, fetchImpl, out, err, env });

  if (a.agent && a.agent !== 'claude') { err.write(`--agent ${a.agent}: not supported in this version (only "claude")\n`); return 2; }
  if (a.wallet !== undefined && !isValidWallet(a.wallet)) { err.write('--wallet: not a valid address (0x + 40 hex, EIP-55 checksum if mixed case)\n'); return 2; }
  for (const h of a.hide) if (compileHide([h]).length !== 1) { err.write(`--hide: invalid pattern ${h}\n`); return 2; }

  let title = a.title !== undefined ? cleanTitle(a.title) : 'Untitled session';
  if (!title) title = 'Untitled session';
  const dry = !!a.dryRun;
  const isTty = !!err.isTTY;
  const log = (s) => err.write(`${s}\n`);

  // ---- Ctrl+C ----
  let stopResolve; const stopped = new Promise((r) => { stopResolve = r; });
  let stopReason = null;
  const ac = new AbortController();
  const requestStop = (reason) => { if (!stopReason) { stopReason = reason; ac.abort(); stopResolve(reason); } else if (reason === 'ctrl_c' && stopReason === 'ctrl_c') process.exit(130); };
  const onSig = () => requestStop('ctrl_c');
  if (deps.signal) deps.signal.addEventListener('abort', onSig, { once: true });
  else { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); }
  const cleanupSignals = () => { if (!deps.signal) { process.off('SIGINT', onSig); process.off('SIGTERM', onSig); } };

  // ---- find the transcript ----
  let file; let head = null;
  if (a.file) {
    file = path.resolve(cwd, a.file);
    if (!fs.existsSync(file)) { err.write(`file not found: ${a.file}\n`); cleanupSignals(); return 1; }
    head = await readHead(file);
  } else {
    const opts = { cwd, home };
    let found = await waitForSession(opts, {
      timeoutMs: deps.waitMs ?? WAIT_MS,
      onWait: () => log('No active Claude Code session in this folder. Start `claude` here, then run `npx peekmarquee` again.\nWaiting up to 10 minutes...'),
      signal: ac.signal,
    });
    if (stopReason) { cleanupSignals(); return 0; }
    if (!found.length) { cleanupSignals(); return 1; }
    if (found.length > 1) log(pc.yellow(`${found.length} active sessions found, streaming ${found[0].sessionId} (use --file to pick)`));
    file = found[0].file; head = found[0];
  }

  // ---- pipeline ----
  const redactor = createRedactor({ hide: a.hide });
  const norm = createNormalizer({ cwd, home, redactor, noPrompts: !!a.noPrompts });
  const startedAt = Date.now();
  let seq = 0; let eventsOut = 0; let parseErrors = 0; let last = ''; let viewers = null; let state = 'connected';
  let client = null; let streamUrl = null; let streamId = null;
  let lastActivity = Date.now(); let idleSent = false;

  const sink = (ev) => {
    eventsOut++;
    if (dry) out.write(`${JSON.stringify(ev)}\n`);
    else client.send(ev);
  };
  const emit = (type, data) => {
    seq++;
    const ev = makeEvent(seq, type, data, type === 'hello' || type === 'end' ? undefined : redactor.count);
    fitEvent(ev, LIMITS.FRAME_MAX_BYTES - 2048);
    sink(ev);
  };

  if (!dry) {
    let created = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await createStream({ http: bases.http, title, agent: 'claude', wallet: a.wallet, isPublic: !a.private, replay: !a.noReplay, fetchImpl });
      } catch (e) {
        if (e instanceof ApiError && e.status === 400 && isTty && (deps.stdin || process.stdin).isTTY) {
          log(pc.yellow(`The relay did not accept that title (${e.body?.error || e.body?.msg || 'rejected'}).`));
          title = cleanTitle(await ask('New title: ', deps.stdin || process.stdin, err)) || 'Untitled session';
          continue;
        }
        err.write(`Could not create the stream: ${e.message}\n`);
        cleanupSignals();
        return 1;
      }
    }
    if (!created) { cleanupSignals(); return 1; }
    streamId = created.id; streamUrl = created.url || `${bases.http}/s/${created.id}`;
    saveStream(streamId, { token: created.ingestToken, manageKey: created.manageKey || null, url: streamUrl, relay: bases.http, title, createdAt: new Date().toISOString() });
    const WS = await loadWs();
    client = new RelayClient({ wsUrl: `${bases.ws}/ingest/${streamId}`, token: created.ingestToken, WebSocketImpl: WS });
    client.on('viewers', (n) => { viewers = n; });
    client.on('state', (s) => { state = s === 'reconnecting' ? 'reconnecting' : 'connected'; });
    client.on('warn', (m) => log(pc.dim(m)));
    client.on('fatal', (e) => { log(pc.red(`Stream stopped: ${e.message}`)); requestStop('fatal'); });
  } else {
    log(pc.dim('[dry-run] not connecting to anything. Events below (JSON lines on stdout) are exactly what would be sent, already redacted.'));
  }

  emit('hello', {
    cli: version, agent: 'claude', agentVersion: head?.version || undefined, title,
    wallet: a.wallet || null, replay: !a.noReplay, public: !a.private,
  });
  if (!dry) {
    client.start();
    out.write(`${pc.bold('Streaming')}  ${pc.cyan(streamUrl)}   (viewers 0 · 0 secrets hidden)\n`);
    log(pc.dim(`Read-only: viewers cannot type into your session. Stop with Ctrl+C. Delete now: npx peekmarquee delete ${streamId}`));
    if (isTty) await printQr(streamUrl, err);
  }

  // ---- tail ----
  const onLine = (line) => {
    lastActivity = Date.now(); idleSent = false;
    let obj;
    try { obj = JSON.parse(line); } catch { parseErrors++; return; }
    let evs;
    try { evs = norm.feed(obj); } catch { parseErrors++; return; }
    for (const e of evs) {
      emit(e.type, e.data);
      if (e.type === 'tool_call') last = `${e.data.tool}${e.data.summary ? ` ${e.data.summary}` : ''}`.slice(0, 40);
      else if (e.type === 'edit') last = `Edit ${e.data.path}`.slice(0, 40);
    }
  };
  let tailer = new Tailer({ file, fromStart: !!a.fromStart, onLine, onSkip: () => { parseErrors++; } });
  await tailer.start();
  let currentFile = file;

  // ---- timers ----
  let renderTimer = null;
  const render = () => {
    if (!isTty || dry) return;
    err.write(`\r\x1b[2K${statusLine({ startedAt, viewers, red: redactor.count, last, state })}`);
  };
  if (isTty && !dry) { renderTimer = setInterval(render, 1000); renderTimer.unref?.(); }

  let rotating = false;
  const tick = setInterval(async () => {
    const now = Date.now();
    if (!idleSent && now - lastActivity >= IDLE_MS) { idleSent = true; emit('status', { state: 'idle' }); }
    if (now - lastActivity >= ENDED_MS) { requestStop('session_ended'); return; }
    if (!rotating && tailer.idleMs >= ROTATE_IDLE_MS && !a.file) {
      rotating = true;
      try {
        const found = await findSessions({ cwd, home, exclude: [currentFile] });
        if (found.length) {
          tailer.close();
          currentFile = found[0].file;
          tailer = new Tailer({ file: currentFile, fromStart: true, onLine, onSkip: () => { parseErrors++; } });
          await tailer.start();
          emit('status', { state: 'resumed' });
        }
      } catch { /* try again next tick */ } finally { rotating = false; }
    }
  }, 1000);
  tick.unref?.();

  // ---- run until stopped ----
  const reason = await stopped;
  clearInterval(tick); if (renderTimer) clearInterval(renderTimer);
  tailer.close();
  emit('end', { reason: reason === 'fatal' ? 'error' : reason });
  if (client && reason !== 'fatal') await client.finish(3000); else client?.terminate();
  cleanupSignals();

  if (isTty && !dry) err.write('\r\x1b[2K');
  const classes = Object.entries(redactor.classes).map(([k, v]) => `${k} ${v}`).join(', ');
  log(`${pc.bold('Stopped.')} ${fmtDuration(Date.now() - startedAt)} · ${norm.stats.toolCalls} tool calls · ${eventsOut} events · ${redactor.count} secrets hidden${classes ? ` (${classes})` : ''}${parseErrors ? ` · ${parseErrors} unreadable lines` : ''}${norm.stats.unknownShapes ? ` · unknown line shapes: ${norm.stats.unknownShapes}` : ''}`);
  if (!dry && !a.noReplay && streamUrl) log(`Replay (kept 24 hours): ${pc.cyan(streamUrl)}\nDelete now: npx peekmarquee delete ${streamId}`);
  return reason === 'fatal' ? 1 : 0;
}

async function deleteCommand(a, { bases, fetchImpl, out, err }) {
  if (!a.id) { err.write('usage: peekmarquee delete <id>\n'); return 2; }
  const rec = readStreams()[a.id];
  if (!rec) { err.write(`No saved token for stream ${a.id} in ${storePath()} (only streams started from this machine can be deleted here).\n`); return 1; }
  const http = a.relay || process.env.PEEKMARQUEE_RELAY ? bases.http : (rec.relay || bases.http);
  try {
    const status = await deleteStream({ http, id: a.id, token: rec.token, fetchImpl });
    if (status === 200 || status === 204 || status === 410 || status === 404) { removeStream(a.id); out.write(`Deleted stream ${a.id}${status === 200 || status === 204 ? ' (replay removed)' : ' (already gone)'}.\n`); return 0; }
    err.write(`relay answered ${status}; stream not deleted.\n`); return 1;
  } catch (e) { err.write(`Could not reach the relay: ${e.message}\n`); return 1; }
}
