// Relay client: REST bootstrap + WebSocket ingest with ring buffer, resume and backoff.
// The CLI accepts exactly three message types from the relay (ack / viewers / error) and executes nothing it receives.

import { EventEmitter } from 'node:events';
import { LIMITS, makeResume, parseServerMessage } from './shared/schema/index.js';
import { fitEvent } from './events.js';

export function relayBases(relay) {
  const u = new URL(relay);
  const ws = new URL(u); ws.protocol = u.protocol === 'ws:' || u.protocol === 'http:' ? 'ws:' : 'wss:';
  const http = new URL(u); http.protocol = ws.protocol === 'ws:' ? 'http:' : 'https:';
  const strip = (x) => x.toString().replace(/\/+$/, '').replace(/\/ingest(\/.*)?$/, '');
  return { ws: strip(ws), http: strip(http) };
}

export class ApiError extends Error {
  constructor(status, body) { super(`relay answered ${status}: ${body?.error || body?.msg || body?.message || 'error'}`); this.status = status; this.body = body; }
}

export async function createStream({ http, title, agent, wallet, isPublic, replay, fetchImpl = fetch }) {
  const res = await fetchImpl(`${http}/api/streams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, agent, wallet: wallet || null, public: isPublic, replay }),
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, body);
  if (!body || typeof body.id !== 'string' || typeof body.ingestToken !== 'string') throw new ApiError(res.status, { error: 'unexpected response' });
  return body;
}

export async function deleteStream({ http, id, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${http}/api/streams/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

/**
 * Emits: 'state' ('connecting'|'connected'|'reconnecting'), 'viewers' (n), 'fatal' (Error), 'warn' (string).
 */
export class RelayClient extends EventEmitter {
  constructor({ wsUrl, token, WebSocketImpl, backoffMs = [1000, 2000, 4000, 8000, 16000, 30000], resyncTimeoutMs = 3000 }) {
    super();
    this.wsUrl = wsUrl; this.token = token; this.WS = WebSocketImpl;
    this.backoff = backoffMs; this.resyncTimeoutMs = resyncTimeoutMs;
    this.ring = [];          // { seq, ev, json }
    this.lastAcked = 0;
    this.sentUpTo = 0;
    this.ws = null;
    this.ready = false;
    this.first = true;
    this.attempt = 0;
    this.closing = false;
    this.slowUntil = 0;
    this.paceTimer = null;
    this.pingTimer = null;
    this.resyncTimer = null;
    this.reconnectTimer = null;
    this.awaitingAck = false;
  }

  start() { this.connect(); }

  connect() {
    if (this.closing) return;
    this.emit('state', this.first ? 'connecting' : 'reconnecting');
    let ws;
    try { ws = new this.WS(this.wsUrl, { headers: { Authorization: `Bearer ${this.token}` }, maxPayload: 64 * 1024 }); } catch (e) { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.emit('state', 'connected');
      this.pingTimer = setInterval(() => { try { ws.ping(); } catch { /* ignore */ } }, 25_000);
      this.pingTimer.unref?.();
      if (this.first) { this.first = false; this.ready = true; this.sentUpTo = this.lastAcked; this.flush(); return; }
      this.ready = false;
      this.awaitingAck = true;
      ws.send(JSON.stringify(makeResume(this.lastAcked)));
      this.resyncTimer = setTimeout(() => this.resynced(), this.resyncTimeoutMs);
    });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', (code) => this.onClose(code));
    ws.on('error', () => { /* 'close' follows */ });
  }

  onMessage(data) {
    const m = parseServerMessage(data); // anything else is ignored on purpose
    if (!m) return;
    if (m.type === 'ack') {
      if (m.seq > this.lastAcked) this.lastAcked = m.seq;
      this.ring = this.ring.filter((r) => r.seq > this.lastAcked);
      if (this.awaitingAck) { this.sentUpTo = this.lastAcked; this.resynced(); }
      this.emit('ack', m.seq);
    } else if (m.type === 'viewers') {
      this.emit('viewers', m.n);
    } else if (m.type === 'error') {
      if (m.code === 'rate_limited') { this.slowUntil = Date.now() + 3000; this.emit('warn', 'relay asked to slow down'); }
      else if (m.code === 'too_large') { this.shrinkRing(); }
      else if (m.code === 'bad_token' || m.code === 'stream_closed') {
        this.closing = true;
        this.emit('fatal', new Error(`relay: ${m.code}${m.msg ? ` (${m.msg})` : ''}`));
        this.terminate();
      } else this.emit('warn', `relay error: ${m.code}`);
    }
  }

  resynced() {
    clearTimeout(this.resyncTimer);
    if (!this.awaitingAck) return;
    this.awaitingAck = false;
    this.ready = true;
    this.sentUpTo = this.lastAcked;
    this.flush();
  }

  shrinkRing() {
    for (const r of this.ring) {
      if (Buffer.byteLength(r.json) > LIMITS.FRAME_TARGET_BYTES) { r.ev = fitEvent(r.ev); r.json = JSON.stringify(r.ev); }
    }
  }

  onClose(code) {
    clearInterval(this.pingTimer); clearTimeout(this.resyncTimer);
    this.ready = false; this.awaitingAck = false; this.ws = null;
    if (this.closing) { this.emit('closed'); return; }
    if (code === 4401) { this.closing = true; this.emit('fatal', new Error('relay rejected the ingest token')); return; }
    if (code === 1009) this.shrinkRing();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closing) return;
    const ms = this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    this.attempt++;
    this.emit('state', 'reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), ms);
    this.reconnectTimer.unref?.();
  }

  send(ev) {
    this.ring.push({ seq: ev.seq, ev, json: JSON.stringify(ev) });
    if (this.ring.length > LIMITS.RING_BUFFER_EVENTS) this.ring.shift();
    this.flush();
  }

  flush() {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;
    const slow = Date.now() < this.slowUntil;
    for (const r of this.ring) {
      if (r.seq <= this.sentUpTo) continue;
      try { this.ws.send(r.json); } catch { return; }
      this.sentUpTo = r.seq;
      if (slow) { // pace: one frame per 250 ms while the relay asked us to slow down
        if (!this.paceTimer) this.paceTimer = setTimeout(() => { this.paceTimer = null; this.flush(); }, 250);
        return;
      }
    }
  }

  /** Wait until everything sent so far is acked (or timeout), then close. */
  async finish(timeoutMs = 3000) {
    const last = this.ring.length ? this.ring[this.ring.length - 1].seq : this.lastAcked;
    const t0 = Date.now();
    while (this.lastAcked < last && Date.now() - t0 < timeoutMs && this.ready) await new Promise((r) => setTimeout(r, 50));
    this.closing = true;
    this.terminate(true);
  }

  terminate(graceful = false) {
    clearTimeout(this.reconnectTimer); clearTimeout(this.paceTimer); clearInterval(this.pingTimer); clearTimeout(this.resyncTimer);
    try { graceful ? this.ws?.close(1000) : this.ws?.terminate(); } catch { /* ignore */ }
  }
}
