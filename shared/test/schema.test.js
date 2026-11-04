import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, makeResume, validateClientMessage, parseServerMessage, serverMsg, LIMITS } from '../schema/index.js';

const hello = { cli: '0.1.0', agent: 'claude', title: 'x', wallet: null, replay: true, public: true };

test('valid events of every type', () => {
  const evs = [
    makeEvent(1, 'hello', hello),
    makeEvent(2, 'status', { state: 'thinking' }, 0),
    makeEvent(3, 'prompt', { text: 'hi' }, 0),
    makeEvent(4, 'text', { text: 'hi' }, 0),
    makeEvent(5, 'tool_call', { id: 'toolu_1', tool: 'Bash', summary: 'ls', args: {} }, 0),
    makeEvent(6, 'tool_result', { forId: 'toolu_1', text: 'x', bytes: 1, truncated: false, isError: false, hidden: null }, 3),
    makeEvent(7, 'edit', { path: 'a.ts', added: 1, removed: 0, snippet: '+x' }, 3),
    makeEvent(8, 'end', { reason: 'ctrl_c' }),
  ];
  for (const e of evs) assert.deepEqual(validateClientMessage(e), { ok: true, kind: 'event' }, e.type);
  assert.equal(evs[0].red, undefined);
  assert.equal(evs[7].red, undefined);
});

test('resume and rejects', () => {
  assert.deepEqual(validateClientMessage(makeResume(120)), { ok: true, kind: 'resume' });
  assert.equal(validateClientMessage({ ...makeEvent(1, 'status', { state: 'nope' }, 0) }).ok, false);
  assert.equal(validateClientMessage({ ...makeEvent(0, 'text', { text: 'x' }, 0) }).ok, false);
  assert.equal(validateClientMessage({ v: 2, type: 'text' }).ok, false);
  assert.equal(validateClientMessage(makeEvent(1, 'hello', { ...hello, wallet: '0x12' })).ok, false);
  assert.equal(validateClientMessage(makeEvent(1, 'weird', {}, 0)).ok, false);
  assert.equal(validateClientMessage(null).ok, false);
});

test('CLI only understands ack/viewers/error', () => {
  assert.deepEqual(parseServerMessage(serverMsg.ack(5)), { type: 'ack', seq: 5 });
  assert.deepEqual(parseServerMessage(serverMsg.viewers(3)), { type: 'viewers', n: 3 });
  assert.equal(parseServerMessage(serverMsg.error('rate_limited', 'slow')).code, 'rate_limited');
  assert.equal(parseServerMessage('{"type":"exec","cmd":"rm -rf /"}'), null);
  assert.equal(parseServerMessage('not json'), null);
  assert.equal(LIMITS.FRAME_MAX_BYTES, 32768);
});
