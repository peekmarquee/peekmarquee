import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { main } from '../src/run.js';
import { RelayClient } from '../src/relay.js';
import { makeWorld, until, sleep, tmp } from './helpers/env.mjs';
import { buildLines } from './helpers/fixture.mjs';
import { validateClientMessage, serverMsg, makeEvent } from '../src/shared/schema/index.js';
import { readStreams } from '../src/store.js';

// A tiny stand-in for the real relay (SERVER agent builds that one).
async function fakeRelay({ dropAfter = 0, badTitle = false } = {}) {
  const state = { created: [], frames: [], seqs: [], conns: 0, auth: [], deleted: [], resumes: [], titleTries: 0, dropped: false };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/streams') {
        const j = JSON.parse(body); state.created.push(j);
        if (badTitle && /bad/.test(j.title)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"title not allowed"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'k7m2q4pz9d', ingestToken: 'tok-123', manageKey: 'mk-1', url: `http://127.0.0.1:${srv.address().port}/s/k7m2q4pz9d` }));
      }
      if (req.method === 'DELETE' && req.url === '/api/streams/k7m2q4pz9d') { state.deleted.push(req.headers.authorization); res.writeHead(200); return res.end('{}'); }
      res.writeHead(404); res.end();
    });
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws, req) => {
    state.conns++; state.auth.push(req.headers.authorization);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'resume') { state.resumes.push(m.data.lastAckedSeq); ws.send(serverMsg.ack(Math.max(0, ...state.seqs))); return; }
      assert.deepEqual(validateClientMessage(m).ok, true, JSON.stringify(m).slice(0, 100));
      state.frames.push(m); state.seqs.push(m.seq);
      if (dropAfter && !state.dropped && state.frames.length === dropAfter) { state.dropped = true; ws.terminate(); return; }
      ws.send(serverMsg.ack(m.seq));
      if (state.seqs.length === 3) ws.send(serverMsg.viewers(7));
      ws.send(JSON.stringify({ type: 'exec', cmd: 'touch /tmp/pwned' })); // must be ignored
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, port: srv.address().port, close: () => { wss.close(); srv.close(); } };
}

function depsFor(w, port, ac, extra = {}) {
  const out = []; const err = [];
  return { deps: { cwd: w.cwd, home: w.home, env: { PEEKMARQUEE_RELAY: `ws://127.0.0.1:${port}`, XDG_CONFIG_HOME: path.join(w.home, '.config') }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s), isTTY: false }, signal: ac.signal, ...extra }, out, err };
}

