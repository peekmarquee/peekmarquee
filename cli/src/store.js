// ~/.config/peekmarquee/streams.json (mode 0600): ingest tokens needed for `peekmarquee delete <id>`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function storePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'peekmarquee', 'streams.json');
}

export function readStreams(file = storePath()) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

export function saveStream(id, rec, file = storePath()) {
  const all = readStreams(file);
  all[id] = rec;
  const keys = Object.keys(all);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k]; // keep it small
  write(file, all);
}

export function removeStream(id, file = storePath()) {
  const all = readStreams(file);
  if (id in all) { delete all[id]; write(file, all); }
}
