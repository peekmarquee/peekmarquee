import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, isValidWallet, toChecksum } from '../src/wallet.js';
import { parseArgs } from '../src/args.js';
import { fitEvent } from '../src/events.js';
import { relayBases } from '../src/relay.js';
import { tmp } from './helpers/env.mjs';
import { saveStream, readStreams, removeStream } from '../src/store.js';

test('keccak256 test vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256('a'.repeat(200)).length, 64);
});

test('wallet validation: EIP-55 vectors, lowercase ok, bad mixed case rejected', () => {
  const good = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'];
  for (const a of good) { assert.ok(isValidWallet(a), a); assert.ok(isValidWallet(a.toLowerCase().replace('0x', '0x')), 'lower'); }
  assert.ok(isValidWallet('0x806a315f23C241692e16fcC563Ff67b4E11BEf73'));
  assert.equal(toChecksum('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), good[0]);
  assert.ok(!isValidWallet('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')); // one case flipped
  assert.ok(!isValidWallet('0x1234'));
  assert.ok(!isValidWallet('nope'));
});

test('args', () => {
  const a = parseArgs(['--title', 'My run', '--hide', 'a*', '--hide=/b/', '--private', '--no-replay', '--no-prompts', '--dry-run', '--wallet', '0xabc', '--file', 'x.jsonl']);
  assert.deepEqual([a.title, a.hide, a.private, a.noReplay, a.noPrompts, a.dryRun, a.file], ['My run', ['a*', '/b/'], true, true, true, true, 'x.jsonl']);
  assert.equal(parseArgs(['delete', 'abc123']).id, 'abc123');
  assert.equal(parseArgs(['delete', 'abc123']).command, 'delete');
  assert.ok(parseArgs(['--bogus']).errors.length);
  assert.ok(parseArgs(['--title']).errors.length);
});

test('fitEvent shrinks to the target without breaking JSON', () => {
  const ev = { v: 1, seq: 1, t: 1, type: 'tool_result', data: { forId: 'a', text: 'é'.repeat(20000), bytes: 40000, truncated: false, isError: false, hidden: null }, red: 0 };
  fitEvent(ev, 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(ev)) <= 8192);
  assert.equal(ev.data.truncated, true);
  assert.equal(ev.data.forId, 'a');
});

test('relay URL derivation', () => {
  assert.deepEqual(relayBases('wss://peekmarquee.live'), { ws: 'wss://peekmarquee.live', http: 'https://peekmarquee.live' });
  assert.deepEqual(relayBases('ws://127.0.0.1:4840/'), { ws: 'ws://127.0.0.1:4840', http: 'http://127.0.0.1:4840' });
  assert.deepEqual(relayBases('http://127.0.0.1:4840/ingest'), { ws: 'ws://127.0.0.1:4840', http: 'http://127.0.0.1:4840' });
});

test('stream store is mode 0600 inside a 0700 dir', () => {
  const f = path.join(tmp('pm-store-'), 'sub', 'streams.json');
  saveStream('abc', { token: 't' }, f);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.equal(readStreams(f).abc.token, 't');
  removeStream('abc', f);
  assert.deepEqual(readStreams(f), {});
});

test('src/shared is an exact copy of ../shared (run npm run sync-shared)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const shared = path.join(root, '..', 'shared');
  if (!fs.existsSync(shared)) return; // inside the published tarball
  for (const d of ['redact', 'schema']) {
    for (const f of fs.readdirSync(path.join(shared, d))) {
      assert.equal(fs.readFileSync(path.join(root, 'src', 'shared', d, f), 'utf8'), fs.readFileSync(path.join(shared, d, f), 'utf8'), `${d}/${f}`);
    }
  }
});
