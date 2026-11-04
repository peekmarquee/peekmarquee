// PEEKMARQUEE redaction — single source of truth, used by the CLI (on device) and the relay (second pass).
// Pure functions, no I/O, no dependencies. See shared/README.md for the exported API.
//
// What it does:
//   (a) whole results are hidden for tools that touch sensitive paths / dump the environment (classifyTool)
//   (b) well-known secret patterns are replaced with [redacted:<class>]
//   (c) high-entropy tokens are replaced with [redacted:high-entropy]
//   (d) user supplied --hide globs / regexes are replaced with [redacted:custom]
// Replacement text never contains the original text, its length or a hash of it.

import WORDS from './wordlist.js';

export const CLASSES = Object.freeze([
  'api_key', 'token', 'private_key', 'seed_phrase', 'credential_url',
  'jwt', 'high-entropy', 'env_value', 'custom',
]);

const BIP39 = new Set(WORDS);
const tag = (cls) => `[redacted:${cls}]`;
const isRedacted = (s) => s.startsWith('[redacted');

// ---------------------------------------------------------------- (b) patterns

// Rules with a plain "replace whole match" behaviour. Order matters (specific before generic).
// Every regex has a lookbehind so that e.g. "task-..." is not mistaken for "sk-...".
const NB = '(?<![A-Za-z0-9_])'; // not preceded by identifier char
const WHOLE_RULES = [
  // private keys (PEM / PGP). Also matches a truncated block (no END marker) up to the end of the string.
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['api_key', new RegExp(`${NB}sk-[A-Za-z0-9_-]{20,}`, 'g')], // OpenAI, Anthropic sk-ant-...
  ['token', new RegExp(`${NB}gh[pousr]_[A-Za-z0-9]{36,}`, 'g')],
  ['token', new RegExp(`${NB}github_pat_[A-Za-z0-9_]{22,}`, 'g')],
  ['token', new RegExp(`${NB}glpat-[A-Za-z0-9_-]{20,}`, 'g')],
  ['api_key', new RegExp(`${NB}AKIA[0-9A-Z]{16}(?![A-Z0-9])`, 'g')],
  ['token', new RegExp(`${NB}xox[baprs]-[A-Za-z0-9-]{10,}`, 'g')],
  ['api_key', new RegExp(`${NB}AIza[0-9A-Za-z_-]{35}`, 'g')],
  ['token', new RegExp(`${NB}ya29\\.[A-Za-z0-9_-]+`, 'g')],
  ['api_key', new RegExp(`${NB}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`, 'g')], // Stripe
  ['api_key', new RegExp(`${NB}SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}`, 'g')],
  ['token', new RegExp(`${NB}npm_[A-Za-z0-9]{36}`, 'g')],
  ['token', new RegExp(`${NB}pypi-AgEI[A-Za-z0-9_-]+`, 'g')],
  ['token', new RegExp(`${NB}dop_v1_[a-f0-9]{64}`, 'g')],
  ['api_key', new RegExp(`${NB}hf_[A-Za-z0-9]{30,}`, 'g')],
  ['api_key', new RegExp(`${NB}r8_[A-Za-z0-9]{30,}`, 'g')],
  ['token', /(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g], // Telegram bot
  ['token', /(?<![A-Za-z0-9_-])[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g], // Discord bot
];

const KV_NAMES = '(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key)';
const KV_RE = new RegExp(`(${KV_NAMES})(["']?\\s*[:=]\\s*["']?)([^\\s"']{8,})`, 'gi');
const ENV_URL_RE = /\b(DATABASE_URL|REDIS_URL|MONGODB_URI|AMQP_URL)(\s*[=:]\s*["']?)([^\s"']+)/g;
const AWS_SECRET_RE = /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{30,})/gi;
const AUTH_RE = /(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([^\s"']+)/gi;
const URL_CRED_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@"'<>:]+:[^\s/@"'<>]+)(@)/gi;
const QUERY_SECRET_RE = /([?&](?:key|token|secret|password|passwd|apikey|api_key|access_token|sig|dkey|signature|auth)=)([^&\s"'#<>]+)/gi;
const PAID_RPC_RE = /(?:wss?|https?):\/\/(?:[A-Za-z0-9-]+\.)*(?:alchemy\.com|infura\.io|quiknode\.pro|chainstack\.com|drpc\.org|ankr\.com)[^\s"'<>]*/gi;
const HEX64_RE = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
const HEX64_KEYWORD = /(?<![A-Za-z])(?:key|private|secret|pk|mnemonic|seed)(?![a-z])/i;
const HEX64_BENIGN_LABEL = /(?:tx|txn|hash|txhash|transaction|block|blockhash|commit|sha\d*|digest|id|root|checksum|salt|nonce|topic)["']?\s*$/i;

function scrubPaidRpc(match, hit) {
  const qIdx = match.search(/[?#]/);
  const base = qIdx === -1 ? match : match.slice(0, qIdx);
  const rest = qIdx === -1 ? '' : match.slice(qIdx);
  const m = /^(.*?\/)([A-Za-z0-9_-]{8,})(\/?)$/.exec(base);
  if (m && !/^(?:rpc|v\d)$/i.test(m[2])) {
    hit('credential_url');
    return `${m[1]}${tag('credential_url')}${m[3]}${rest}`;
  }
  return match;
}

function scrubHex64(str, hit) {
  return str.replace(HEX64_RE, (m, offset) => {
    const ls = str.lastIndexOf('\n', offset - 1) + 1;
    let le = str.indexOf('\n', offset + m.length);
    if (le === -1) le = str.length;
    const line = str.slice(ls, le);
    let redact = HEX64_KEYWORD.test(line);
    if (!redact) {
      // value directly after "=" or ":" (optionally with quotes/space)
      const before = str.slice(Math.max(ls, offset - 80), offset);
      const sm = /([A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?$/.exec(before);
      if (sm) {
        const label = before.slice(0, before.length - sm[0].length) + sm[1];
        redact = !HEX64_BENIGN_LABEL.test(label + '');
      }
    }
    if (!redact) return m;
    hit('private_key');
    return tag('private_key');
  });
}

function scrubSeedPhrases(str, hit) {
  if (str.length < 40) return str;
  const runRe = /[A-Za-z]+(?:[ \t\r\n,;]+[A-Za-z]+){11,}/g;
  const spans = [];
  let m;
  while ((m = runRe.exec(str))) {
    const base = m.index;
    const wordRe = /[A-Za-z]+/g;
    let w;
    let streakStart = -1;
    let streakEnd = -1;
    let streakLen = 0;
    const flush = () => {
      if (streakLen >= 12) spans.push([streakStart, streakEnd]);
      streakLen = 0; streakStart = -1;
    };
    while ((w = wordRe.exec(m[0]))) {
      if (BIP39.has(w[0].toLowerCase())) {
        if (streakLen === 0) streakStart = base + w.index;
        streakEnd = base + w.index + w[0].length;
        streakLen++;
      } else flush();
    }
    flush();
  }
  if (!spans.length) return str;
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    out += str.slice(pos, s) + tag('seed_phrase');
    pos = e;
    hit('seed_phrase');
  }
  return out + str.slice(pos);
}

// ---------------------------------------------------------------- (c) entropy

export function shannon(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

function looksHighEntropy(tok, before) {
  if (/^(?:0x)?[0-9a-fA-F]+$/.test(tok) && tok.length <= 66) return false; // tx hashes, addresses
  if (UUID_RE.test(tok)) return false;
  if (/^(?:sha\d+|blake\w*)[-:]/i.test(tok) || /(?:sha\d+|blake\w*):$/i.test(before)) return false; // integrity hashes
  // random secrets virtually always mix letters and digits; pure-letter runs are identifiers / words
  if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) return false;
  // path-like: two or more "/" and no base64 "+"/"=" (random base64 of 32-100 chars almost never has two slashes)
  if ((tok.match(/\//g) || []).length >= 2 && !/[+=]/.test(tok)) return false;
  if (/^[A-Za-z_]+=\//.test(tok)) return false; // VAR=/some/path
  // lowercase kebab / snake case names (docker image names, slugs, ids made of words)
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+){3,}$/.test(tok)) return false;
  return shannon(tok) >= 4.0;
}

function scrubEntropy(str, hit) {
  return str.replace(ENTROPY_TOKEN_RE, (m, offset) => {
    if (!looksHighEntropy(m, str.slice(Math.max(0, offset - 10), offset))) return m;
    hit('high-entropy');
    return tag('high-entropy');
  });
}

// ---------------------------------------------------------------- (d) custom --hide

/** Compile `--hide` values: "/regex/flags" or a glob (* and ?) or a literal. Returns RegExp[] (global). */
export function compileHide(patterns = []) {
  const out = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || !p) continue;
    const rm = /^\/(.+)\/([a-z]*)$/s.exec(p);
    try {
      if (rm) {
        const flags = rm[2].includes('g') ? rm[2] : rm[2] + 'g';
        out.push(new RegExp(rm[1], flags));
      } else {
        const src = p.split('').map((ch) => (ch === '*' ? '\\S*' : ch === '?' ? '\\S' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
        out.push(new RegExp(src, 'g'));
      }
    } catch { /* invalid pattern: ignored; CLI validates before start */ }
  }
  return out;
}

// ---------------------------------------------------------------- main scrub

function scrub(input, { entropy = true, hide = [] } = {}, hit) {
  let s = input;
  if (!s) return s;

  for (const [cls, re] of WHOLE_RULES) {
    re.lastIndex = 0;
    s = s.replace(re, () => { hit(cls); return tag(cls); });
  }
  s = s.replace(ENV_URL_RE, (m, k, sep, v) => (isRedacted(v) ? m : (hit('env_value'), `${k}${sep}${tag('env_value')}`)));
  s = s.replace(PAID_RPC_RE, (m) => scrubPaidRpc(m, hit));
  s = s.replace(URL_CRED_RE, (m, scheme, cred, at) => (isRedacted(cred) ? m : (hit('credential_url'), `${scheme}${tag('credential_url')}${at}`)));
  s = s.replace(QUERY_SECRET_RE, (m, k, v) => (isRedacted(v) ? m : (hit('credential_url'), `${k}${tag('credential_url')}`)));
  s = s.replace(AUTH_RE, (m, k, v) => (isRedacted(v) ? m : (hit('token'), `${k}${tag('token')}`)));
  s = s.replace(AWS_SECRET_RE, (m, k, v) => (isRedacted(v) ? m : (hit('api_key'), `${k}${tag('api_key')}`)));
  s = s.replace(KV_RE, (m, k, sep, v) => (isRedacted(v) ? m : (hit('token'), `${k}${sep}${tag('token')}`)));
  s = scrubHex64(s, hit);
  s = scrubSeedPhrases(s, hit);
  for (const re of hide) {
    re.lastIndex = 0;
    s = s.replace(re, (m) => (m ? (hit('custom'), tag('custom')) : m));
  }
  if (entropy) s = scrubEntropy(s, hit);
  return s;
}

/** Stateless: returns { text, hits } where hits maps class -> number of replacements. */
export function redactText(str, opts = {}) {
  const hits = {};
  const hide = opts.hide && opts.hide.length && opts.hide[0] instanceof RegExp ? opts.hide : compileHide(opts.hide || []);
  const text = scrub(String(str), { entropy: opts.entropy !== false, hide }, (c) => { hits[c] = (hits[c] || 0) + 1; });
  return { text, hits };
}

/**
 * Stateful redactor: keeps the cumulative counter that goes on the wire as `red`.
 *   const r = createRedactor({ hide: ['/foo\\d+/', 'acme-*'] });
 *   r.text('sk-ant-…')            -> '[redacted:api_key]'  (r.count === 1)
 *   r.text(path, { entropy:false }) for path-like strings
 *   r.bump('sensitive_path')       -> count a whole hidden result
 */
export function createRedactor({ hide = [] } = {}) {
  const hideRes = compileHide(hide);
  let count = 0;
  const classes = {};
  const hit = (c, n = 1) => { count += n; classes[c] = (classes[c] || 0) + n; };
  return {
    text(str, { entropy = true } = {}) {
      if (typeof str !== 'string' || !str) return str;
      return scrub(str, { entropy, hide: hideRes }, hit);
    },
    bump(cls, n = 1) { hit(cls, n); },
    get count() { return count; },
    get classes() { return { ...classes }; },
    reset() { count = 0; for (const k of Object.keys(classes)) delete classes[k]; },
  };
}

// ---------------------------------------------------------------- (a) sensitive paths / env dumps

const SENSITIVE_BASENAME = [
  /^\.env($|[.*?[])/, /^\.envrc$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^id_dsa/,
  /\.keystore$/, /^credentials/, /^secrets/, /\.secret$/, /^\.npmrc$/, /^\.netrc$/, /^\.pypirc$/, /^\.git-credentials$/,
  /\.jks$/, /^wallet.*\.json$/,
];
const SENSITIVE_DIRS = new Set(['.aws', '.ssh', '.gnupg', 'keystore']);

/** True when a file path / glob / pattern points at something that commonly holds secrets. */
export function isSensitivePath(p) {
  if (typeof p !== 'string' || !p) return false;
  const norm = p.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\\/g, '/');
  if (!norm) return false;
  const segs = norm.split('/').filter(Boolean);
  if (!segs.length) return false;
  const base = segs[segs.length - 1].toLowerCase();
  if (SENSITIVE_BASENAME.some((re) => re.test(base))) return true;
  const dirs = segs.slice(0, -1).map((x) => x.toLowerCase());
  // `.aws`, `.ssh`, `.gnupg` also when the path IS the directory
  if (SENSITIVE_DIRS.has(base) && base !== 'keystore') return true;
  if (dirs.some((d) => SENSITIVE_DIRS.has(d))) return true;
  const all = segs.map((x) => x.toLowerCase());
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i] === '.kube' && all[i + 1] === 'config') return true;
    if (all[i] === '.docker' && all[i + 1] === 'config.json') return true;
    if (all[i] === '.claude' && /^settings.*\.json$/.test(all[i + 1])) return true;
  }
  return false;
}

/** Tokenise a shell command on whitespace and shell operators; true if any token is a sensitive path. */
export function bashTouchesSensitivePath(cmd) {
  if (typeof cmd !== 'string') return false;
  const toks = cmd.split(/[\s|;&<>()]+/).map((t) => t.replace(/^[-\w]+=/, '')).filter(Boolean);
  return toks.some((t) => isSensitivePath(t.replace(/^["'`$]+|["'`]+$/g, '')));
}

const ENV_DUMP_SEGMENT = [
  /^printenv\b/, /^export\s+-p\b/, /^declare\s+-[a-z]*[px]/, /^compgen\s+-v/, /^security\s+find-/, /^gh\s+auth\s+token\b/,
  /^aws\s+configure\s+get\b/, /^vault(\s|$)/, /^op(\s|$)/, /^cat\s+\/proc\/\S*environ/, /^heroku\s+config/, /^vercel\s+env\s+(pull|ls)/,
];
/** True when the command prints environment / credential stores. */
export function isEnvDumpCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  for (const raw of cmd.split(/\n|&&|\|\||[;|]/)) {
    const seg = raw.trim().replace(/^(sudo|command|builtin|exec|time)\s+/, '');
    if (!seg) continue;
    if (/^set$/.test(seg)) return true;
    if (/^env(\s+-[A-Za-z0]+)*$/.test(seg)) return true; // bare `env` (dump); `env FOO=1 cmd` runs a program, not a dump
    if (ENV_DUMP_SEGMENT.some((re) => re.test(seg))) return true;
  }
  return false;
}

const PATH_INPUT_KEYS = ['file_path', 'path', 'pattern', 'notebook_path', 'glob'];

/**
 * Decide whether the RESULT of a tool call must be hidden entirely.
 * Returns { hidden: null | 'sensitive_path' | 'env_dump', path?: <offending path> }.
 */
export function classifyTool(tool, input) {
  const inp = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash' || tool === 'BashOutput') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    if (isEnvDumpCommand(cmd)) return { hidden: 'env_dump' };
    if (bashTouchesSensitivePath(cmd)) return { hidden: 'sensitive_path', path: firstSensitiveToken(cmd) };
    return { hidden: null };
  }
  for (const k of PATH_INPUT_KEYS) {
    const v = inp[k];
    if (typeof v === 'string' && isSensitivePath(v)) return { hidden: 'sensitive_path', path: v };
  }
  return { hidden: null };
}

function firstSensitiveToken(cmd) {
  const toks = cmd.split(/[\s|;&<>()]+/).map((t) => t.replace(/^[-\w]+=/, '').replace(/^["'`$]+|["'`]+$/g, ''));
  return toks.find((t) => isSensitivePath(t)) || '';
}

/** For Grep/Bash output: replace "path:line:..." lines whose path is sensitive. Returns { text, hidden } (hidden = lines removed). */
export function scrubSensitiveLines(text) {
  if (typeof text !== 'string' || !text.includes(':')) return { text, hidden: 0 };
  let hidden = 0;
  const out = text.split('\n').map((line) => {
    const m = /^([^\s:][^:]*?)(?::\d+)?:/.exec(line);
    if (m && isSensitivePath(m[1])) { hidden++; return '[line hidden: sensitive file]'; }
    return line;
  });
  return hidden ? { text: out.join('\n'), hidden } : { text, hidden: 0 };
}

// ---------------------------------------------------------------- truncation

/** Truncate to at most maxBytes of UTF-8 without splitting a character. */
export function clipBytes(str, maxBytes) {
  if (typeof str !== 'string') return { text: '', truncated: false, bytes: 0 };
  if (str.length * 3 <= maxBytes) return { text: str, truncated: false, bytes: Buffer.byteLength(str) };
  const bytes = Buffer.byteLength(str);
  if (bytes <= maxBytes) return { text: str, truncated: false, bytes };
  let text = Buffer.from(str, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (text.endsWith('�')) text = text.slice(0, -1);
  return { text, truncated: true, bytes };
}

// ---------------------------------------------------------------- event-level helper (relay second pass)

const SKIP_KEYS = new Set(['id', 'forId', 'tool', 'state', 'reason', 'hidden', 'cli', 'agent', 'agentVersion', 'wallet']);
const NO_ENTROPY_KEYS = new Set(['path', 'summary', 'file_path', 'notebook_path', 'pattern', 'glob']);

function walk(v, key, r) {
  if (typeof v === 'string') {
    if (SKIP_KEYS.has(key)) return v;
    return r.text(v, { entropy: !NO_ENTROPY_KEYS.has(key) });
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, r));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, k, r);
    return o;
  }
  return v;
}

/**
 * Relay side: run the same filter over every string of a wire event (`event.data`).
 * Returns a NEW event; `redactor.count` grows by the number of replacements (-> `redServer`).
 * Idempotent on already-redacted text. Never touches seq/t/type/red.
 */
export function redactEvent(event, redactor) {
  if (!event || typeof event !== 'object' || !event.data) return event;
  return { ...event, data: walk(event.data, '', redactor) };
}