test('full run against a relay: link printed, events contiguous, end sent, token saved 0600, wallet/flags in create call', async () => {
  const relay = await fakeRelay();
  const w = makeWorld({ lines: buildLines({ cwd: '/x', home: '/h' }).slice(0, 4) });
  fs.writeFileSync(w.file, `${buildLines({ cwd: w.cwd, home: w.home }).slice(0, 6).join('\n')}\n`);
  const ac = new AbortController();
  const { deps, out, err } = depsFor(w, relay.port, ac);
  process.env.XDG_CONFIG_HOME = deps.env.XDG_CONFIG_HOME; // store reads process.env at call time
  const run = main(['--title', 'My title', '--private', '--no-replay', '--wallet', '0x806a315f23C241692e16fcC563Ff67b4E11BEf73'], deps);
  run.catch((e) => console.error('MAIN ERR', e));
  await until(() => out.join('').includes('Streaming'), 3000).catch((e) => { console.error('OUT', out, 'ERR', err, relay.state); throw e; });
  assert.match(out.join(''), /http:\/\/127\.0\.0\.1:\d+\/s\/k7m2q4pz9d/);
  assert.deepEqual(relay.state.created[0], { title: 'My title', agent: 'claude', wallet: '0x806a315f23C241692e16fcC563Ff67b4E11BEf73', public: false, replay: false });
  await until(() => relay.state.frames.length >= 1).catch((e) => { console.error('STATE', relay.state, err.join('')); throw e; });
  fs.appendFileSync(w.file, `${buildLines({ cwd: w.cwd, home: w.home }).slice(6, 16).join('\n')}\n`);
  await until(() => relay.state.frames.length >= 8, 5000);
  ac.abort();
  assert.equal(await run, 0);
  const seqs = relay.state.seqs;
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal(relay.state.frames[0].type, 'hello');
  assert.equal(relay.state.frames[0].data.wallet, '0x806a315f23C241692e16fcC563Ff67b4E11BEf73');
  assert.equal(relay.state.frames.at(-1).type, 'end');
  assert.equal(relay.state.auth[0], 'Bearer tok-123');
  assert.match(err.join(''), /Stopped\./);
  assert.ok(!err.join('').includes('Replay'), 'no replay link with --no-replay');
  const f = path.join(w.home, '.config', 'peekmarquee', 'streams.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(readStreams(f).k7m2q4pz9d.token, 'tok-123');
  // delete command uses the saved token
  const o2 = []; 
  const code = await main(['delete', 'k7m2q4pz9d'], { ...deps, stdout: { write: (s) => o2.push(s) }, signal: undefined });
  assert.equal(code, 0);
  assert.deepEqual(relay.state.deleted, ['Bearer tok-123']);
  relay.close();
});

test('reconnect: connection dropped mid-stream -> resume, no seq lost or duplicated', async () => {
  const relay = await fakeRelay({ dropAfter: 3 });
  const w = makeWorld();
  fs.writeFileSync(w.file, `${buildLines({ cwd: w.cwd, home: w.home }).slice(0, 6).join('\n')}\n`);
  const ac = new AbortController();
  const { deps, out } = depsFor(w, relay.port, ac);
  // shorten backoff via a client-level test below; here wait for the real 1 s backoff
  const run = main([], deps);
  await until(() => out.join('').includes('Streaming'), 5000);
  const lines = buildLines({ cwd: w.cwd, home: w.home }).slice(3, 30);
  for (const l of lines) { fs.appendFileSync(w.file, `${l}\n`); await sleep(15); }
  await until(() => relay.state.conns >= 2 && relay.state.seqs.length >= 20, 12000);
  ac.abort();
  await run;
  assert.ok(relay.state.resumes.length >= 1);
  const uniq = [...new Set(relay.state.seqs)];
  assert.deepEqual(uniq, uniq.map((_, i) => i + 1), 'contiguous');
  assert.equal(uniq.length, relay.state.seqs.length, 'no duplicates');
  relay.close();
});

test('RelayClient: ring buffer resend from server ack after reconnect (mock socket)', async () => {
  const sockets = [];
  class Mock {
    constructor() { this.readyState = 0; this.sent = []; this.h = {}; sockets.push(this); setTimeout(() => { this.readyState = 1; this.h.open?.(); }, 1); }
    on(e, f) { this.h[e] = f; } send(s) { this.sent.push(JSON.parse(s)); } ping() {} close() { this.h.close?.(1000); } terminate() { this.readyState = 3; this.h.close?.(1006); }
  }
  const c = new RelayClient({ wsUrl: 'ws://x', token: 't', WebSocketImpl: Mock, backoffMs: [5], resyncTimeoutMs: 100 });
  c.start();
  await sleep(10);
  for (let i = 1; i <= 5; i++) c.send(makeEvent(i, 'text', { text: `e${i}` }, 0));
  assert.deepEqual(sockets[0].sent.map((m) => m.seq), [1, 2, 3, 4, 5]);
  sockets[0].h.message(JSON.stringify({ type: 'ack', seq: 2 }));
  sockets[0].terminate();
  await sleep(30);
  const s1 = sockets[1];
  assert.equal(s1.sent[0].type, 'resume');
  assert.equal(s1.sent[0].data.lastAckedSeq, 2);
  s1.h.message(JSON.stringify({ type: 'ack', seq: 3 })); // server only stored up to 3
  assert.deepEqual(s1.sent.slice(1).map((m) => m.seq), [4, 5]);
  c.send(makeEvent(6, 'text', { text: 'e6' }, 0));
  assert.equal(s1.sent.at(-1).seq, 6);
  // only ack/viewers/error are understood; garbage is ignored
  s1.h.message(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' }));
  await c.finish(50);
});

test('RelayClient: too_large shrinks buffered frames; bad_token is fatal', async () => {
  const sockets = [];
  class Mock {
    constructor() { this.readyState = 0; this.sent = []; this.h = {}; sockets.push(this); setTimeout(() => { this.readyState = 1; this.h.open?.(); }, 1); }
    on(e, f) { this.h[e] = f; } send(s) { this.sent.push(s); } ping() {} close() {} terminate() { this.h.close?.(1006); }
  }
  const c = new RelayClient({ wsUrl: 'ws://x', token: 't', WebSocketImpl: Mock, backoffMs: [5] });
  let fatal = null; c.on('fatal', (e) => { fatal = e; });
  c.start(); await sleep(10);
  c.send(makeEvent(1, 'text', { text: 'é'.repeat(15000) }, 0));
  sockets[0].h.message(JSON.stringify({ type: 'error', code: 'too_large', msg: '' }));
  assert.ok(Buffer.byteLength(c.ring[0].json) <= 8192);
  sockets[0].h.message(JSON.stringify({ type: 'error', code: 'bad_token', msg: '' }));
  assert.ok(fatal);
});

test('title rejected with 400 and no TTY -> clear error, exit 1', async () => {
  const relay = await fakeRelay({ badTitle: true });
  const w = makeWorld();
  fs.writeFileSync(w.file, `${buildLines({ cwd: w.cwd, home: w.home }).slice(0, 6).join('\n')}\n`);
  const { deps, err } = depsFor(w, relay.port, new AbortController());
  const code = await main(['--title', 'bad title'], deps);
  assert.equal(code, 1);
  assert.match(err.join(''), /Could not create the stream/);
  relay.close();
});

test('delete without saved token explains itself', async () => {
  const w = makeWorld();
  const { deps, err } = depsFor(w, 1, new AbortController(), { signal: undefined });
  process.env.XDG_CONFIG_HOME = tmp('pm-xdg-');
  assert.equal(await main(['delete', 'nope'], deps), 1);
  assert.match(err.join(''), /No saved token/);
});
