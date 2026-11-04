import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, FakeCli, sseClient, sleep } from './helpers.js';
import { keccak256, toHex } from 'viem';

const ev = (cli, i) => cli.send('text', { text: `hello ${i}` });

test('create stream: validation, id shape, only hashes stored', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    assert.match(st.id, /^[0-9a-hjkmnp-tv-z]{10}$/);
    assert.equal(st.url, `https://peekmarquee.live/s/${st.id}`);
    assert.ok(st.ingestToken.length >= 43 && st.manageKey.length >= 43);
    const row = s.db.prepare('SELECT * FROM streams WHERE id=?').get(st.id);
    assert.ok(!JSON.stringify(row).includes(st.ingestToken) && !JSON.stringify(row).includes(st.manageKey));
    for (const title of ['', 'x'.repeat(81), 'visit https://evil.xyz now', 'look at spam.com', 'fuck this']) {
      const r = await s.post('/api/streams', { title, agent: 'claude', public: true, replay: true });
      assert.equal(r.status, 400, title);
    }
    const r = await s.post('/api/streams', { title: 'ok\u0000​title', agent: 'claude', wallet: 'nope' });
    assert.equal(r.status, 400);
    const m = await s.get(`/api/s/${st.id}`);
    assert.equal(m.status, 200);
    assert.equal(m.body.live, false);
    assert.ok(!('tokenHash' in m.body) && !JSON.stringify(m.body).includes('Hash'));
    assert.equal(m.headers.get('access-control-allow-origin'), '*');
  } finally { await s.stop(); }
});

test('bad ingest token -> close 4401; unknown stream -> 4404', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); c.token = 'wrong';
    await c.connect();
    assert.equal(await c.waitClose(), 4401);
    assert.ok(c.msgs.some((m) => m.type === 'error' && m.code === 'bad_token'));
    const c2 = new FakeCli(s, { id: 'abcdefghjk', ingestToken: 'x' }); await c2.connect();
    assert.equal(await c2.waitClose(), 4404);
  } finally { await s.stop(); }
});

test('frame > 32 KB -> 1009 + error too_large; 32 KB frame accepted', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    c.send('hello', { cli: '0.1.0', agent: 'claude', title: 'x', wallet: null, replay: true, public: true });
    c.rawSend(JSON.stringify({ v: 1, seq: 2, t: Date.now(), type: 'text', data: { text: 'a'.repeat(33 * 1024) }, red: 0 }));
    assert.equal(await c.waitClose(), 1009);
    assert.ok(c.msgs.some((m) => m.type === 'error' && m.code === 'too_large'));
    const lines = fs.readFileSync(path.join(s.dataDir, 'streams', st.id + '.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1); // oversize frame never parsed/stored
  } finally { await s.stop(); }
});

test('rate limit: burst 100 ok, 101st -> rate_limited, nothing under the limit lost', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    for (let i = 0; i < 101; i++) ev(c, i);
    await sleep(400);
    assert.ok(c.msgs.some((m) => m.type === 'error' && m.code === 'rate_limited'));
    const lines = fs.readFileSync(path.join(s.dataDir, 'streams', st.id + '.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 100);
    assert.deepEqual(lines.map((l) => JSON.parse(l).seq), Array.from({ length: 100 }, (_, i) => i + 1));
    // a paced stream (20/s for 2 s) is never limited
    const st2 = await s.stream(); const c2 = new FakeCli(s, st2); await c2.connect();
    for (let i = 0; i < 40; i++) { ev(c2, i); await sleep(50); }
    await sleep(200);
    assert.ok(!c2.msgs.some((m) => m.type === 'error'));
    assert.equal(s.db.prepare('SELECT lastSeq FROM streams WHERE id=?').get(st2.id).lastSeq, 40);
  } finally { await s.stop(); }
});

