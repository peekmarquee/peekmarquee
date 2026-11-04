import { createApp } from '../src/app.js';
import { makeEvent, makeResume } from '../../shared/schema/index.js';
import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

export { makeEvent, makeResume };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmq-'));
  const dataDir = path.join(dir, 'data'), webDir = path.join(dir, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  if (opts.token !== false) fs.writeFileSync(path.join(webDir, 'token.json'), JSON.stringify({ address: '0x' + '0'.repeat(40), symbol: 'MARQ', launched: false }));
  let logs = '';
  const logStream = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });
  const s = await createApp({ dataDir, webDir, port: 0, logStream, chainPollMs: 0, sweepMs: 0, apiPerMin: 100000, rpcUrl: 'http://127.0.0.1:1', rpcTimeoutMs: 800, ...opts });
  const addr = await s.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    ...s, base, port: addr.port, dir, dataDir, webDir, logs: () => logs,
    async post(p, body, headers = {}) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; },
    async get(p, headers = {}) { const r = await fetch(base + p, { headers }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, body: j, text: t, headers: r.headers }; },
    async del(p, headers = {}) { const r = await fetch(base + p, { method: 'DELETE', headers }); return { status: r.status, body: await r.json().catch(() => null) }; },
    async stream(over = {}) {
      const r = await this.post('/api/streams', { title: 'Building a thing', agent: 'claude', public: true, replay: true, ...over });
      if (r.status !== 200) throw new Error('create failed ' + JSON.stringify(r));
      return r.body;
    },
    async stop() { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Scripted CLI: ring buffer, resume, resend from ack. */
export class FakeCli {
  constructor(srv, st) { this.srv = srv; this.st = st; this.seq = 0; this.ring = []; this.acked = 0; this.msgs = []; this.closes = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ingest/${this.st.id}`, { headers: { Authorization: 'Bearer ' + (this.token ?? this.st.ingestToken) } });
      this.ws = ws;
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); this.msgs.push(m); if (m.type === 'ack') this.acked = Math.max(this.acked, m.seq); });
      ws.on('close', (code) => this.closes.push(code));
      ws.on('error', () => {});
      ws.on('open', () => resolve(ws));
      ws.on('close', () => resolve(ws));
    });
  }
  async resume() {
    await this.connect();
    this.ws.send(JSON.stringify(makeResume(this.acked)));
    await sleep(80);
    for (const ev of this.ring) if (ev.seq > this.acked) this.ws.send(JSON.stringify(ev));
  }
  send(type, data, red = 0) {
    const ev = makeEvent(++this.seq, type, data, red);
    this.ring.push(ev);
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(ev));
    return ev;
  }
  rawSend(s) { this.ws.send(s); }
  close() { try { this.ws.terminate(); } catch {} }
  waitClose(ms = 1500) { return new Promise((r) => { if (this.closes.length) return r(this.closes[0]); const t = setTimeout(() => r(null), ms); this.ws.once('close', (c) => { clearTimeout(t); r(c); }); }); }
}

/** SSE client; collects parsed events. */
export function sseClient(base, id, { lastEventId, from, ip } = {}) {
  const events = [];
  const u = new URL(`${base}/api/s/${id}/events${from !== undefined ? '?from=' + from : ''}`);
  const headers = {}; if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  if (ip) headers['x-forwarded-for'] = ip;
  let buf = '', status = 0, resolveOpen; const opened = new Promise((r) => { resolveOpen = r; });
  const req = http.get(u, { headers }, (res) => {
    status = res.statusCode; resolveOpen();
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { event: 'message' }; let data = '';
        for (const l of block.split('\n')) { if (l.startsWith('id: ')) ev.id = Number(l.slice(4)); else if (l.startsWith('event: ')) ev.event = l.slice(7); else if (l.startsWith('data: ')) data += l.slice(6); }
        if (data) { try { ev.data = JSON.parse(data); } catch { ev.data = data; } events.push(ev); }
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => resolveOpen());
  return { events, opened, get status() { return status; }, close: () => req.destroy(), seqs: () => events.filter((e) => e.id !== undefined).map((e) => e.id) };
}
