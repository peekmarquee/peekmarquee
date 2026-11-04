import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyMessage } from 'viem';
import { openDb } from './db.js';
import { redactData, loadSharedRedact, redactSource } from './redact.js';
import { validateClientMessage } from '../../shared/schema/index.js';
import { jsonReader, tipJarFrom, teamWalletsFrom } from './files.js';
import { createChain, streamIdHash } from './chain.js';
import { formatUnits } from 'viem';

const H = 3600e3;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const EVENT_TYPES = new Set(['hello', 'status', 'prompt', 'text', 'tool_call', 'tool_result', 'edit', 'end']);
const REPORT_REASONS = new Set(['illegal', 'secret_leaked', 'spam', 'other']);
const MAX_FRAME = 32 * 1024;
const BAD_WORDS = /\b(fuck|shit|cunt|nigg|fag|bitch|porn|nazi|rape|cock|dick|slut|whore)\w*/i;
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|live|net|org|co|app|dev|ai|me|ly|gg|sh|to|cc|info|biz|link|click)\b)/i;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ZERO_ADDR = /^0x0{40}$/;
const CHAT_MAX_NICK = 24, CHAT_MAX_TEXT = 280, CHAT_HISTORY = 100, CHAT_KEEP = 1000;
const LINK_REMOVED = '[link removed]';
const HEX_ADDR_RE = /0x[0-9a-f]{10,}/gi;
const LINK_RE = /(?:https?:\/\/|ftp:\/\/|www\.)\S*|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\b(?:[/:?#]\S*)?/giu;
const BAD_WORDS_G = new RegExp(BAD_WORDS.source, 'gi');
/** Strip HTML + control chars, remove addresses and links (anti fake-CA), mask rude words. Returns cleaned string (not length-checked). */
export function cleanChat(raw) {
  let t = String(raw).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, '').replace(/\p{C}/gu, (c) => (c === '\n' || c === '\t' ? ' ' : '')).replace(/\s+/g, ' ').trim();
  t = t.replace(HEX_ADDR_RE, LINK_REMOVED).replace(LINK_RE, LINK_REMOVED);
  t = t.replace(/(\[link removed\]\s*){2,}/g, LINK_REMOVED + ' ').replace(BAD_WORDS_G, (m) => '*'.repeat(m.length)).trim();
  return t;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (n) => crypto.randomBytes(n).toString('base64url');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function newId() {
  let n = BigInt('0x' + crypto.randomBytes(7).toString('hex')) & ((1n << 50n) - 1n);
  let s = '';
  for (let i = 0; i < 10; i++) { s = CROCKFORD[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
const ID_RE = /^[0-9a-hjkmnp-tv-z]{10}$/;

class Hits { // fixed sliding window counters
  constructor() { this.m = new Map(); }
  hit(key, windowMs, max, now) {
    const arr = (this.m.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this.m.set(key, arr); return false; }
    arr.push(now); this.m.set(key, arr); return true;
  }
  gc(now, windowMs) { for (const [k, a] of this.m) if (!a.some((t) => now - t < windowMs)) this.m.delete(k); }
}

export async function createApp(o = {}) {
  const cfg = {
    dataDir: o.dataDir || process.env.DATA_DIR || path.resolve('data'),
    webDir: o.webDir || process.env.WEB_DIR || path.resolve('../web'),
    host: o.host || process.env.HOST || '127.0.0.1',
    port: o.port ?? Number(process.env.PORT || 4840),
    publicUrl: (o.publicUrl || process.env.PUBLIC_URL || 'https://peekmarquee.live').replace(/\/$/, ''),
    now: o.now || (() => Date.now()),
    apiPerMin: o.apiPerMin ?? 60,
    ingestRate: o.ingestRate ?? 25, ingestBurst: o.ingestBurst ?? 100,
    ingestBytes: o.ingestBytes ?? 4 * 1024 * 1024,
    maxActivePerIp: o.maxActivePerIp ?? 3, newPerHour: o.newPerHour ?? 12, postPerHour: o.postPerHour ?? 20,
    viewersPerStream: o.viewersPerStream ?? 300, viewersPerIp: o.viewersPerIp ?? 20,
    chainPollMs: o.chainPollMs ?? 30000, sweepMs: o.sweepMs ?? 60000, ackMs: o.ackMs ?? 2000,
    pauseMs: 90e3, staleEndMs: 30 * 60e3,
  };
  const now = () => cfg.now();
  const db = openDb(cfg.dataDir);
  await loadSharedRedact();
  const streamsDir = path.join(cfg.dataDir, 'streams');
  const readToken = jsonReader(path.join(cfg.webDir, 'token.json'));
  const readDepRaw = jsonReader(path.join(cfg.webDir, 'deployments.json'));
  const depAtStart = readDepRaw();
  const chainId = Number(o.chainId || process.env.CHAIN_ID || depAtStart?.defaultChainId || 4663);
  cfg.rpcUrl = o.rpcUrl || process.env.RPC_URL || depAtStart?.chains?.[String(chainId)]?.rpcUrl || 'https://robinhood-rpc.publicnode.com';
  const readDeployments = () => tipJarFrom(readDepRaw(), chainId);
  const teamWallets = () => teamWalletsFrom(readDepRaw());
  const isTeam = (x) => !!x && teamWallets().has(String(x).toLowerCase());
  const adminTokenFile = path.join(cfg.dataDir, 'admin.token');
  if (!fs.existsSync(adminTokenFile)) fs.writeFileSync(adminTokenFile, b64u(24), { mode: 0o600 });
  const adminToken = fs.readFileSync(adminTokenFile, 'utf8').trim();

  const serializers = { req: (r) => ({ method: r.method, url: (r.url || '').split('?')[0], ip: r.ip }), res: (r) => ({ statusCode: r.statusCode }) };
  const logger = o.logStream ? { stream: o.logStream, serializers, level: 'info' } : o.logger === false ? false : { level: 'info', serializers };
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 16 * 1024, });
  const log = app.log;
  const logsRpc = o.logsRpcUrls || (process.env.LOGS_RPC_URL ? process.env.LOGS_RPC_URL.split(',') : [depAtStart?.chains?.[String(chainId)]?.logsRpcUrl, ...(chainId === 4663 ? ['https://robinhood.drpc.org'] : [])].filter(Boolean));
  const chain = createChain({ rpcUrl: cfg.rpcUrl, logsRpcUrls: logsRpc, db, readDeployments, readToken, log, pollMs: cfg.chainPollMs, chainId, timeoutMs: o.rpcTimeoutMs ?? 4000, onTip });

  const q = {
    get: db.prepare('SELECT * FROM streams WHERE id=?'),
    gone: db.prepare('SELECT * FROM gone WHERE id=?'),
    insert: db.prepare('INSERT INTO streams(id,tokenHash,manageKeyHash,title,agent,wallet,public,replay,createdAt) VALUES(?,?,?,?,?,?,?,?,?)'),
    frame: db.prepare('UPDATE streams SET lastSeq=?, lastFrameAt=?, startedAt=COALESCE(startedAt,?), red=?, redServer=?, toolCalls=?, edits=? WHERE id=?'),
    counter: db.prepare('UPDATE counters SET v=v+? WHERE k=?'),
  };
  const bump = (k, n) => { if (n) q.counter.run(n, k); };

  const conns = new Map();   // id -> {ws, ip, ...}
  const viewers = new Map(); // id -> Set<res>
  const viewersByIp = new Map();
  const hits = new Hits();
  const nonces = new Map();
  const slowAt = new Map(); // 'streamId|ip' -> last chat time

  const vcount = (id) => viewers.get(id)?.size || 0;
  const isLive = (r) => !!(!r.endedAt && !r.deletedAt && (conns.has(r.id) || (r.lastFrameAt && now() - r.lastFrameAt < cfg.pauseMs)));
  const filePath = (id) => path.join(streamsDir, id + '.jsonl');
  const metaPath = (id) => path.join(streamsDir, id + '.meta.json');
  const rm = (p) => { try { fs.rmSync(p, { force: true }); } catch {} };

  function featuredSet() {
    const t = readToken();
    if (!t?.launched) return new Set();
    const th = (() => { try { return BigInt(t.holderThreshold ?? 0); } catch { return 0n; } })();
    const rows = db.prepare('SELECT streamId, balance FROM holders').all()
      .map((h) => ({ id: h.streamId, b: BigInt(h.balance || 0) })).filter((h) => h.b >= th && h.b > 0n)
      .sort((a, b) => (a.b < b.b ? 1 : a.b > b.b ? -1 : 0)).slice(0, 5);
    return new Set(rows.map((r) => r.id));
  }

  const metaOf = (r) => ({
    id: r.id, title: r.title, agent: r.agent, live: isLive(r), startedAt: r.startedAt, endedAt: r.endedAt,
    viewers: vcount(r.id), toolCalls: r.toolCalls, edits: r.edits, red: r.red,
    ...(r.redServer > 0 ? { redServer: r.redServer } : {}),
    wallet: r.wallet, public: !!r.public && !r.unlisted, replayUntil: r.expiresAt, lastFrameAt: r.lastFrameAt,
    underReview: !!(r.unlisted || r.replayOff) && (r.reportCount >= 3 || !!r.replayOff), replay: !!r.replay && !r.replayOff, holder: !!r.holder,
    chatOn: !!r.chatOn, chatSlowSec: r.slowSec,
  });
  const writeMetaFile = (r) => { try { fs.writeFileSync(metaPath(r.id), JSON.stringify(metaOf(r))); } catch {} };

  const sse = (res, evt, data, id) => { try { res.write(`${id != null ? `id: ${id}\n` : ''}event: ${evt}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`); } catch {} };
  const dirty = new Set();
  function broadcastMeta(id) {
    const set = viewers.get(id); if (!set?.size) return;
    const r = q.get.get(id); if (!r) return;
    const m = metaOf(r);
    for (const res of set) sse(res, 'meta', m);
  }
  function broadcastViewers(id) {
    const n = vcount(id);
    const set = viewers.get(id);
    if (set) for (const res of set) sse(res, 'viewers', { n });
    const c = conns.get(id);
    if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'viewers', n }));
    const r = q.get.get(id);
    if (r && n > r.viewersPeak) db.prepare('UPDATE streams SET viewersPeak=? WHERE id=?').run(n, id);
  }
  const metaTimer = setInterval(() => { for (const id of dirty) broadcastMeta(id); dirty.clear(); }, 1000); metaTimer.unref();

  function finalize(id, reason) {
    const r = q.get.get(id); if (!r || r.endedAt) return;
    const t = now();
    const ttl = r.holder ? 30 * 24 * H : 24 * H;
    db.prepare('UPDATE streams SET endedAt=?, expiresAt=? WHERE id=?').run(t, t + ttl, id);
    if (!r.replay) { rm(filePath(id)); db.prepare('DELETE FROM chat WHERE streamId=?').run(id); }
    const r2 = q.get.get(id); writeMetaFile(r2);
    const set = viewers.get(id);
    if (set) for (const res of set) { if (reason === 'timeout') sse(res, 'end', { reason: 'timeout' }); sse(res, 'meta', metaOf(r2)); }
  }

  function removeStream(id, reason) {
    const c = conns.get(id);
    if (c) { try { c.ws.send(JSON.stringify({ type: 'error', code: 'stream_closed', msg: reason })); c.ws.close(4410, 'stream_closed'); } catch {} conns.delete(id); }
    const set = viewers.get(id);
    if (set) { for (const res of set) { sse(res, 'deleted', { reason }); try { res.end(); } catch {} } viewers.delete(id); }
    rm(filePath(id)); rm(metaPath(id));
    db.prepare('DELETE FROM streams WHERE id=?').run(id);
    db.prepare('DELETE FROM holders WHERE streamId=?').run(id);
    db.prepare('DELETE FROM chat_reports WHERE msgId IN (SELECT id FROM chat WHERE streamId=?)').run(id);
    db.prepare('DELETE FROM chat WHERE streamId=?').run(id);
    slowAt.forEach((_v, k) => { if (k.startsWith(id + '|')) slowAt.delete(k); });
    db.prepare('INSERT OR REPLACE INTO gone(id,reason,t) VALUES(?,?,?)').run(id, reason, now());
  }

  async function sweep() {
    const t = now();
    for (const r of db.prepare('SELECT * FROM streams WHERE endedAt IS NULL AND lastFrameAt IS NOT NULL AND lastFrameAt<=?').all(t - cfg.staleEndMs)) {
      if (!conns.has(r.id)) finalize(r.id, 'timeout');
    }
    for (const r of db.prepare('SELECT id FROM streams WHERE lastFrameAt IS NULL AND createdAt<=?').all(t - cfg.staleEndMs)) removeStream(r.id, 'expired');
    for (const r of db.prepare('SELECT id FROM streams WHERE expiresAt IS NOT NULL AND expiresAt<=?').all(t)) removeStream(r.id, 'expired');
    db.prepare('DELETE FROM gone WHERE t<?').run(t - 30 * 24 * H);
    hits.gc(t, H);
    db.prepare('DELETE FROM chat WHERE streamId NOT IN (SELECT id FROM streams)').run();
    db.prepare('DELETE FROM chat_reports WHERE msgId NOT IN (SELECT id FROM chat)').run();
    for (const [k, v] of slowAt) if (t - v > 10 * 60e3) slowAt.delete(k);
    for (const [k, v] of nonces) if (v.exp < t) nonces.delete(k);
    // holder balance refresh (best effort, post-T0)
    if (readToken()?.launched) {
      for (const h of db.prepare('SELECT * FROM holders').all()) {
        const b = await chain.holderBalance(h.wallet);
        if (b.balance !== undefined) db.prepare('UPDATE holders SET balance=? WHERE streamId=?').run(b.balance.toString(), h.streamId);
      }
    }
  }

  // ---------- HTTP plumbing ----------
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') reply.header('Access-Control-Allow-Origin', '*');
    const u = req.url;
    if (u.startsWith('/api') && !/^\/api\/s\/[^/]+\/events/.test(u) && cfg.apiPerMin > 0) {
      if (!hits.hit('api:' + req.ip, 60e3, cfg.apiPerMin, now())) return reply.code(429).send({ error: 'rate_limited' });
    }
  });
  app.setErrorHandler((err, req, reply) => {
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (code === 500) log.error({ code: err.code || 'internal' }, 'handler error');
    reply.code(code).send({ error: code === 500 ? 'internal' : (err.code || 'bad_request') });
  });
  const cacheShort = (reply) => reply.header('Cache-Control', 'public, max-age=5');

  const goneReply = (reply, id) => {
    const g = q.gone.get(id);
    if (g) return reply.code(410).send({ error: 'gone', reason: g.reason, msg: g.reason === 'deleted' ? 'This stream was deleted.' : 'This stream has expired.' });
    return reply.code(404).send({ error: 'not_found' });
  };
  const getVisible = (id, reply) => {
    if (!ID_RE.test(id)) { reply.code(404).send({ error: 'not_found' }); return null; }
    const r = q.get.get(id);
    if (!r) { goneReply(reply, id); return null; }
    return r;
  };
  const authOwner = (req, r) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const mk = req.headers['x-manage-key'];
    return (bearer && safeEq(sha(bearer), r.tokenHash)) || (typeof mk === 'string' && safeEq(sha(mk), r.manageKeyHash));
  };

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api', async () => ({
    name: 'peekmarquee relay', version: 1, ticker: 'MARQ',
    routes: [
      'POST /api/streams {title,agent,wallet?,public,replay} -> {id,ingestToken,manageKey,url}',
      'WSS  /ingest/<id> (Authorization: Bearer <ingestToken>)',
      'GET  /api/s/<id>', 'GET  /api/s/<id>/events?from=<seq> (SSE)', 'GET  /api/s/<id>/replay.jsonl',
      'DELETE /api/streams/<id> (Bearer ingestToken | X-Manage-Key)', 'POST /api/s/<id>/report {reason}',
      'GET  /api/s/<id>/chat?limit=100', 'POST /api/s/<id>/chat {nick,text}', 'POST /api/s/<id>/chat/<msgId>/report', 'DELETE /api/s/<id>/chat/<msgId> (manage key)', 'POST /api/s/<id>/chat/settings {on?,slowSec?} (manage key)',
      'GET  /api/live', 'GET  /api/recent', 'GET  /api/stats', 'GET  /api/tips?stream=<id>', 'GET  /api/tips/top',
      'GET  /api/holder/<wallet>', 'GET  /healthz',
    ],
  }));

  function cleanTitle(t) {
    if (typeof t !== 'string') return null;
    const s = t.replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim();
    if (!s || [...s].length > 80) return null;
    if (BAD_WORDS.test(s) || URL_RE.test(s)) return null;
    return s;
  }

  app.post('/api/streams', async (req, reply) => {
    const t = now();
    if (!hits.hit('post:' + req.ip, H, cfg.postPerHour, t)) return reply.code(429).send({ error: 'rate_limited' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const title = cleanTitle(b.title);
    if (!title) return reply.code(400).send({ error: 'bad_title', msg: 'Title must be 1-80 characters, no links or rude words.' });
    const agent = b.agent ?? 'claude';
    if (agent !== 'claude' && agent !== 'codex') return reply.code(400).send({ error: 'bad_agent' });
    let wallet = null;
    if (b.wallet != null) { if (typeof b.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.wallet)) return reply.code(400).send({ error: 'bad_wallet' }); wallet = b.wallet.toLowerCase(); }
    if (!hits.hit('new:' + req.ip, H, cfg.newPerHour, t)) return reply.code(429).send({ error: 'rate_limited', msg: 'Too many new streams this hour.' });
    const id = newId(), ingestToken = b64u(32), manageKey = b64u(32);
    q.insert.run(id, sha(ingestToken), sha(manageKey), title, agent, wallet, b.public === false ? 0 : 1, b.replay === false ? 0 : 1, t);
    writeMetaFile(q.get.get(id));
    log.info({ id, code: 'stream_created' }, 'stream created');
    return { id, ingestToken, manageKey, url: `${cfg.publicUrl}/s/${id}` };
  });

  app.get('/api/s/:id', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    return metaOf(r);
  });

  app.delete('/api/streams/:id', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (!authOwner(req, r)) return reply.code(401).send({ error: 'bad_token' });
    removeStream(r.id, 'deleted');
    log.info({ id: r.id, code: 'stream_deleted' }, 'stream deleted');
    return { ok: true };
  });

  app.post('/api/s/:id/report', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    const reason = req.body?.reason;
    if (!REPORT_REASONS.has(reason)) return reply.code(400).send({ error: 'bad_reason' });
    const t = now();
    if (!hits.hit('rep:' + req.ip, H, 5, t)) return reply.code(429).send({ error: 'rate_limited' });
    db.prepare('INSERT INTO reports(streamId,reason,ip_hash,t) VALUES(?,?,?,?)').run(r.id, reason, sha(req.ip + adminToken).slice(0, 16), t);
    const count = r.reportCount + 1;
    const unlist = count >= 3 || reason === 'secret_leaked';
    db.prepare('UPDATE streams SET reportCount=?, unlisted=?, replayOff=? WHERE id=?').run(count, unlist ? 1 : r.unlisted, reason === 'secret_leaked' ? 1 : r.replayOff, r.id);
    if (unlist) log.warn({ id: r.id, reason, reportCount: count, code: 'stream_unlisted' }, 'REPORT: stream unlisted, needs review');
    broadcastMeta(r.id);
    return { ok: true };
  });

  app.get('/api/s/:id/replay.jsonl', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (r.replayOff) return reply.code(403).send({ error: 'under_review' });
    if (!r.replay) return reply.code(410).send({ error: 'no_replay' });
    if (!fs.existsSync(filePath(r.id))) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', 'application/x-ndjson').header('Content-Disposition', `attachment; filename="${r.id}.jsonl"`);
    return reply.send(fs.createReadStream(filePath(r.id)));
  });

  // ---------- SSE ----------
  app.get('/api/s/:id/events', (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    const id = r.id, ip = req.ip;
    const set = viewers.get(id) || new Set();
    if (set.size >= cfg.viewersPerStream) return reply.code(503).send({ error: 'viewer_limit', msg: 'viewer limit reached' });
    if ((viewersByIp.get(ip) || 0) >= cfg.viewersPerIp) return reply.code(429).send({ error: 'rate_limited', msg: 'too many connections' });
    let from = 1;
    const lei = Number(req.headers['last-event-id']);
    if (Number.isInteger(lei) && lei >= 0 && req.headers['last-event-id'] !== '') from = lei + 1;
    if (req.query.from !== undefined) { const f = Number(req.query.from); if (Number.isInteger(f) && f >= 0) from = f; }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    sse(res, 'meta', metaOf(r));
    // replay from file, then join live set in the same tick (no gap, no dup)
    if (!r.replayOff && fs.existsSync(filePath(id))) {
      const txt = fs.readFileSync(filePath(id), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let seq; try { seq = JSON.parse(line).seq; } catch { continue; }
        if (seq >= from) res.write(`id: ${seq}\nevent: ${JSON.parse(line).type}\ndata: ${line}\n\n`);
      }
    }
    if (!r.replayOff) for (const m of chatRows(id, CHAT_HISTORY)) sse(res, 'chat', m); // no id: line -> session Last-Event-ID untouched
    set.add(res); viewers.set(id, set); viewersByIp.set(ip, (viewersByIp.get(ip) || 0) + 1);
    sse(res, 'viewers', { n: set.size });
    broadcastViewers(id);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.raw.on('close', () => {
      clearInterval(hb);
      const s = viewers.get(id); if (s) { s.delete(res); if (!s.size) viewers.delete(id); }
      const n = (viewersByIp.get(ip) || 1) - 1; if (n <= 0) viewersByIp.delete(ip); else viewersByIp.set(ip, n);
      broadcastViewers(id);
    });
  });

  // ---------- live chat. Never sent to the CLI websocket; SSE event name `chat` is separate from session events ----------
  const chatMsg = (m) => ({ id: m.id, nick: m.system ? null : m.nick, text: m.text, system: !!m.system, ...(m.tx ? { tx: m.tx } : {}), t: m.t });
  function chatRows(id, limit) {
    return db.prepare('SELECT * FROM chat WHERE streamId=? AND hidden=0 ORDER BY id DESC LIMIT ?').all(id, limit).reverse().map(chatMsg);
  }
  function chatBroadcast(id, evt, data) { const set = viewers.get(id); if (set) for (const res of set) sse(res, evt, data); }
  function chatInsert(id, { nick, text, system = 0, tx = null }) {
    const info = db.prepare('INSERT INTO chat(streamId,nick,text,system,tx,t,hidden) VALUES(?,?,?,?,?,?,0)').run(id, nick, text, system, tx, now());
    const row = db.prepare('SELECT * FROM chat WHERE id=?').get(info.lastInsertRowid);
    db.prepare('DELETE FROM chat WHERE streamId=? AND id<=(SELECT MIN(id) FROM (SELECT id FROM chat WHERE streamId=? ORDER BY id DESC LIMIT ?))-1').run(id, id, CHAT_KEEP);
    const m = chatMsg(row);
    chatBroadcast(id, 'chat', m);
    return m;
  }
  function tokenInfo(addr) {
    if (!addr || ZERO_ADDR.test(addr)) return { address: null, symbol: 'ETH', decimals: 18, known: true };
    const a = addr.toLowerCase();
    if (a === USDG) return { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6, known: true };
    const m = readToken()?.address;
    if (typeof m === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m) && !ZERO_ADDR.test(m) && m.toLowerCase() === a) return { address: m, symbol: readToken().symbol || 'MARQ', decimals: 18, known: true };
    return { address: addr, symbol: null, decimals: null, known: false };
  }
  // Display thresholds (review S1: token tips have no on-chain minimum). Below -> dust: no chat line, not counted in per-stream totals/top.
  // ETH = deployments.minTipWei (default 0.00001); USDG 0.10; MARQ = token.json minDisplay (base units) / env MARQ_MIN_DISPLAY (whole tokens), default 1.
  function dustMin(tk) {
    try {
      if (tk.symbol === 'ETH') return BigInt(readDepRaw()?.minTipWei ?? '10000000000000');
      if (tk.symbol === 'USDG') return BigInt(process.env.USDG_MIN_DISPLAY_UNITS ?? 100000);
      const md = readToken()?.minDisplay; if (md != null) return BigInt(md);
      return BigInt(process.env.MARQ_MIN_DISPLAY ?? 1) * 10n ** BigInt(tk.decimals);
    } catch { return 0n; }
  }
  const isDust = (x) => { const tk = tokenInfo(x.token); return tk.known && BigInt(x.amount) < dustMin(tk); };
  const tokenPub = ({ address, symbol, decimals }) => ({ address, symbol, decimals });
  const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const niceAmount = (amt, dec) => { const v = formatUnits(BigInt(amt), dec); const [i, f = ''] = v.split('.'); const fr = f.slice(0, 6).replace(/0+$/, ''); return fr ? `${i}.${fr}` : i; };
  /** Counted tip (known token, streamer == stream wallet) -> system chat line; idempotent per tx. */
  function onTip(row) {
    const tk = tokenInfo(row.token);
    if (!tk.known || isDust(row)) return;
    const r = db.prepare('SELECT id,wallet,endedAt FROM streams').all().find((x) => x.wallet && streamIdHash(x.id) === row.streamId && x.wallet.toLowerCase() === row.streamer.toLowerCase());
    if (!r) return;
    if (db.prepare('SELECT 1 FROM chat WHERE streamId=? AND tx=?').get(r.id, row.txHash)) return;
    chatInsert(r.id, { nick: null, text: `${shortAddr(row.from)} tipped ${niceAmount(row.amount, tk.decimals)} ${tk.symbol}`, system: 1, tx: row.txHash });
  }

  app.get('/api/s/:id/chat', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    const lim = Math.min(CHAT_HISTORY, Math.max(1, Math.floor(Number(req.query.limit)) || CHAT_HISTORY));
    return { on: !!r.chatOn, slowSec: r.slowSec, messages: r.replayOff ? [] : chatRows(r.id, lim) };
  });
  app.post('/api/s/:id/chat', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof b.nick !== 'string' || typeof b.text !== 'string') return reply.code(400).send({ error: 'bad_message' });
    if (b.nick.length > 200 || b.text.length > 2000) return reply.code(400).send({ error: 'too_long' });
    const nick = cleanChat(b.nick), text = cleanChat(b.text);
    if (!nick || [...nick].length > CHAT_MAX_NICK) return reply.code(400).send({ error: 'bad_nick', msg: `Nick must be 1-${CHAT_MAX_NICK} characters.` });
    if (!text || [...text].length > CHAT_MAX_TEXT) return reply.code(400).send({ error: 'bad_text', msg: `Message must be 1-${CHAT_MAX_TEXT} characters.` });
    if (!r.chatOn) return reply.code(403).send({ error: 'chat_off' });
    if (r.endedAt || r.deletedAt || r.replayOff) return reply.code(409).send({ error: 'chat_closed' });
    const t = now();
    if (r.slowSec > 0) {
      const last = slowAt.get(r.id + '|' + req.ip);
      if (last && t - last < r.slowSec * 1000) return reply.code(429).send({ error: 'slow_mode', retryAfterSec: Math.ceil((r.slowSec * 1000 - (t - last)) / 1000) });
    }
    if (!hits.hit('chat3:' + req.ip, 3000, 1, t) || !hits.hit('chat60:' + req.ip, 60e3, 20, t)) return reply.code(429).send({ error: 'rate_limited' });
    slowAt.set(r.id + '|' + req.ip, t);
    return chatInsert(r.id, { nick, text });
  });
  app.post('/api/s/:id/chat/:msgId/report', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    const mid = Number(req.params.msgId);
    const m = Number.isInteger(mid) ? db.prepare('SELECT * FROM chat WHERE id=? AND streamId=?').get(mid, r.id) : null;
    if (!m) return reply.code(404).send({ error: 'not_found' });
    if (m.system) return reply.code(400).send({ error: 'system_message' });
    if (!hits.hit('chatrep:' + req.ip, H, 30, now())) return reply.code(429).send({ error: 'rate_limited' });
    db.prepare('INSERT OR IGNORE INTO chat_reports(msgId,ipHash) VALUES(?,?)').run(mid, sha(req.ip + adminToken).slice(0, 16));
    const n = db.prepare('SELECT COUNT(*) c FROM chat_reports WHERE msgId=?').get(mid).c;
    if (n >= 3 && !m.hidden) { db.prepare('UPDATE chat SET hidden=1 WHERE id=?').run(mid); chatBroadcast(r.id, 'chat_delete', { id: mid }); }
    return { ok: true };
  });
  app.delete('/api/s/:id/chat/:msgId', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (!authOwner(req, r)) return reply.code(401).send({ error: 'bad_token' });
    const mid = Number(req.params.msgId);
    const info = Number.isInteger(mid) ? db.prepare('DELETE FROM chat WHERE id=? AND streamId=?').run(mid, r.id) : { changes: 0 };
    if (!info.changes) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM chat_reports WHERE msgId=?').run(mid);
    chatBroadcast(r.id, 'chat_delete', { id: mid });
    return { ok: true };
  });
  app.post('/api/s/:id/chat/settings', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (!authOwner(req, r)) return reply.code(401).send({ error: 'bad_token' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    let on = r.chatOn, slow = r.slowSec;
    if (b.on !== undefined) { if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'bad_on' }); on = b.on ? 1 : 0; }
    if (b.slowSec !== undefined) { if (!Number.isInteger(b.slowSec) || b.slowSec < 0 || b.slowSec > 300) return reply.code(400).send({ error: 'bad_slow' }); slow = b.slowSec; }
    db.prepare('UPDATE streams SET chatOn=?, slowSec=? WHERE id=?').run(on, slow, r.id);
    chatBroadcast(r.id, 'chat_state', { on: !!on, slowSec: slow });
    broadcastMeta(r.id);
    return { on: !!on, slowSec: slow };
  });

  // ---------- Lists / stats ----------
  const listRow = (r, feat) => ({ id: r.id, title: r.title, agent: r.agent, startedAt: r.startedAt, viewers: vcount(r.id), toolCalls: r.toolCalls, red: r.red, wallet: r.wallet != null, featured: feat.has(r.id), holder: !!r.holder });
  app.get('/api/live', async (req, reply) => {
    cacheShort(reply);
    const feat = featuredSet();
    const rows = db.prepare('SELECT * FROM streams WHERE public=1 AND unlisted=0 AND endedAt IS NULL').all().filter(isLive).map((r) => listRow(r, feat));
    rows.sort((a, b) => (b.featured - a.featured) || (b.viewers - a.viewers) || ((b.startedAt || 0) - (a.startedAt || 0)));
    return rows;
  });
  app.get('/api/recent', async (req, reply) => {
    cacheShort(reply);
    const feat = featuredSet();
    return db.prepare('SELECT * FROM streams WHERE public=1 AND unlisted=0 AND replay=1 AND replayOff=0 AND startedAt IS NOT NULL AND endedAt IS NOT NULL AND (expiresAt IS NULL OR expiresAt>?) ORDER BY endedAt DESC LIMIT 20').all(now())
      .map((r) => ({ ...listRow(r, feat), endedAt: r.endedAt, replayUntil: r.expiresAt }));
  });
  app.get('/api/stats', async (req, reply) => {
    cacheShort(reply);
    const c = Object.fromEntries(db.prepare('SELECT k,v FROM counters').all().map((x) => [x.k, x.v]));
    const live = db.prepare('SELECT * FROM streams WHERE public=1 AND endedAt IS NULL').all().filter(isLive).length;
    const tips = chain.totalsSWR();
    return {
      streamsTotal: c.streamsTotal, streamsLive: live, hoursStreamed: Math.round((c.msStreamed / H) * 100) / 100,
      secretsHidden: c.secretsHidden, toolCalls: c.toolCalls,
      tips: tips.unavailable ? { unavailable: true, ...(tips.reason ? { reason: tips.reason } : {}), ...(tips.lastGoodAt ? { lastGoodAt: tips.lastGoodAt } : {}) } : { ...tips, label: 'gross (unfiltered)', tokens: sumTokens(db.prepare('SELECT * FROM tips').all()) },
    };
  });

  const tipUnavailable = (reason) => ({ unavailable: true, ...(reason ? { reason } : {}), lastGoodAt: chain.lastGoodAt() });
  // Per-stream totals are FILTERED to tips whose streamer == the wallet registered for that stream (review S1).
  // On-chain receivedFor(streamId) is gross/unfiltered and is returned only under that label.
  const tipRow = (x) => ({ txHash: x.txHash, block: x.block, from: x.from, streamer: x.streamer, amount: x.amount, token: tokenPub(tokenInfo(x.token)), team: isTeam(x.from) || isTeam(x.streamer) });
  // counted = known token (ETH/USDG/MARQ) AND streamer == stream wallet (S1)
  const filteredTips = (id, wallet) => (wallet ? db.prepare('SELECT * FROM tips WHERE streamId=? AND lower(streamer)=? ORDER BY block DESC, logIndex DESC').all(streamIdHash(id), wallet.toLowerCase()).filter((x) => tokenInfo(x.token).known && !isDust(x)) : []);
  const baseTotals = () => { const o = { ETH: tokenInfo(null), USDG: tokenInfo(USDG) }; const m = readToken()?.address; if (typeof m === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m) && !ZERO_ADDR.test(m)) o.MARQ = tokenInfo(m); return o; };
  /** per-token totals {SYM:{address,decimals,amount,count}}; ETH, USDG (+MARQ when launched) always present */
  function sumTokens(rows) {
    const out = {};
    for (const [sym, tk] of Object.entries(baseTotals())) out[sym] = { address: tk.address, decimals: tk.decimals, amount: '0', count: 0 };
    for (const x of rows) { const tk = tokenInfo(x.token); const o = out[tk.symbol]; if (!o) continue; o.amount = (BigInt(o.amount) + BigInt(x.amount)).toString(); o.count++; }
    return out;
  }
  app.get('/api/tips', async (req, reply) => {
    const id = String(req.query.stream || '');
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_stream' });
    const row = q.get.get(id);
    if (!row) return goneReply(reply, id);
    const tot = await chain.totals();
    if (tot.unavailable) return tipUnavailable(tot.reason);
    const gross = await chain.receivedFor(id);
    if (gross === null) return tipUnavailable();
    const rows = filteredTips(id, row.wallet);
    const totals = sumTokens(rows);
    return { stream: id, streamIdHash: streamIdHash(id), wallet: row.wallet, totalWei: totals.ETH.amount, count: rows.length, totals, asOfBlock: tot.asOfBlock,
      grossUnfilteredWei: gross, grossLabel: 'gross (unfiltered)', tips: rows.slice(0, 50).map(tipRow) };
  });
  app.get('/api/tips/top', async () => {
    const tot = await chain.totals();
    if (tot.unavailable) return tipUnavailable(tot.reason);
    const out = [];
    for (const r of db.prepare('SELECT id,title,wallet FROM streams WHERE public=1 AND unlisted=0 AND wallet IS NOT NULL').all()) {
      const rows = filteredTips(r.id, r.wallet); if (!rows.length) continue;
      const totals = sumTokens(rows);
      out.push({ id: r.id, title: r.title, totalWei: totals.ETH.amount, count: rows.length, totals, team: isTeam(r.wallet), _w: BigInt(totals.ETH.amount) });
    }
    out.sort((a, b) => (a._w < b._w ? 1 : a._w > b._w ? -1 : (b.count - a.count)));
    const known = new Map();
    for (const r of db.prepare('SELECT id,wallet FROM streams WHERE public=1 AND unlisted=0').all()) known.set(streamIdHash(r.id), r);
    const recent = db.prepare('SELECT * FROM tips ORDER BY block DESC, logIndex DESC LIMIT 50').all().map((x) => {
      const k = known.get(x.streamId);
      return { txHash: x.txHash, block: x.block, streamId: x.streamId, id: k ? k.id : null, from: x.from, streamer: x.streamer, amount: x.amount, token: tokenPub(tokenInfo(x.token)), t: x.t,
        team: isTeam(x.from) || isTeam(x.streamer), counted: !!(k && k.wallet && k.wallet.toLowerCase() === x.streamer.toLowerCase() && tokenInfo(x.token).known && !isDust(x)),
        ...(isDust(x) ? { reason: 'dust' } : {}) };
    });
    return { asOfBlock: tot.asOfBlock, recent, note: 'on-chain tips to the stream wallet, unfiltered for self-tips', top: out.slice(0, 20).map(({ _w, ...x }) => x) };
  });

  // ---------- holder (post-T0) ----------
  const thresholdOf = () => { try { return BigInt(readToken()?.holderThreshold ?? 0); } catch { return 0n; } };
  app.get('/api/holder/:wallet', async (req, reply) => {
    const w = req.params.wallet;
    if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return reply.code(400).send({ error: 'bad_wallet' });
    const b = await chain.holderBalance(w);
    if (!b.launched) return { holder: false, launched: false };
    if (b.unavailable) return { unavailable: true, launched: true };
    const th = thresholdOf();
    return { holder: b.balance >= th && b.balance > 0n, threshold: th.toString(), balance: b.balance.toString() };
  });
  const claimMsg = (id, n) => `PEEKMARQUEE holder check\nstream:${id}\nnonce:${n}`;
  app.post('/api/s/:id/nonce', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (!authOwner(req, r)) return reply.code(401).send({ error: 'bad_token' });
    const n = b64u(12); nonces.set(r.id, { n, exp: now() + 10 * 60e3 });
    return { nonce: n, message: claimMsg(r.id, n) };
  });
  app.post('/api/s/:id/claim', async (req, reply) => {
    const r = getVisible(req.params.id, reply); if (!r) return;
    if (!authOwner(req, r)) return reply.code(401).send({ error: 'bad_token' });
    if (!readToken()?.launched) return reply.code(409).send({ holder: false, launched: false });
    const nn = nonces.get(r.id);
    if (!nn || nn.exp < now() || typeof req.body?.sig !== 'string') return reply.code(400).send({ error: 'bad_nonce' });
    if (!r.wallet) return reply.code(400).send({ error: 'no_wallet' });
    let ok = false;
    try { ok = await verifyMessage({ address: r.wallet, message: claimMsg(r.id, nn.n), signature: req.body.sig }); } catch {}
    if (!ok) return reply.code(401).send({ error: 'bad_signature' });
    const b = await chain.holderBalance(r.wallet);
    if (b.unavailable) return reply.code(503).send({ unavailable: true, msg: "can't verify right now, try again" });
    const th = thresholdOf();
    if (!(b.balance >= th && b.balance > 0n)) return reply.code(403).send({ holder: false, threshold: th.toString(), balance: b.balance.toString() });
    nonces.delete(r.id);
    db.prepare('INSERT OR REPLACE INTO holders(wallet,streamId,verifiedAt,balance) VALUES(?,?,?,?)').run(r.wallet, r.id, now(), b.balance.toString());
    db.prepare('UPDATE streams SET holder=1, expiresAt=CASE WHEN endedAt IS NULL THEN NULL ELSE endedAt+? END WHERE id=?').run(30 * 24 * H, r.id);
    broadcastMeta(r.id);
    return { holder: true, expiresInDays: 30 };
  });

  // ---------- internal admin (loopback only, never proxied by nginx) ----------
  app.all('/internal/admin/:cmd', async (req, reply) => {
    const ra = req.raw.socket.remoteAddress || '';
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra) || req.headers['x-forwarded-for'] || !bearer || !safeEq(bearer, adminToken)) return reply.code(404).send({ error: 'not_found' });
    const cmd = req.params.cmd, id = req.body?.id || req.query.id;
    const need = () => { const r = id && q.get.get(id); if (!r) { reply.code(404).send({ error: 'not_found' }); return null; } return r; };
    if (cmd === 'list') return db.prepare('SELECT * FROM streams ORDER BY createdAt DESC LIMIT 200').all().map((r) => ({ ...metaOf(r), unlisted: !!r.unlisted, replayOff: !!r.replayOff, reportCount: r.reportCount, expiresAt: r.expiresAt }));
    if (cmd === 'reports') return db.prepare('SELECT * FROM reports ORDER BY t DESC LIMIT 200').all();
    if (cmd === 'show') { const r = need(); return r && { ...metaOf(r), unlisted: !!r.unlisted, replayOff: !!r.replayOff, reportCount: r.reportCount, reports: db.prepare('SELECT reason,t FROM reports WHERE streamId=?').all(r.id) }; }
    if (cmd === 'delete') { const r = need(); if (!r) return; removeStream(r.id, 'deleted'); return { ok: true }; }
    if (cmd === 'unlist' || cmd === 'relist' || cmd === 'restore') {
      const r = need(); if (!r) return;
      if (cmd === 'unlist') db.prepare('UPDATE streams SET unlisted=1 WHERE id=?').run(r.id);
      if (cmd === 'relist') db.prepare('UPDATE streams SET unlisted=0, reportCount=0 WHERE id=?').run(r.id);
      if (cmd === 'restore') db.prepare('UPDATE streams SET replayOff=0 WHERE id=?').run(r.id);
      broadcastMeta(r.id); return { ok: true };
    }
    if (cmd === 'recount') { // recompute aggregates from surviving PUBLIC streams only (deleted streams' counts are dropped)
      const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(toolCalls),0) tc, COALESCE(SUM(red+redServer),0) sh, COALESCE(SUM(MAX(0,COALESCE(lastFrameAt,0)-COALESCE(startedAt,0))),0) ms FROM streams WHERE public=1 AND startedAt IS NOT NULL').get();
      const set = db.prepare('UPDATE counters SET v=? WHERE k=?');
      set.run(r.n, 'streamsTotal'); set.run(r.tc, 'toolCalls'); set.run(r.sh, 'secretsHidden'); set.run(r.ms, 'msStreamed');
      return { ok: true, streamsTotal: r.n, toolCalls: r.tc, secretsHidden: r.sh, msStreamed: r.ms };
    }
    if (cmd === 'sweep') { await sweep(); return { ok: true }; }
    return reply.code(404).send({ error: 'not_found' });
  });

  // ---------- WebSocket ingest ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const sendJson = (ws, o2) => { if (ws.readyState === 1) ws.send(JSON.stringify(o2)); };
  const wsIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  app.server.on('upgrade', (req, socket, head) => {
    const m = /^\/ingest\/([^/?]+)/.exec(req.url || '');
    if (!m) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onIngest(ws, req, m[1]));
  });

  function onIngest(ws, req, id) {
    const fail = (code, errCode, msg) => { sendJson(ws, { type: 'error', code: errCode, msg }); ws.close(code, errCode); };
    const r = ID_RE.test(id) ? q.get.get(id) : null;
    if (!r) return fail(4404, 'stream_closed', 'unknown stream');
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!bearer || !safeEq(sha(bearer), r.tokenHash)) return fail(4401, 'bad_token', 'bad token');
    if (r.endedAt) return fail(4410, 'stream_closed', 'stream ended');
    const ip = wsIp(req);
    const active = [...conns.values()].filter((c) => c.ip === ip && c.id !== id).length;
    if (active >= cfg.maxActivePerIp) return fail(4429, 'rate_limited', 'too many active streams');
    const old = conns.get(id);
    if (old) { try { old.ws.close(1000, 'replaced'); } catch {} }
    const c = { id, ws, ip, tokens: cfg.ingestBurst, tAt: now(), win: [], unacked: 0, ackTimer: null, limitedAt: 0 };
    conns.set(id, c);
    log.info({ id, code: 'ingest_open' }, 'ingest open');
    const ack = () => { clearTimeout(c.ackTimer); c.ackTimer = null; c.unacked = 0; const cur = q.get.get(id); if (cur) sendJson(ws, { type: 'ack', seq: cur.lastSeq }); };
    sendJson(ws, { type: 'viewers', n: vcount(id) });
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    const ping = setInterval(() => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }, 30000); ping.unref();

    ws.on('message', (raw, isBinary) => {
      const size = raw.length;
      if (size > MAX_FRAME) { log.warn({ id, size, code: 'too_large' }, 'frame too large'); return fail(1009, 'too_large', 'frame exceeds 32 KB'); }
      const t = now();
      // token bucket + byte window
      c.tokens = Math.min(cfg.ingestBurst, c.tokens + ((t - c.tAt) / 1000) * cfg.ingestRate); c.tAt = t;
      c.win = c.win.filter((x) => t - x[0] < 10 * 60e3);
      const bytes = c.win.reduce((a, x) => a + x[1], 0);
      if (c.tokens < 1 || bytes + size > cfg.ingestBytes) {
        log.warn({ id, size, code: 'rate_limited' }, 'ingest rate limited');
        if (t - c.limitedAt > 1000) { c.limitedAt = t; sendJson(ws, { type: 'error', code: 'rate_limited', msg: 'slow down' }); }
        return;
      }
      c.tokens -= 1; c.win.push([t, size]);
      let ev;
      try { ev = JSON.parse(isBinary ? raw : raw.toString('utf8')); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      const cur = q.get.get(id);
      if (!cur || cur.endedAt) return fail(4410, 'stream_closed', 'stream closed');
      const vm = validateClientMessage(ev);
      if (!vm.ok) { log.debug({ id, code: 'bad_frame', why: vm.error }, 'invalid frame'); return; }
      if (vm.kind === 'resume') return ack();
      if (ev.seq <= cur.lastSeq) { // duplicate from resend: already stored
        if (++c.unacked >= 20) ack(); else if (!c.ackTimer) c.ackTimer = setTimeout(ack, cfg.ackMs);
        return;
      }
      const rd = redactData(ev.data ?? {});
      const redCli = Number.isFinite(ev.red) ? Math.max(cur.red, Math.floor(ev.red)) : cur.red;
      const redServer = cur.redServer + rd.count;
      const toolCalls = cur.toolCalls + (ev.type === 'tool_call' ? 1 : 0);
      const edits = cur.edits + (ev.type === 'edit' ? 1 : 0);
      const stored = { v: 1, seq: ev.seq, t: Number.isFinite(ev.t) ? ev.t : t, type: ev.type, data: rd.value, red: redCli, ...(redServer > 0 ? { redServer } : {}) };
      const line = JSON.stringify(stored);
      try { fs.appendFileSync(filePath(id), line + '\n'); } catch (e) { log.error({ id, code: 'disk_write_failed' }, 'disk write failed'); return; }
      if (cur.public) { // --private streams never enter public aggregates (deleted public streams keep their counters, no content)
        if (cur.lastFrameAt === null || cur.startedAt === null) bump('streamsTotal', 1);
        if (cur.lastFrameAt) bump('msStreamed', Math.min(t - cur.lastFrameAt, 60e3));
        bump('toolCalls', toolCalls - cur.toolCalls); bump('secretsHidden', (redCli - cur.red) + rd.count);
      }
      q.frame.run(ev.seq, t, t, redCli, redServer, toolCalls, edits, id);
      if (ev.type === 'hello' && typeof ev.data?.cli === 'string') db.prepare('UPDATE streams SET cli=? WHERE id=?').run(ev.data.cli.slice(0, 20), id);
      const vs = viewers.get(id);
      if (vs) for (const res of vs) sse(res, ev.type, line, ev.seq);
      dirty.add(id);
      log.debug({ id, seq: ev.seq, size, type: ev.type }, 'frame');
      if (ev.type === 'end') { finalize(id, 'end'); ack(); return; }
      if (++c.unacked >= 20) ack(); else if (!c.ackTimer) c.ackTimer = setTimeout(ack, cfg.ackMs);
    });
    ws.on('close', () => {
      clearInterval(ping); clearTimeout(c.ackTimer);
      if (conns.get(id) === c) conns.delete(id);
      log.info({ id, code: 'ingest_close' }, 'ingest closed');
      broadcastMeta(id);
    });
    ws.on('error', () => {});
  }

  // ---------- lifecycle ----------
  let sweepTimer = null;
  async function listen() {
    await app.listen({ host: cfg.host, port: cfg.port });
    chain.start();
    if (cfg.sweepMs > 0) { sweepTimer = setInterval(() => sweep().catch(() => {}), cfg.sweepMs); sweepTimer.unref(); }
    return app.server.address();
  }
  async function close() {
    clearInterval(sweepTimer); clearInterval(metaTimer); chain.stop();
    for (const c of conns.values()) try { c.ws.terminate(); } catch {}
    for (const s of viewers.values()) for (const res of s) try { res.end(); } catch {}
    wss.close();
    await app.close();
    db.close();
  }
  if (!globalThis.__pmqSighup) { globalThis.__pmqSighup = true; process.on('SIGHUP', () => {}); } // reload = no-op: token/deployments re-read on mtime
  return { app, db, listen, close, sweep, chain, cfg, redactSource, adminToken };
}