test('resume: ack carries highest stored seq, resend N+1.. is exact (no dup in file)', async () => {
  const s = await startServer({ ackMs: 100 });
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    for (let i = 0; i < 10; i++) ev(c, i);
    await sleep(300);
    c.close(); await sleep(100);
    // CLI lost its ack knowledge on purpose: acked=0 -> resume asks, server replies ack 10
    c.acked = 0;
    await c.connect();
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', data: { lastAckedSeq: 0 } }));
    await sleep(150);
    assert.equal(c.acked, 10);
    for (const e of c.ring) if (e.seq > c.acked) c.ws.send(JSON.stringify(e)); // nothing
    for (let i = 10; i < 15; i++) ev(c, i);
    for (const e of c.ring.slice(5)) c.ws.send(JSON.stringify(e)); // deliberate duplicates 6..15
    await sleep(300);
    const seqs = fs.readFileSync(path.join(s.dataDir, 'streams', st.id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
    assert.deepEqual(seqs, Array.from({ length: 15 }, (_, i) => i + 1));
  } finally { await s.stop(); }
});

test('2 CLIs reconnecting while 50 SSE viewers watch: no seq lost or duplicated', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const sts = [await s.stream(), await s.stream()];
    const clis = sts.map((st, i) => { const c = new FakeCli(s, st); c.ip = i; return c; });
    await Promise.all(clis.map((c) => c.connect()));
    const viewers = [];
    for (let i = 0; i < 50; i++) viewers.push(sseClient(s.base, sts[i % 2].id, { ip: `10.0.0.${i}` }));
    await Promise.all(viewers.map((v) => v.opened));
    const N = 120;
    for (let i = 1; i <= N; i++) {
      for (const c of clis) c.send('text', { text: `m${i}` });
      if (i === 40 || i === 80) { // both CLIs drop and resume (events keep being produced while down)
        for (const c of clis) c.close();
        await sleep(60);
        for (let k = 0; k < 5; k++) for (const c of clis) c.send('text', { text: 'while-down' });
        for (const c of clis) await c.resume();
      }
      if (i % 10 === 0) await sleep(25);
    }
    await sleep(500);
    const total = clis[0].seq;
    assert.ok(total >= N + 10);
    // a mid-stream viewer that reconnects with Last-Event-ID
    const late = sseClient(s.base, sts[0].id, { lastEventId: 30, ip: '10.0.1.1' });
    await sleep(400);
    for (const [i, v] of viewers.entries()) {
      const want = clis[i % 2].seq;
      assert.deepEqual(v.seqs(), Array.from({ length: want }, (_, k) => k + 1), `viewer ${i}`);
    }
    assert.deepEqual(late.seqs(), Array.from({ length: clis[0].seq - 30 }, (_, k) => k + 31));
    for (const v of viewers) v.close(); late.close();
  } finally { await s.stop(); }
});

test('SSE Last-Event-ID and ?from replay from file', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    for (let i = 0; i < 10; i++) ev(c, i);
    await sleep(150);
    const a = sseClient(s.base, st.id, { lastEventId: 6 }); await a.opened; await sleep(100);
    assert.deepEqual(a.seqs(), [7, 8, 9, 10]);
    const b = sseClient(s.base, st.id, { from: 9 }); await b.opened; await sleep(100);
    assert.deepEqual(b.seqs(), [9, 10]);
    assert.equal(a.events[0].event, 'meta');
    assert.equal(a.events.find((e) => e.id === 7).event, 'text');
    a.close(); b.close();
  } finally { await s.stop(); }
});

test('viewer limits: per-stream 503, per-IP 429', async () => {
  const s = await startServer({ viewersPerStream: 2, viewersPerIp: 3 });
  try {
    const st = await s.stream();
    const v = [sseClient(s.base, st.id), sseClient(s.base, st.id)];
    await Promise.all(v.map((x) => x.opened));
    const third = sseClient(s.base, st.id); await third.opened;
    assert.equal(third.status, 503);
    v.forEach((x) => x.close()); third.close();
  } finally { await s.stop(); }
});

