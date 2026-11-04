import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { keccak256, toHex, toEventSelector, encodeAbiParameters } from 'viem';
import { startServer, sseClient, sleep } from './helpers.js';

const w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addrTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const MARQ = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);
const V2 = '0x' + '22'.repeat(20), V1 = '0x' + '11'.repeat(20);
const WALLET = '0x' + '0'.repeat(38) + '08', FROM = '0x806a315f23C241692e16fcC563Ff67b4E11BEf73';
const T_TIPPED = toEventSelector('Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount)');
const T_TOKEN = toEventSelector('TippedToken(bytes32 indexed streamId, address indexed from, address indexed streamer, address token, uint256 amount)');

const byAmtNoDust = (top, a) => top.recent.find((x) => x.amount === a);
test('token tips: v2 TippedToken + v1 retired Tipped indexed; per-token totals, S1, team, counted:false, chat system message', async () => {
  let sid; const queried = [];
  const logTok = (blk, idx, tx, streamer, token, amount, jar = V2) => ({ address: jar, blockHash: w(1), blockNumber: '0x' + blk.toString(16), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, amount]), logIndex: '0x' + idx.toString(16), removed: false, topics: [T_TOKEN, sid, addrTopic(FROM), addrTopic(streamer)], transactionHash: w(tx), transactionIndex: '0x0' });
  const logEth = (blk, idx, tx, streamer, amount, jar) => ({ address: jar, blockHash: w(1), blockNumber: '0x' + blk.toString(16), data: w(amount), logIndex: '0x' + idx.toString(16), removed: false, topics: [T_TIPPED, sid, addrTopic(FROM), addrTopic(streamer)], transactionHash: w(tx), transactionIndex: '0x0' });
  const rpc = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const one = (m) => {
        const r = { jsonrpc: '2.0', id: m.id };
        if (m.method === 'eth_blockNumber') r.result = '0x64';
        else if (m.method === 'eth_call') r.result = w(300000000000000);
        else if (m.method === 'eth_getBlockByNumber') r.result = { number: m.params[0], hash: w(1), timestamp: '0x6000', transactions: [] };
        else if (m.method === 'eth_getLogs') {
          const f = m.params[0]; queried.push(f); const a = f.address.toLowerCase();
          if (a === V1) r.result = [logEth(40, 0, 90, WALLET, 100000000000000, V1)];
          else if (a === V2) r.result = [
            logEth(50, 0, 91, WALLET, 200000000000000, V2),
            logTok(51, 0, 92, WALLET, USDG, 5000000n),
            logTok(52, 0, 93, WALLET, MARQ, 7n * 10n ** 18n),
            logTok(53, 0, 94, WALLET, OTHER, 999n),                  // unknown token: recent only, counted:false
            logTok(55, 0, 96, WALLET, USDG, 99999n), logTok(56, 0, 97, WALLET, MARQ, 10n ** 18n - 1n), logEth(57, 0, 98, WALLET, 9999999999999, V2), // dust
            logTok(54, 0, 95, '0x' + '0'.repeat(38) + '09', USDG, 8000000n), // spoof streamer: not counted
          ];
          else r.result = [];
        } else r.error = { code: -32601, message: 'x' };
        return r;
      };
      const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const s = await startServer({ rpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    fs.writeFileSync(path.join(s.webDir, 'token.json'), JSON.stringify({ address: MARQ, symbol: 'MARQ', launched: true }));
    const st = await s.stream({ wallet: WALLET });
    sid = keccak256(toHex(st.id));
    fs.writeFileSync(path.join(s.webDir, 'deployments.json'), JSON.stringify({ chains: { '4663': { address: V2, deployBlock: 30, retired: [{ address: V1, deployBlock: 20 }] } }, teamWallets: [FROM] }));
    const v = sseClient(s.base, st.id); await v.opened;
    assert.equal((await s.chain.indexLogs()).ok, true);
    // v1 queried for Tipped only, v2 for both events
    assert.ok(queried.some((f) => f.address.toLowerCase() === V1 && JSON.stringify(f.topics) === JSON.stringify([[T_TIPPED]])));
    assert.ok(queried.some((f) => f.address.toLowerCase() === V2 && f.topics[0].length === 2));
    const r = (await s.get(`/api/tips?stream=${st.id}`)).body;
    assert.equal(r.totals.ETH.amount, '300000000000000'); assert.equal(r.totals.ETH.count, 2); assert.equal(r.totalWei, '300000000000000');
    assert.equal(r.totals.USDG.amount, '5000000'); assert.equal(r.totals.USDG.decimals, 6); assert.equal(r.totals.USDG.address, USDG);
    assert.equal(r.totals.MARQ.amount, '7000000000000000000'); assert.equal(r.totals.MARQ.address, MARQ);
    assert.equal(r.count, 4); assert.equal(r.tips.length, 4);
    assert.ok(r.tips.every((x) => x.team === true && x.token && 'symbol' in x.token && 'decimals' in x.token));
    assert.deepEqual(r.tips.find((x) => x.amount === '5000000').token, { address: USDG, symbol: 'USDG', decimals: 6 });
    assert.deepEqual(r.tips.find((x) => x.amount === '100000000000000').token, { address: null, symbol: 'ETH', decimals: 18 });
    const top = (await s.get('/api/tips/top')).body;
    assert.equal(top.recent.length, 9);
    for (const a of ['99999', '999999999999999999', '9999999999999']) { const d = top.recent.find((x) => x.amount === a); assert.equal(d.counted, false); assert.equal(d.reason, 'dust'); }
    assert.ok(!('reason' in byAmtNoDust(top, '5000000')));
    const byAmt = (a) => top.recent.find((x) => x.amount === a);
    assert.equal(byAmt('999').counted, false); assert.equal(byAmt('999').token.symbol, null); assert.equal(byAmt('999').token.address, OTHER);
    assert.equal(byAmt('8000000').counted, false); assert.equal(byAmt('5000000').counted, true); assert.equal(byAmt('100000000000000').counted, true);
    assert.equal(top.top[0].totals.USDG.amount, '5000000'); assert.equal(top.top[0].totalWei, '300000000000000');
    const stats = (await s.get('/api/stats')).body;
    assert.equal(stats.tips.tokens.USDG.amount, '13099999'); // gross incl. spoof (labelled unfiltered)
    assert.equal(stats.tips.tokens.ETH.count, 3); assert.equal(stats.tips.label, 'gross (unfiltered)');
    assert.ok(!('999' in stats.tips.tokens) && Object.keys(stats.tips.tokens).sort().join() === 'ETH,MARQ,USDG');
    // system chat messages: only counted tips, once each
    await sleep(100);
    const sys = (await s.get(`/api/s/${st.id}/chat`)).body.messages;
    assert.equal(sys.length, 4); assert.ok(sys.every((m) => m.system === true && m.nick === null && /^0x806a…Ef73 tipped /.test(m.text) && /^0x[0-9a-f]{64}$/.test(m.tx)));
    assert.ok(sys.some((m) => m.text === '0x806a…Ef73 tipped 5 USDG'));
    assert.ok(sys.some((m) => m.text === '0x806a…Ef73 tipped 7 MARQ'));
    assert.ok(sys.some((m) => m.text === '0x806a…Ef73 tipped 0.0002 ETH'));
    assert.equal(v.events.filter((e) => e.event === 'chat' && e.data.system).length, 4);
    // re-index: no duplicate rows, no duplicate chat lines
    await s.chain.indexLogs();
    assert.equal((await s.get(`/api/s/${st.id}/chat`)).body.messages.length, 4);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM tips').get().c, 9);
    // system messages cannot be reported
    assert.equal((await s.post(`/api/s/${st.id}/chat/${sys[0].id}/report`, {})).status, 400);
    v.close();
  } finally { await s.stop(); rpc.close(); }
});

test('MARQ not in totals before launch (token.json zero address); ETH + USDG only', async () => {
  const rpc = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const one = (m) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_blockNumber' ? '0x64' : m.method === 'eth_getLogs' ? [] : w(0) }); const j = JSON.parse(b); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); }); });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const s = await startServer({ rpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const st = await s.stream({ wallet: WALLET });
    fs.writeFileSync(path.join(s.webDir, 'deployments.json'), JSON.stringify({ chains: { '4663': { address: V2, deployBlock: 30 } } }));
    await s.chain.indexLogs();
    const r = (await s.get(`/api/tips?stream=${st.id}`)).body;
    assert.deepEqual(Object.keys(r.totals), ['ETH', 'USDG']); assert.equal(r.totals.ETH.count, 0);
  } finally { await s.stop(); rpc.close(); }
});
