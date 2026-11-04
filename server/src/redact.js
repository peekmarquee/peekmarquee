// Second redaction pass. Prefers the shared module (shared/redact);
// falls back to a built-in implementation of the speco the relay always has a safety net.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private_key'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'api_key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, 'token'],
  [/github_pat_[A-Za-z0-9_]{22,}/g, 'token'],
  [/glpat-[A-Za-z0-9_-]{20,}/g, 'token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'api_key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'token'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'api_key'],
  [/ya29\.[A-Za-z0-9_-]+/g, 'token'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, 'api_key'],
  [/SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, 'api_key'],
  [/npm_[A-Za-z0-9]{36}/g, 'token'],
  [/pypi-AgEI[A-Za-z0-9_-]+/g, 'token'],
  [/dop_v1_[a-f0-9]{64}/g, 'token'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'token'],
  [/\br8_[A-Za-z0-9]{30,}/g, 'token'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, 'token'],
  [/[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, 'token'],
  [/(?<=Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, 'token'],
  [/(?<=\b(?:DATABASE_URL|REDIS_URL|MONGODB_URI|AMQP_URL)=)[^\s"']+/g, 'env_value'],
  [/(?<=:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g, 'credential_url'],
  [/(?<=\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key)\s*[:=]\s*["']?)[^\s"']{8,}/gi, 'env_value'],
];
const HEX64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const HEX_CTX = /key|private|secret|pk|mnemonic|seed/i;

function fallbackRedact(text) {
  let count = 0;
  let out = text;
  for (const [re, cls] of PATTERNS) {
    out = out.replace(re, () => { count++; return `[redacted:${cls}]`; });
  }
  out = out.split('\n').map((line) => {
    const ctx = HEX_CTX.test(line);
    return line.replace(HEX64, (m, off) => {
      if (!ctx && !/[=:]\s*["']?$/.test(line.slice(0, off))) return m;
      count++; return '[redacted:private_key]';
    });
  }).join('\n');
  return { text: out, count };
}

let shared = null;
let source = 'builtin';

/** Loads shared/redact (createRedactor + redactEvent). Falls back to the built-in patterns if absent. */
export async function loadSharedRedact() {
  const cands = [process.env.REDACT_PATH, path.join(here, '../vendor/redact/index.js'), path.join(here, '../../shared/redact/index.js')].filter(Boolean);
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    try {
      const m = await import(pathToFileURL(c).href);
      if (typeof m.createRedactor === 'function' && typeof m.redactEvent === 'function') { shared = m; source = c; return source; }
    } catch { /* keep fallback */ }
  }
  return source;
}
export const redactSource = () => source;

const SKIP_KEYS = new Set(['id', 'forId', 'tool', 'state', 'reason', 'hidden', 'cli', 'agent', 'wallet']);
function walkFallback(value, key) {
  if (typeof value === 'string') {
    if (SKIP_KEYS.has(key)) return { value, count: 0 };
    const r = fallbackRedact(value);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const arr = value.map((v) => { const r = walkFallback(v, key); count += r.count; return r.value; });
    return { value: arr, count };
  }
  if (value && typeof value === 'object') {
    let count = 0; const o = {};
    for (const [k, v] of Object.entries(value)) { const r = walkFallback(v, k); count += r.count; o[k] = r.value; }
    return { value: o, count };
  }
  return { value, count: 0 };
}

/** Second redaction pass over an event's `data`. Returns {value, count}. */
export function redactData(data) {
  if (shared) {
    const r = shared.createRedactor();
    const out = shared.redactEvent({ data }, r);
    return { value: out.data, count: r.count };
  }
  return walkFallback(data, '');
}
