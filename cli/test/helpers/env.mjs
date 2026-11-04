import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify } from '../../src/session.js';

export function tmp(prefix = 'pm-') { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

/** fake HOME with ~/.claude/projects/<slug>/<id>.jsonl for a fake cwd */
export function makeWorld({ lines = [], sessionId = 'sess-0001' } = {}) {
  const home = tmp('pm-home-'); const cwd = tmp('pm-cwd-');
  const dir = path.join(home, '.claude', 'projects', slugify(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return { home, cwd, dir, file };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  throw new Error('timeout waiting for condition');
}
