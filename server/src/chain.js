// On-chain reads: TipJar counters/logs and token balanceOf. RPC failure -> unavailable, never 0.
import { createPublicClient, http, parseAbi, parseAbiItem, keccak256, toHex, defineChain } from 'viem';

const abi = parseAbi([
  'function totalTipped() view returns (uint256)',
  'function tipCount() view returns (uint256)',
  'function receivedFor(bytes32) view returns (uint256)',
]);
const tippedEvent = parseAbiItem('event Tipped(bytes32 indexed streamId, address indexed from, address indexed streamer, uint256 amount)');
const tippedTokenEvent = parseAbiItem('event TippedToken(bytes32 indexed streamId, address indexed from, address indexed streamer, address token, uint256 amount)');
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

export const streamIdHash = (id) => keccak256(toHex(id));

export function createChain({ rpcUrl, logsRpcUrls = [], db, readDeployments, readToken, log, onTip, chainId = 4663, timeoutMs = 4000, pollMs = 30000, window = 20000n }) {
  const chain = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
  // getLogs/getBlock: primary first, then fallbacks (publicnode refuses history older than ~100 blocks on mainnet)
  const logClients = [client, ...logsRpcUrls.filter((u) => u && u !== rpcUrl).map((u) => createPublicClient({ chain, transport: http(u, { timeout: timeoutMs * 2, retryCount: 0 }) }))];
  const withLogClient = async (fn) => { let err; for (const c of logClients) { try { return await fn(c); } catch (e) { err = e; } } throw err; };
  const cache = new Map(); // key -> {t, v}
  let lastGoodAt = null;
  const kvGet = (k) => db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
  const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

  const cached = async (key, ttl, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
  };

  const jar = () => readDeployments();

  const ts = { t: 0, v: null, p: null };
  const notDeployed = () => ({ unavailable: true, reason: 'not_deployed', lastGoodAt });
  function refreshTotals() {
    const j = jar();
    ts.p = (async () => {
      try {
        const [totalTipped, tipCount, block] = await Promise.all([
          client.readContract({ address: j.address, abi, functionName: 'totalTipped' }),
          client.readContract({ address: j.address, abi, functionName: 'tipCount' }),
          client.getBlockNumber(),
        ]);
        lastGoodAt = Date.now();
        ts.v = { count: Number(tipCount), totalWei: totalTipped.toString(), asOfBlock: Number(block) };
      } catch {
        log?.warn({ code: 'rpc_fail', where: 'totals' }, 'rpc unavailable');
        ts.v = { unavailable: true, lastGoodAt };
      }
      ts.t = Date.now(); ts.p = null;
    })();
    return ts.p;
  }
  /** Awaits a fresh-enough answer (<=15 s old). */
  async function totals() {
    if (!jar()) return notDeployed();
    if (Date.now() - ts.t > 15000) await (ts.p || refreshTotals()); else if (ts.p) await ts.p;
    return ts.v;
  }
  /** Never blocks: serves the last answer and refreshes in the background (for /api/stats). */
  function totalsSWR() {
    if (!jar()) return notDeployed();
    if (Date.now() - ts.t > 15000 && !ts.p) refreshTotals();
    return ts.v ?? { unavailable: true, lastGoodAt };
  }

  async function receivedFor(id) {
    const j = jar();
    if (!j) return null;
    try {
      return await cached('rf:' + id, 15000, async () => {
        const v = await client.readContract({ address: j.address, abi, functionName: 'receivedFor', args: [streamIdHash(id)] });
        lastGoodAt = Date.now();
        return v.toString();
      });
    } catch { return null; }
  }

  /** Index Tipped (+ TippedToken on the current v2 jar) logs into the tips table; per-contract cursors. Retired jars: Tipped only. */
  async function indexLogs() {
    const j = jar();
    if (!j) return { ok: false, reason: 'not_deployed' };
    try {
      const head = await client.getBlockNumber();
      if (kvGet('tipsSchema') !== '2') { db.prepare('DELETE FROM tips').run(); db.prepare("DELETE FROM kv WHERE k LIKE 'cur:%' OR k IN ('tipsCursor','tipsJar')").run(); kvSet('tipsSchema', '2'); }
      const sources = [{ address: j.address, deployBlock: j.deployBlock, events: [tippedEvent, tippedTokenEvent] }, ...(j.retired || []).map((x) => ({ ...x, events: [tippedEvent] }))];
      const keep = sources.map((x) => x.address.toLowerCase());
      db.prepare(`DELETE FROM tips WHERE src IS NULL OR src NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
      for (const src of sources) {
        const ck = 'cur:' + src.address.toLowerCase();
        let from = BigInt(kvGet(ck) ?? Math.max(0, (src.deployBlock || 1) - 1)) + 1n;
        if (kvGet(ck) === undefined) from = BigInt(src.deployBlock || 0);
        const ins = db.prepare('INSERT OR IGNORE INTO tips(txHash,logIndex,block,streamId,"from",streamer,amount,t,token,src) VALUES(?,?,?,?,?,?,?,?,?,?)');
        let guard = 0, w = window;
        while (from <= head && guard++ < 2000) {
          const to = from + w - 1n > head ? head : from + w - 1n;
          let logs;
          try { logs = await withLogClient((c) => c.getLogs({ address: src.address, events: src.events, fromBlock: from, toBlock: to })); }
          catch (e) { if (w > 200n) { w /= 4n; continue; } throw e; } // providers cap the range: shrink and retry
          const ts = new Map();
          for (const bn of new Set(logs.map((l) => l.blockNumber))) {
            try { ts.set(bn, Number((await withLogClient((c) => c.getBlock({ blockNumber: bn }))).timestamp)); } catch { /* t stays null */ }
          }
          const fresh = [];
          db.transaction(() => {
            for (const l of logs) {
              if (!l.args?.streamId) continue;
              const token = l.eventName === 'TippedToken' ? String(l.args.token).toLowerCase() : null;
              const row = { txHash: l.transactionHash, logIndex: l.logIndex, block: Number(l.blockNumber), streamId: l.args.streamId, from: l.args.from, streamer: l.args.streamer, amount: l.args.amount.toString(), t: ts.get(l.blockNumber) ?? null, token };
              if (ins.run(row.txHash, row.logIndex, row.block, row.streamId, row.from, row.streamer, row.amount, row.t, token, src.address.toLowerCase()).changes) fresh.push(row);
            }
          })();
          kvSet(ck, to.toString());
          from = to + 1n;
          for (const row of fresh) { try { onTip?.(row); } catch (e) { log?.warn({ code: 'on_tip_fail' }, 'onTip failed'); } }
        }
      }
      kvSet('tipsHead', head.toString());
      lastGoodAt = Date.now();
      kvSet('tipsLastGoodAt', lastGoodAt);
      return { ok: true, head: Number(head) };
    } catch (e) {
      log?.warn({ code: 'rpc_fail', where: 'logs', err: String(e.shortMessage || e.message).slice(0, 200) }, 'rpc unavailable');
      return { ok: false };
    }
  }

  async function holderBalance(wallet) {
    const t = readToken();
    if (!t || !t.launched || !/^0x[0-9a-fA-F]{40}$/.test(t.address || '') || /^0x0{40}$/.test(t.address)) return { launched: false };
    try {
      const v = await cached('bal:' + wallet.toLowerCase(), 60000, () => client.readContract({ address: t.address, abi: erc20, functionName: 'balanceOf', args: [wallet] }));
      return { launched: true, balance: v };
    } catch { return { launched: true, unavailable: true }; }
  }

  let timer = null;
  const start = () => { if (jar()) totals(); if (pollMs > 0) { timer = setInterval(() => { totals(); indexLogs(); }, pollMs); timer.unref(); indexLogs(); } };
  const stop = () => clearInterval(timer);
  return { totals, totalsSWR, receivedFor, indexLogs, holderBalance, start, stop, lastGoodAt: () => lastGoodAt, kvGet, client };
}