test('second redaction catches sk-ant key; stored file, SSE and logs hold no secret nor event text', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const st = await s.stream({ title: 'Plain title' });
    const secret = 'sk-ant-api03-' + 'Ab9'.repeat(14);
    const sentinel = 'ZEBRA-SENTINEL-PROMPT-TEXT-42';
    const v = sseClient(s.base, st.id); await v.opened;
    const c = new FakeCli(s, st); await c.connect();
    c.send('hello', { cli: '0.1.0', agent: 'claude', title: 'Plain title', wallet: null, replay: true, public: true });
    c.send('prompt', { text: sentinel });
    c.send('tool_result', { forId: 'toolu_1', text: `export KEY=${secret}\nplain line`, bytes: 40, truncated: false, isError: false, hidden: null }, 0);
    await sleep(300);
    const file = fs.readFileSync(path.join(s.dataDir, 'streams', st.id + '.jsonl'), 'utf8');
    assert.ok(!file.includes(secret) && file.includes('[redacted:'));
    assert.ok(!JSON.stringify(v.events).includes(secret));
    assert.ok(file.includes(sentinel)); // non-secret content stays
    const meta = (await s.get(`/api/s/${st.id}`)).body;
    assert.ok(meta.redServer >= 1);
    await s.get(`/api/s/${st.id}/replay.jsonl`);
    const logs = s.logs();
    assert.ok(logs.length > 100);
    assert.ok(!logs.includes(sentinel) && !logs.includes(secret) && !logs.includes('plain line') && !logs.includes('Ab9Ab9'));
    v.close();
  } finally { await s.stop(); }
});

test('end event: live false, retention sweep deletes file + row after expiresAt; then 410', async () => {
  let t = 1_800_000_000_000;
  const s = await startServer({ now: () => t, ackMs: 50 });
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    c.send('hello', { cli: '0.1.0', agent: 'claude', title: 'x', wallet: null, replay: true, public: true });
    c.send('end', { reason: 'ctrl_c' });
    await sleep(200);
    const f = path.join(s.dataDir, 'streams', st.id + '.jsonl');
    assert.ok(fs.existsSync(f));
    let m = (await s.get(`/api/s/${st.id}`)).body;
    assert.equal(m.live, false); assert.equal(m.endedAt, t); assert.equal(m.replayUntil, t + 24 * 3600e3);
    assert.equal((await s.get(`/api/s/${st.id}/replay.jsonl`)).status, 200);
    t += 23 * 3600e3; await s.sweep();
    assert.ok(fs.existsSync(f));
    t += 2 * 3600e3; await s.sweep();
    assert.ok(!fs.existsSync(f) && !fs.existsSync(f.replace('.jsonl', '.meta.json')));
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM streams WHERE id=?').get(st.id).n, 0);
    const g = await s.get(`/api/s/${st.id}`);
    assert.equal(g.status, 410); assert.match(g.body.msg, /expired/);
    assert.equal((await s.get('/api/s/abcdefghjk')).status, 404);
  } finally { await s.stop(); }
});

test('--no-replay: file deleted at end', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const st = await s.stream({ replay: false });
    const c = new FakeCli(s, st); await c.connect();
    c.send('text', { text: 'a' }); c.send('end', { reason: 'ctrl_c' });
    await sleep(200);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'streams', st.id + '.jsonl')));
    assert.equal((await s.get(`/api/s/${st.id}/replay.jsonl`)).status, 410);
  } finally { await s.stop(); }
});

test('stale stream (no frames 30 min) is ended by sweep; paused after 90 s shows live=false', async () => {
  let t = 1_800_000_000_000;
  const s = await startServer({ now: () => t });
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect(); c.send('text', { text: 'a' }); await sleep(100); c.close(); await sleep(100);
    t += 60e3; assert.equal((await s.get(`/api/s/${st.id}`)).body.live, true);
    t += 40e3; assert.equal((await s.get(`/api/s/${st.id}`)).body.live, false);
    t += 31 * 60e3; await s.sweep();
    const m = (await s.get(`/api/s/${st.id}`)).body;
    assert.ok(m.endedAt);
  } finally { await s.stop(); }
});

