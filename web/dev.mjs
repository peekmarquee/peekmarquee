// Dev server for web/dist. NOT deployed.
//   node dev.mjs --mock            → mocked /api/*; pick a state with ?scenario=live|replay|empty|rpcdown|launched|t0|noapi|expired|zero
//   node dev.mjs                   → proxies /api/* to API_UPSTREAM (default http://127.0.0.1:4840)
// PORT env (default 4841). Mock data below is a dev fixture only; it never ships in dist/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MOCK = process.argv.includes('--mock');
const UP = new URL(process.env.API_UPSTREAM || 'http://127.0.0.1:4840');
const PORT = Number(process.env.PORT || 4841);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p.startsWith('/s/')) p = '/s/index.html';
  let f = path.join(dist, p);
  if (!f.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': types['.html'] }); fs.createReadStream(path.join(dist, '404.html')).pipe(res); return; }
  // token.json scenarios
  const sc = u.searchParams.get('scenario');
  if (MOCK && p === '/token.json' && (sc === 'launched' || sc === 't0')) {
    const t = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (sc === 'launched') Object.assign(t, { address: '0x1111111111111111111111111111111111111111', launched: true });
    if (sc === 't0') t.launch_at = new Date(Date.now() + 5000).toISOString();
    res.writeHead(200, { 'content-type': types['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(t)); return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}

function proxy(req, res) {
  const r = http.request({ host: UP.hostname, port: UP.port, path: req.url, method: req.method, headers: { ...req.headers, host: UP.host } }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  r.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"upstream_down"}'); });
  req.pipe(r);
}

// ---------------- mock ----------------
const now = () => Date.now();
const T0 = now() - 47 * 60e3;
const meta = (id, o = {}) => ({ id, title: 'Building PEEKMARQUEE: landing', agent: 'claude', live: true, startedAt: T0, endedAt: null, viewers: 7, toolCalls: 41, edits: 9, red: 3, wallet: '0x806a315f23C241692e16fcC563Ff67b4E11BEf73', public: true, replayUntil: null, replay: true, chatOn: true, chatSlowSec: 0, ...o });
const script = [
  ['prompt', { text: 'Make the countdown show UTC only and add a copy button to the CA.' }],
  ['status', { state: 'thinking' }],
  ['text', { text: 'I will update `src/js/core.js` to format the launch time in **UTC** and wire the copy button.' }],
  ['tool_call', { id: 't1', tool: 'Read', summary: 'web/src/js/core.js', args: { file_path: 'web/src/js/core.js' } }],
  ['tool_result', { forId: 't1', text: "export const utc = (ms) => {\n  const d = new Date(ms);\n  ...", bytes: 18233, truncated: true, isError: false, hidden: null }],
  ['edit', { path: 'web/src/js/core.js', added: 12, removed: 3, snippet: '-  return d.toLocaleString();\n+  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;\n+  return `${hm} UTC`;' }],
  ['tool_call', { id: 't2', tool: 'Bash', summary: 'npm test', args: { command: 'npm test' } }],
  ['tool_result', { forId: 't2', text: '✔ countdown formats UTC (3ms)\n✔ copy button writes CA (1ms)\nℹ tests 2  pass 2  fail 0', bytes: 120, truncated: false, isError: false, hidden: null }],
  ['tool_call', { id: 't3', tool: 'Read', summary: '.env', args: { file_path: '.env' } }],
  ['tool_result', { forId: 't3', text: '[file hidden: .env]', bytes: 0, truncated: false, isError: false, hidden: 'sensitive_path' }],
  ['tool_call', { id: 't4', tool: 'Bash', summary: 'curl -s https://api.example.com -H "Authorization: Bearer [redacted:token]"', args: {} }],
  ['tool_result', { forId: 't4', text: '{"ok":true,"key":"[redacted:api_key]"}', bytes: 40, truncated: false, isError: false, hidden: null }],
  ['tool_call', { id: 't5', tool: 'Grep', summary: 'launch_at', args: { pattern: 'launch_at' } }],
  ['tool_result', { forId: 't5', text: 'web/token.json:5: "launch_at": "2026-11-06T15:00:00Z"', bytes: 60, truncated: false, isError: false, hidden: null }],
  ['status', { state: 'idle' }],
];
let seqBase = 0;
const USDG = { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 };
const ETHT = { address: null, symbol: 'ETH', decimals: 18 };
const chatMsgs = [
  { id: 1, nick: 'ana', text: 'what is it building?', system: false, t: Date.now() - 300e3 },
  { id: 2, nick: null, text: '0x806a…Ef73 tipped 5 USDG', system: true, tx: '0x' + 'ab'.repeat(32), t: Date.now() - 200e3 },
  { id: 3, nick: 'kei', text: 'nice redaction chips [link removed]', system: false, t: Date.now() - 100e3 },
];
const chatClients = new Set();
let chatId = 10;
function sseMock(req, res, id, sc, from) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
  const ended = sc === 'replay';
  const m = ended ? meta(id, { live: false, endedAt: now() - 20 * 60e3, replayUntil: now() + 23 * 3600e3, viewers: 0 }) : meta(id);
  res.write(`retry: 3000\nevent: meta\ndata: ${JSON.stringify(m)}\n\n`);
  let seq = 0; let red = 0;
  const send = (type, data) => {
    seq++; if (from && seq < from) return;
    if (/redacted|hidden/.test(JSON.stringify(data))) red++;
    const ev = { v: 1, seq, t: now() - (ended ? 25 * 60e3 : 0), type, data, red };
    res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  send('hello', { cli: '0.1.0', agent: 'claude', title: m.title, wallet: m.wallet, replay: true, public: true });
  for (const [t, d] of script) send(t, d);
  if (ended) { send('end', { reason: 'ctrl_c' }); return; }
  res.write(`event: viewers\ndata: {"n":7}\n\n`);
  for (const c of chatMsgs) res.write(`event: chat\ndata: ${JSON.stringify(c)}\n\n`);
  chatClients.add(res); req.on('close', () => chatClients.delete(res));
  let i = 0;
  const h = setInterval(() => { const [t, d] = script[i++ % script.length]; send(t, d); }, 1800);
  req.on('close', () => clearInterval(h));
}

function mock(req, res, u) {
  const sc = u.searchParams.get('scenario') || 'live';
  const j = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  if (sc === 'noapi') { res.destroy(); return; }
  const p = u.pathname;
  const ID = 'k7m2q4pz9d';
  if (p === '/api/live') return j(200, sc === 'live' || sc === 'rpcdown' || sc === 'launched' || sc === 't0' ? [{ id: ID, title: 'Building PEEKMARQUEE: landing', agent: 'claude', startedAt: T0, viewers: 7, toolCalls: 41, red: 3, wallet: true, featured: false }, { id: 'p3x8w1n0qa', title: 'Untitled session', agent: 'claude', startedAt: now() - 8 * 60e3, viewers: 1, toolCalls: 6, red: 0, wallet: false, featured: false }] : []);
  if (p === '/api/recent') return j(200, sc === 'empty' || sc === 'zero' ? [] : [{ id: 'r9d2m7c4ve', title: 'Building PEEKMARQUEE: server', agent: 'claude', startedAt: now() - 3 * 3600e3, endedAt: now() - 20 * 60e3, viewers: 0, toolCalls: 120, red: 11, wallet: true, replayUntil: now() + 23 * 3600e3 }]);
  if (p === '/api/stats') return j(200, { streamsTotal: sc === 'empty' || sc === 'zero' ? 0 : 5, streamsLive: 2, hoursStreamed: 6.4, secretsHidden: 37, toolCalls: 412, tips: sc === 'rpcdown' ? { unavailable: true, lastGoodAt: now() - 600e3 } : sc === 'zero' ? { count: 0, totalWei: '0', asOfBlock: 106176589 } : { count: 3, totalWei: '7000000000000000', asOfBlock: 106176589, tokens: { ETH: { address: null, decimals: 18, amount: '7000000000000000', count: 2 }, USDG: { address: USDG.address, decimals: 6, amount: '5000000', count: 1 } } } });
  if (p === '/api/tips/top') return sc === 'rpcdown' ? j(200, { unavailable: true, lastGoodAt: now() - 600e3 }) : j(200, { asOfBlock: 106176589, top: [{ id: ID, title: 'Building PEEKMARQUEE: landing', totalWei: '1000000000000000', count: 2, totals: { ETH: { address: null, decimals: 18, amount: '1000000000000000', count: 1 }, USDG: { address: USDG.address, decimals: 6, amount: '5000000', count: 1 } } }], recent: sc === 'zero' ? [] : [{ txHash: '0x' + 'ab'.repeat(32), block: 106176500, streamId: '0x' + '11'.repeat(32), id: ID, from: '0x806a315f23C241692e16fcC563Ff67b4E11BEf73', streamer: '0x806a315f23C241692e16fcC563Ff67b4E11BEf73', amount: '5000000', token: USDG, counted: true, team: true, t: now() - 300e3 }, { txHash: '0x' + 'cd'.repeat(32), block: 106176400, streamId: '0x' + '11'.repeat(32), id: ID, from: '0x2222222222222222222222222222222222222222', streamer: '0x806a315f23C241692e16fcC563Ff67b4E11BEf73', amount: '1000000000000000', token: ETHT, counted: true, team: false, t: now() - 900e3 }] });
  if (p === '/api/tips') return sc === 'rpcdown' ? j(200, { unavailable: true }) : j(200, { stream: u.searchParams.get('stream'), totalWei: '1000000000000000', count: 2, totals: { ETH: { address: null, decimals: 18, amount: '1000000000000000', count: 1 }, USDG: { address: USDG.address, decimals: 6, amount: '5000000', count: 1 } }, tips: [{ txHash: '0x' + 'ab'.repeat(32), from: '0x2222222222222222222222222222222222222222', amount: '5000000', token: USDG }] });
  let m;
  if ((m = p.match(/^\/api\/s\/([^/]+)\/chat$/))) {
    if (req.method === 'GET') return j(200, { on: true, slowSec: 0, messages: chatMsgs });
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (!b.nick || b.nick.length > 24) return j(400, { error: 'bad_nick' });
      if (!b.text || b.text.length > 280) return j(400, { error: 'bad_text' });
      if (/slow/.test(b.text)) return j(429, { error: 'slow_mode', retryAfterSec: 9 });
      const msg = { id: ++chatId, nick: b.nick, text: b.text.replace(/0x[0-9a-fA-F]{6,}|https?:\/\/\S+/g, '[link removed]'), system: false, t: Date.now() };
      chatMsgs.push(msg); for (const c of chatClients) c.write(`event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
      j(200, msg);
    }); return;
  }
  if (p.match(/^\/api\/s\/[^/]+\/chat\/[^/]+\/report$/)) return j(200, { ok: true });
  if (p.match(/^\/api\/s\/[^/]+\/chat\/settings$/)) return j(200, { on: true, slowSec: 15 });
  if (p.match(/^\/api\/s\/[^/]+\/chat\/[^/]+$/) && req.method === 'DELETE') return j(200, { ok: true });
  if ((m = p.match(/^\/api\/s\/([^/]+)$/))) {
    if (sc === 'expired' || m[1] === 'expired0000') return j(410, { error: 'gone', reason: 'expired', msg: 'This stream has expired.' });
    if (m[1] === 'r9d2m7c4ve' || sc === 'replay') return j(200, meta(m[1], { live: false, endedAt: now() - 20 * 60e3, replayUntil: now() + 23 * 3600e3, viewers: 0, title: 'Building PEEKMARQUEE: server' }));
    return j(200, meta(m[1], sc === 'review' ? { underReview: true } : {}));
  }
  if ((m = p.match(/^\/api\/s\/([^/]+)\/events$/))) return sseMock(req, res, m[1], m[1] === 'r9d2m7c4ve' ? 'replay' : sc, Number(u.searchParams.get('from') || 0));
  if (p.match(/^\/api\/s\/[^/]+\/report$/)) return j(200, { ok: true });
  if (p.match(/^\/api\/streams\//) && req.method === 'DELETE') return j(200, { ok: true });
  if (p === '/api') return j(200, { routes: ['GET /api/live'] });
  return j(404, { error: 'not_found' });
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) return MOCK ? mock(req, res, u) : proxy(req, res);
  serveStatic(req, res, u);
}).listen(PORT, '127.0.0.1', () => console.log(`web dev on http://127.0.0.1:${PORT} (${MOCK ? 'mock api' : 'proxy → ' + UP.href})`));
