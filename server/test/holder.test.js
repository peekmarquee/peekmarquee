import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startServer, FakeCli, sleep } from './helpers.js';

function mockRpc(balance) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const one = (m) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_call' ? '0x' + BigInt(balance.v).toString(16).padStart(64, '0') : '0x1' });
      const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('holder claim (post-T0): signature + balance -> 30 d expiry and Featured; pre-launch refused', async () => {
  const bal = { v: 5_000n };
  const rpc = await mockRpc(bal);
  let t = 1_800_000_000_000;
  const s = await startServer({ rpcUrl: `http://127.0.0.1:${rpc.address().port}`, now: () => t, ackMs: 50 });
  try {
    const acct = privateKeyToAccount(generatePrivateKey());
    const st = await s.stream({ wallet: acct.address });
    const c = new FakeCli(s, st); await c.connect(); c.send('text', { text: 'x' }); await sleep(100);
    const mk = { 'X-Manage-Key': st.manageKey };
    assert.equal((await s.post(`/api/s/${st.id}/claim`, { sig: '0x00' }, mk)).status, 409); // not launched
    fs.writeFileSync(path.join(s.webDir, 'token.json'), JSON.stringify({ address: '0x' + '33'.repeat(20), symbol: 'MARQ', launched: true, holderThreshold: '1000' }));
    await sleep(20);
    assert.equal((await s.post(`/api/s/${st.id}/nonce`, {}, { 'X-Manage-Key': 'bad' })).status, 401);
    const n = (await s.post(`/api/s/${st.id}/nonce`, {}, mk)).body;
    assert.equal(n.message, `PEEKMARQUEE holder check\nstream:${st.id}\nnonce:${n.nonce}`);
    const sig = await acct.signMessage({ message: n.message });
    const bad = await s.post(`/api/s/${st.id}/claim`, { sig: await privateKeyToAccount(generatePrivateKey()).signMessage({ message: n.message }) }, mk);
    assert.equal(bad.status, 401);
    const ok = await s.post(`/api/s/${st.id}/claim`, { sig }, mk);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await s.get(`/api/s/${st.id}`)).body.holder, true);
    assert.equal((await s.get('/api/live')).body[0].featured, true);
    assert.deepEqual((await s.get(`/api/holder/${acct.address}`)).body, { holder: true, threshold: '1000', balance: '5000' });
    c.send('end', { reason: 'ctrl_c' }); await sleep(150);
    assert.equal((await s.get(`/api/s/${st.id}`)).body.replayUntil, t + 30 * 24 * 3600e3);
  } finally { await s.stop(); rpc.close(); }
});

test('holder claim with RPC down -> 503 "try again", not a silent failure', async () => {
  const bal = { v: 5_000n };
  const rpc = await mockRpc(bal);
  const s = await startServer({ rpcUrl: `http://127.0.0.1:${rpc.address().port}`, ackMs: 50 });
  try {
    const acct = privateKeyToAccount(generatePrivateKey());
    const st = await s.stream({ wallet: acct.address });
    fs.writeFileSync(path.join(s.webDir, 'token.json'), JSON.stringify({ address: '0x' + '33'.repeat(20), launched: true, holderThreshold: '1' }));
    const mk = { 'X-Manage-Key': st.manageKey };
    const n = (await s.post(`/api/s/${st.id}/nonce`, {}, mk)).body;
    rpc.close(); rpc.closeAllConnections();
    const r = await s.post(`/api/s/${st.id}/claim`, { sig: await acct.signMessage({ message: n.message }) }, mk);
    assert.equal(r.status, 503); assert.equal(r.body.unavailable, true);
    assert.equal((await s.get(`/api/holder/${acct.address}`)).body.unavailable, true);
  } finally { await s.stop(); }
});

test('perf: /api/stats and /api/live answer in <=50 ms with 50 viewers connected', async () => {
  const { sseClient } = await import('./helpers.js');
  const s = await startServer({ ackMs: 50 });
  try {
    const st = await s.stream(); const c = new FakeCli(s, st); await c.connect(); c.send('text', { text: 'x' });
    const vs = []; for (let i = 0; i < 50; i++) vs.push(sseClient(s.base, st.id, { ip: '10.1.0.' + i }));
    await Promise.all(vs.map((v) => v.opened));
    for (const p of ['/api/stats', '/api/live', '/api/stats', '/api/live']) {
      const t0 = performance.now(); await s.get(p); const dt = performance.now() - t0;
      assert.ok(dt <= 50, `${p} took ${dt}`);
    }
    vs.forEach((v) => v.close());
  } finally { await s.stop(); }
});