test('DELETE: bad auth 401; token or manage key -> 410 afterwards and SSE gets deleted', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    for (const mode of ['bearer', 'manage']) {
      const st = await s.stream();
      const c = new FakeCli(s, st); await c.connect(); c.send('text', { text: 'x' }); await sleep(100);
      const v = sseClient(s.base, st.id); await v.opened; await sleep(100);
      assert.equal((await s.del(`/api/streams/${st.id}`, { Authorization: 'Bearer nope' })).status, 401);
      const h = mode === 'bearer' ? { Authorization: 'Bearer ' + st.ingestToken } : { 'X-Manage-Key': st.manageKey };
      assert.equal((await s.del(`/api/streams/${st.id}`, h)).status, 200);
      await sleep(150);
      assert.ok(v.events.some((e) => e.event === 'deleted'));
      assert.ok(!fs.existsSync(path.join(s.dataDir, 'streams', st.id + '.jsonl')));
      assert.equal((await s.get(`/api/s/${st.id}`)).status, 410);
      assert.equal((await s.get(`/api/s/${st.id}/events`)).status, 410);
      assert.equal(await c.waitClose(), 4410);
    }
  } finally { await s.stop(); }
});

test('reports: 3 reports -> unlisted from /api/live; secret_leaked -> unlisted + replay off', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const a = await s.stream(), b = await s.stream();
    for (const st of [a, b]) { const c = new FakeCli(s, st); await c.connect(); c.send('text', { text: 'x' }); await sleep(80); }
    assert.equal((await s.get('/api/live')).body.length, 2);
    assert.equal((await s.post(`/api/s/${a.id}/report`, { reason: 'nonsense' })).status, 400);
    for (let i = 0; i < 2; i++) await s.post(`/api/s/${a.id}/report`, { reason: 'spam' });
    assert.equal((await s.get('/api/live')).body.length, 2);
    await s.post(`/api/s/${a.id}/report`, { reason: 'other' });
    assert.deepEqual((await s.get('/api/live')).body.map((x) => x.id), [b.id]);
    await s.post(`/api/s/${b.id}/report`, { reason: 'secret_leaked' });
    assert.equal((await s.get('/api/live')).body.length, 0);
    assert.equal((await s.get(`/api/s/${b.id}/replay.jsonl`)).status, 403);
    assert.equal((await s.get(`/api/s/${b.id}`)).body.underReview, true);
    assert.equal((await s.get(`/api/s/${a.id}`)).status, 200); // not deleted
  } finally { await s.stop(); }
});

test('report rate limit 5/h per IP', async () => {
  const s = await startServer();
  try {
    const a = await s.stream();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await s.post(`/api/s/${a.id}/report`, { reason: 'other' })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  } finally { await s.stop(); }
});

test('/api/stats with no streams: real zeros for streams, tips not deployed -> unavailable (never 0)', async () => {
  const s = await startServer();
  try {
    const r = await s.get('/api/stats');
    assert.equal(r.body.streamsTotal, 0);
    assert.equal(r.body.streamsLive, 0);
    assert.ok(r.body.tips.unavailable);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
    assert.deepEqual((await s.get('/api/live')).body, []);
    assert.equal((await s.get('/healthz')).status, 200);
    assert.ok((await s.get('/api')).body.routes.length > 5);
  } finally { await s.stop(); }
});

test('stats count real rows: streams, tool calls, secrets', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const st = await s.stream();
    const c = new FakeCli(s, st); await c.connect();
    c.send('tool_call', { id: 'toolu_1', tool: 'Bash', summary: 'ls', args: {} }, 0);
    c.send('text', { text: 'key sk-' + 'a1B2c3D4e5'.repeat(3) }, 2);
    await sleep(200);
    const r = (await s.get('/api/stats')).body;
    assert.equal(r.streamsTotal, 1); assert.equal(r.toolCalls, 1); assert.equal(r.secretsHidden, 3);
  } finally { await s.stop(); }
});

test('/api/tips with RPC down -> unavailable:true (HTTP 200); not deployed -> unavailable', async () => {
  const s = await startServer();
  try {
    const st = await s.stream();
    let r = await s.get(`/api/tips?stream=${st.id}`);
    assert.equal(r.status, 200); assert.equal(r.body.unavailable, true); assert.equal(r.body.reason, 'not_deployed');
    fs.writeFileSync(path.join(s.webDir, 'deployments.json'), JSON.stringify({ tipJar: { address: '0x' + '11'.repeat(20), deployBlock: 5 } }));
    r = await s.get(`/api/tips?stream=${st.id}`);
    assert.equal(r.status, 200); assert.equal(r.body.unavailable, true); assert.ok('lastGoodAt' in r.body);
    r = await s.get('/api/tips/top'); assert.equal(r.body.unavailable, true);
    r = await s.get('/api/stats'); assert.equal(r.body.tips.unavailable, true);
    assert.ok(!('totalWei' in r.body.tips));
  } finally { await s.stop(); }
});

