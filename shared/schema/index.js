// PEEKMARQUEE wire schema v1. No dependencies. Shared by CLI (producer) and relay (validator).

export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  FRAME_MAX_BYTES: 32 * 1024,     // relay closes with 1009 above this
  FRAME_TARGET_BYTES: 8 * 1024,   // CLI re-truncates to this after a too_large
  TITLE_MAX: 80,
  PROMPT_MAX_BYTES: 2 * 1024,
  TEXT_MAX_BYTES: 4 * 1024,
  RESULT_MAX_BYTES: 4 * 1024,
  SNIPPET_MAX_BYTES: 2 * 1024,
  SUMMARY_BASH_MAX: 300,
  ARG_VALUE_MAX_BYTES: 1024,
  ARGS_TOTAL_MAX_BYTES: 4 * 1024,
  RING_BUFFER_EVENTS: 2000,
});

export const EVENT_TYPES = Object.freeze(['hello', 'status', 'prompt', 'text', 'tool_call', 'tool_result', 'edit', 'end']);
export const STATES = Object.freeze(['thinking', 'tool', 'idle', 'resumed', 'ended']);
export const HIDDEN = Object.freeze(['sensitive_path', 'env_dump', 'binary']);
export const END_REASONS = Object.freeze(['ctrl_c', 'session_ended', 'error']);
export const SERVER_ERROR_CODES = Object.freeze(['rate_limited', 'too_large', 'bad_token', 'stream_closed']);
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v) && v >= 0;

/** Build a CLI -> relay event envelope. `red` is omitted for hello and end. */
export function makeEvent(seq, type, data, red, t = Date.now()) {
  const ev = { v: PROTOCOL_VERSION, seq, t, type, data };
  if (red !== undefined && type !== 'hello' && type !== 'end') ev.red = red;
  return ev;
}

/** Message the CLI sends on reconnect, before any other event. Has no seq. */
export function makeResume(lastAckedSeq) {
  return { v: PROTOCOL_VERSION, type: 'resume', data: { lastAckedSeq } };
}

const DATA_CHECKS = {
  hello: (d) => isStr(d.cli) && isStr(d.agent) && isStr(d.title) && d.title.length <= LIMITS.TITLE_MAX
    && (d.wallet === null || (isStr(d.wallet) && WALLET_RE.test(d.wallet)))
    && typeof d.replay === 'boolean' && typeof d.public === 'boolean'
    && (d.agentVersion === undefined || isStr(d.agentVersion)),
  status: (d) => STATES.includes(d.state),
  prompt: (d) => isStr(d.text),
  text: (d) => isStr(d.text),
  tool_call: (d) => isStr(d.id) && isStr(d.tool) && isStr(d.summary) && isObj(d.args),
  tool_result: (d) => isStr(d.forId) && isStr(d.text) && isInt(d.bytes) && typeof d.truncated === 'boolean'
    && typeof d.isError === 'boolean' && (d.hidden === null || d.hidden === undefined || HIDDEN.includes(d.hidden)),
  edit: (d) => isStr(d.path) && isInt(d.added) && isInt(d.removed) && isStr(d.snippet),
  end: (d) => END_REASONS.includes(d.reason),
};

/**
 * Validate a parsed CLI -> relay message. Returns { ok:true, kind:'event'|'resume' } or { ok:false, error }.
 * Unknown extra fields are tolerated (forward compatible); unknown types are rejected.
 */
export function validateClientMessage(m) {
  if (!isObj(m)) return { ok: false, error: 'not_object' };
  if (m.v !== PROTOCOL_VERSION) return { ok: false, error: 'bad_version' };
  if (!isObj(m.data)) return { ok: false, error: 'bad_data' };
  if (m.type === 'resume') {
    return isInt(m.data.lastAckedSeq) ? { ok: true, kind: 'resume' } : { ok: false, error: 'bad_resume' };
  }
  if (!EVENT_TYPES.includes(m.type)) return { ok: false, error: 'bad_type' };
  if (!isInt(m.seq) || m.seq < 1) return { ok: false, error: 'bad_seq' };
  if (!isInt(m.t)) return { ok: false, error: 'bad_t' };
  if (m.red !== undefined && !isInt(m.red)) return { ok: false, error: 'bad_red' };
  if (!DATA_CHECKS[m.type](m.data)) return { ok: false, error: `bad_${m.type}` };
  return { ok: true, kind: 'event' };
}

/** CLI side: the only relay -> CLI messages are ack / viewers / error. Everything else returns null (ignored). */
export function parseServerMessage(raw) {
  let m;
  try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return null; }
  if (!isObj(m)) return null;
  if (m.type === 'ack' && isInt(m.seq)) return { type: 'ack', seq: m.seq };
  if (m.type === 'viewers' && isInt(m.n)) return { type: 'viewers', n: m.n };
  if (m.type === 'error' && isStr(m.code)) return { type: 'error', code: m.code, msg: isStr(m.msg) ? m.msg.slice(0, 200) : '' };
  return null;
}

/** Relay side helpers to build the messages the CLI understands. */
export const serverMsg = Object.freeze({
  ack: (seq) => JSON.stringify({ type: 'ack', seq }),
  viewers: (n) => JSON.stringify({ type: 'viewers', n }),
  error: (code, msg) => JSON.stringify({ type: 'error', code, msg }),
});
