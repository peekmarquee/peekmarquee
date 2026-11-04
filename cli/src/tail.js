// Streaming JSONL tail: fs.watch on the folder + 1 s stat polling as backup.
// A line is only handed out once its "\n" has arrived (the file is being written while we read).
// Lines are accumulated as Buffers and decoded once, so a 1.5 MB line is turned into a string exactly once.

import fs from 'node:fs';
import path from 'node:path';

const CHUNK = 256 * 1024;
const MAX_LINE = 8 * 1024 * 1024; // lines above this are skipped without decoding

export class Tailer {
  /**
   * @param {{file:string, fromStart?:boolean, pollMs?:number, onLine:(line:string)=>void, onSkip?:(bytes:number)=>void}} o
   */
  constructor(o) {
    this.file = o.file;
    this.fromStart = !!o.fromStart;
    this.pollMs = o.pollMs || 1000;
    this.onLine = o.onLine;
    this.onSkip = o.onSkip || (() => {});
    this.offset = 0;
    this.parts = []; // Buffers of the current unterminated line
    this.partLen = 0;
    this.discarding = false; // inside an oversized line (or a half line at start): drop until "\n"
    this.busy = false;
    this.again = false;
    this.timer = null;
    this.watcher = null;
    this.lastGrowth = Date.now();
    this.closed = false;
  }

  async start() {
    const st = await fs.promises.stat(this.file);
    if (this.fromStart) {
      this.offset = 0;
    } else {
      this.offset = st.size;
      if (st.size > 0) {
        // if the file currently ends mid-line, the rest of that line must not be parsed as a line
        const fh = await fs.promises.open(this.file, 'r');
        try {
          const b = Buffer.alloc(1);
          await fh.read(b, 0, 1, st.size - 1);
          this.discarding = b[0] !== 0x0a;
        } finally { await fh.close(); }
      }
    }
    this.lastGrowth = Date.now();
    try {
      this.watcher = fs.watch(path.dirname(this.file), () => this.poke());
      this.watcher.on('error', () => {});
    } catch { /* polling only */ }
    this.timer = setInterval(() => this.poke(), this.pollMs);
    this.timer.unref?.();
    this.poke();
  }

  poke() {
    if (this.closed) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.drain().catch(() => {}).finally(() => {
      this.busy = false;
      if (this.again && !this.closed) { this.again = false; this.poke(); }
    });
  }

  async drain() {
    let st;
    try { st = await fs.promises.stat(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.parts = []; this.partLen = 0; this.discarding = false; } // truncated/rewritten
    if (st.size === this.offset) return;
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < st.size && !this.closed) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.lastGrowth = Date.now();
        this.consume(buf.subarray(0, bytesRead));
      }
    } finally { await fh.close(); }
  }

  consume(chunk) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        if (!this.discarding) this.keep(chunk.subarray(start));
        return;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.discarding) { this.discarding = false; this.parts = []; this.partLen = 0; continue; }
      let line;
      if (this.parts.length) {
        this.keep(piece);
        if (this.discarding) { this.discarding = false; continue; }
        line = Buffer.concat(this.parts, this.partLen);
        this.parts = []; this.partLen = 0;
      } else line = piece;
      if (line.length) this.emit(line);
    }
  }

  keep(buf) {
    if (!buf.length) return;
    if (this.partLen + buf.length > MAX_LINE) {
      this.onSkip(this.partLen + buf.length);
      this.parts = []; this.partLen = 0; this.discarding = true;
      return;
    }
    this.parts.push(Buffer.from(buf)); // copy: chunk buffer is reused
    this.partLen += buf.length;
  }

  emit(buf) {
    // cheap pre-filter for the huge non-conversation line types (they start with {"type":"…"})
    const head = buf.toString('latin1', 0, Math.min(buf.length, 40));
    const m = /^\{"type":"([a-z-]+)"/.exec(head);
    if (m && m[1] !== 'user' && m[1] !== 'assistant') return;
    this.onLine(buf.toString('utf8'));
  }

  get idleMs() { return Date.now() - this.lastGrowth; }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) try { this.watcher.close(); } catch { /* ignore */ }
  }
}