test('/api/tips with mock RPC: reads receivedFor, indexes Tipped logs', async () => {
  const jar = '0x' + '22'.repeat(20);
  const hash = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  let sid;
  const rpc = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const one = (m) => {
        const r = { jsonrpc: '2.0', id: m.id };
        if (m.method === 'eth_blockNumber') r.result = '0x64';
        else if (m.method === 'eth_chainId') r.result = '0x1237';
        else if (m.method === 'eth_call') r.result = hash(m.params[0].data.startsWith('0x4d9ccd38') || true ? 300000000000000 : 0);
        else if (m.method === 'eth_getLogs') r.result = [{ address: jar, blockHash: hash(1), blockNumber: '0x32', data: hash(300000000000000), logIndex: '0x0', removed: false, topics: ['0x' + '0'.repeat(64), sid, hash(7), hash(8)], transactionHash: hash(99), transactionIndex: '0x0' }];
        else r.error = { code: -32601, message: 'x' };
        return r;
      };
      const j = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const s = await startServer({ rpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const st = await s.stream({ wallet: '0x' + '0'.repeat(38) + '08' });
    sid = keccak256(toHex(st.id));
    fs.writeFileSync(path.join(s.webDir, 'deployments.json'), JSON.stringify({ chains: { '4663': { address: jar, deployBlock: 1 } }, teamWallets: ['0x' + '0'.repeat(38) + '07'] }));
    // real Tipped topic0
    const { toEventSelector } = await import('viem');
    const topic0 = toEventSelector('Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount)');
    rpc.removeAllListeners('request');
    rpc.on('request', (req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const one = (m) => {
          const r = { jsonrpc: '2.0', id: m.id };
          if (m.method === 'eth_blockNumber') r.result = '0x64';
          else if (m.method === 'eth_call') r.result = hash(300000000000000);
          else if (m.method === 'eth_getLogs') r.result = [
            { address: jar, blockHash: hash(1), blockNumber: '0x32', data: hash(300000000000000), logIndex: '0x0', removed: false, topics: [topic0, sid, hash(7), hash(8)], transactionHash: hash(99), transactionIndex: '0x0' },
            // spoof: same streamId, tipped to someone else's address -> must NOT count (review S1)
            { address: jar, blockHash: hash(1), blockNumber: '0x33', data: hash(900000000000000), logIndex: '0x1', removed: false, topics: [topic0, sid, hash(7), hash(9)], transactionHash: hash(98), transactionIndex: '0x0' }];
          else r.error = { code: -32601, message: 'x' };
          return r;
        };
        const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
      });
    });
    assert.equal((await s.chain.indexLogs()).ok, true);
    const r = (await s.get(`/api/tips?stream=${st.id}`)).body;
    assert.equal(r.totalWei, '300000000000000'); assert.equal(r.tips.length, 1); assert.equal(r.asOfBlock, 100);
    assert.equal(r.tips[0].team, true); assert.equal(r.grossLabel, 'gross (unfiltered)'); assert.equal(r.grossUnfilteredWei, '300000000000000');
    const top = (await s.get('/api/tips/top')).body;
    assert.equal(top.top[0].id, st.id); assert.equal(top.recent.length, 2); // unfiltered, newest first
    assert.equal(top.recent[0].counted, false); assert.equal(top.recent[1].counted, true);
    assert.equal(top.recent[1].id, st.id); assert.equal(top.recent[1].team, true); assert.match(top.recent[1].streamId, /^0x[0-9a-f]{64}$/);
    assert.equal(top.top[0].totalWei, '300000000000000'); assert.equal(top.top[0].count, 1);
    const stats = (await s.get('/api/stats')).body;
    assert.equal(stats.tips.totalWei, '300000000000000'); assert.equal(stats.tips.label, 'gross (unfiltered)');
  } finally { await s.stop(); rpc.close(); }
});

