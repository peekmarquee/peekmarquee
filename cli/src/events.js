import { LIMITS } from './shared/schema/index.js';

const bytes = (o) => Buffer.byteLength(JSON.stringify(o));

function longestString(node, hold) {
  if (typeof node === 'string') return { parent: null, key: null, len: node.length };
  let best = { parent: null, key: null, len: 0 };
  const visit = (parent, key, v) => {
    if (typeof v === 'string') { if (v.length > best.len) best = { parent, key, len: v.length }; }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) visit(v, k, v[k]);
  };
  visit(hold, 'data', node);
  return best;
}

/** Shrink an event in place (strings halved, longest first) until its JSON is <= maxBytes. Returns the event. */
export function fitEvent(ev, maxBytes = LIMITS.FRAME_TARGET_BYTES) {
  for (let i = 0; i < 60 && bytes(ev) > maxBytes; i++) {
    const hold = { data: ev.data };
    const b = longestString(ev.data, hold);
    if (!b.parent || b.len <= 8) break;
    b.parent[b.key] = b.parent[b.key].slice(0, Math.floor(b.len / 2));
    if (b.parent === hold) ev.data = hold.data;
    if ('truncated' in ev.data) ev.data.truncated = true;
  }
  return ev;
}
