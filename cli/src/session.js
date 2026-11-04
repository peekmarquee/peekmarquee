// Find the active Claude Code transcript for a folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code names the project folder after the cwd with every non-alphanumeric char replaced by "-". */
export function slugify(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }

function real(p) { try { return fs.realpathSync(p); } catch { return p; } }

/** Read the first user/assistant line of a transcript (skips oversized and non-conversation lines). */
export async function readHead(file) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(512 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n').slice(0, 60);
    for (const line of lines) {
      if (line.length < 20 || line.length > 200000) continue;
      const m = /^\{"type":"([a-z-]+)"/.exec(line);
      if (m && m[1] !== 'user' && m[1] !== 'assistant') continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if ((o.type === 'user' || o.type === 'assistant') && typeof o.cwd === 'string') {
        return { cwd: o.cwd, version: typeof o.version === 'string' ? o.version : null, sessionId: o.sessionId || path.basename(file, '.jsonl') };
      }
    }
  } finally { await fh.close(); }
  return null;
}

async function listJsonl(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(dir, n);
    try {
      const st = await fs.promises.stat(f);
      if (st.isFile()) out.push({ file: f, mtimeMs: st.mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}

/**
 * @returns {Promise<Array<{file,mtimeMs,cwd,version,sessionId}>>} matching sessions, newest first
 */
export async function findSessions({ cwd = process.cwd(), home = os.homedir(), now = Date.now(), maxAgeSec = 120, exclude = [] } = {}) {
  const base = path.join(home, '.claude', 'projects');
  const cwds = new Set([cwd, real(cwd)]);
  const slugs = new Set([...cwds].flatMap((c) => [slugify(c), c.replaceAll('/', '-')]));
  let cands = [];
  for (const s of slugs) cands.push(...(await listJsonl(path.join(base, s))));
  if (!cands.length) {
    // slug rule changed? look at every project folder with a fresh file
    let dirs = [];
    try { dirs = await fs.promises.readdir(base); } catch { /* none */ }
    for (const d of dirs) {
      const fresh = (await listJsonl(path.join(base, d))).filter((c) => now - c.mtimeMs <= maxAgeSec * 1000);
      cands.push(...fresh);
    }
  }
  const seen = new Set();
  cands = cands.filter((c) => (seen.has(c.file) ? false : seen.add(c.file)))
    .filter((c) => now - c.mtimeMs <= maxAgeSec * 1000 && !exclude.includes(c.file))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const c of cands) {
    const head = await readHead(c.file);
    if (!head) continue;
    if (cwds.has(head.cwd) || cwds.has(real(head.cwd))) out.push({ ...c, ...head });
  }
  return out;
}

/** Poll every 2 s up to timeoutMs. `onWait` is called once when starting to wait. */
export async function waitForSession(opts, { timeoutMs = 10 * 60 * 1000, pollMs = 2000, onWait, signal } = {}) {
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    const found = await findSessions(opts);
    if (found.length) return found;
    if (!announced) { announced = true; onWait?.(); }
    if (Date.now() - t0 >= timeoutMs || signal?.aborted) return [];
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