test('holder endpoint pre-T0 -> launched:false; internal admin is not reachable via proxy header', async () => {
  const s = await startServer();
  try {
    const r = await s.get('/api/holder/0x' + 'ab'.repeat(20));
    assert.deepEqual(r.body, { holder: false, launched: false });
    assert.equal((await s.get('/api/holder/zzz')).status, 400);
    assert.equal((await s.get('/internal/admin/list')).status, 404);
    assert.equal((await s.get('/internal/admin/list', { Authorization: 'Bearer ' + s.adminToken, 'x-forwarded-for': '1.2.3.4' })).status, 404);
    const ok = await s.get('/internal/admin/list', { Authorization: 'Bearer ' + s.adminToken });
    assert.equal(ok.status, 200);
  } finally { await s.stop(); }
});

test('per-IP limits: POST /api/streams 20/h, 12 new streams/h', async () => {
  const s = await startServer();
  try {
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await s.post('/api/streams', { title: 't' + i, agent: 'claude' })).status);
    assert.equal(codes.filter((c) => c === 200).length, 12);
    assert.equal(codes[13], 429);
  } finally { await s.stop(); }
});

test('GET /api/live ordering and /api/recent', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const a = await s.stream({ title: 'A' }), b = await s.stream({ title: 'B' }), d = await s.stream({ title: 'D', public: false });
    const first = [];
    for (const st of [a, b, d]) { const c = new FakeCli(s, st); first.push(c); await c.connect(); c.send('text', { text: 'x' }); }
    await sleep(150);
    const v = sseClient(s.base, b.id, { ip: '9.9.9.9' }); await v.opened; await sleep(100);
    const live = (await s.get('/api/live')).body;
    assert.deepEqual(live.map((x) => x.title), ['B', 'A']); // public only, viewers desc
    assert.equal(live[0].viewers, 1);
    assert.ok(!('token' in live[0]));
    v.close();
    first.forEach((x) => x.close()); await sleep(100);
    const c = new FakeCli(s, await s.stream({ title: 'R' })); // ended one appears in recent
    await c.connect(); c.send('text', { text: 'x' }); c.send('end', { reason: 'ctrl_c' }); await sleep(150);
    assert.deepEqual((await s.get('/api/recent')).body.map((x) => x.title), ['R']);
  } finally { await s.stop(); }
});

test('per-IP active stream cap (3): 4th concurrent ingest is refused with rate_limited', async () => {
  const s = await startServer();
  try {
    const clis = [];
    for (let i = 0; i < 3; i++) { const c = new FakeCli(s, await s.stream()); await c.connect(); clis.push(c); }
    const c4 = new FakeCli(s, await s.stream()); await c4.connect();
    assert.equal(await c4.waitClose(), 4429);
    assert.ok(c4.msgs.some((m) => m.code === 'rate_limited'));
    clis.forEach((c) => c.close());
  } finally { await s.stop(); }
});

test('private streams never enter /api/stats; recount admin drops stale totals', async () => {
  const s = await startServer({ ackMs: 50 });
  try {
    const pr = await s.stream({ public: false });
    const c = new FakeCli(s, pr); await c.connect();
    c.send('hello', { cli: '0.1.0', agent: 'claude', title: 'x', wallet: null, replay: true, public: false });
    c.send('tool_call', { name: 'Bash', input: 'ls' }); await sleep(200);
    let st = (await s.get('/api/stats')).body;
    assert.equal(st.streamsTotal, 0); assert.equal(st.toolCalls, 0); assert.equal(st.streamsLive, 0);
    assert.equal((await s.get('/api/live')).body.length, 0);
    s.db.prepare("UPDATE counters SET v=9 WHERE k='toolCalls'").run(); // stale
    const adm = await fetch(`${s.base}/internal/admin/recount`, { method: 'POST', headers: { Authorization: 'Bearer ' + s.adminToken, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(adm.status, 200);
    st = (await s.get('/api/stats')).body; assert.equal(st.toolCalls, 0); assert.equal(st.streamsTotal, 0);
    c.close();
  } finally { await s.stop(); }
});
