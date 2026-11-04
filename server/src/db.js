import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'streams'), { recursive: true });
  const db = new Database(path.join(dataDir, 'relay.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS streams(
  id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL, manageKeyHash TEXT NOT NULL,
  title TEXT NOT NULL, agent TEXT NOT NULL, wallet TEXT, public INTEGER NOT NULL, replay INTEGER NOT NULL,
  createdAt INTEGER NOT NULL, startedAt INTEGER, endedAt INTEGER, lastFrameAt INTEGER,
  lastSeq INTEGER NOT NULL DEFAULT 0, red INTEGER NOT NULL DEFAULT 0, redServer INTEGER NOT NULL DEFAULT 0,
  toolCalls INTEGER NOT NULL DEFAULT 0, edits INTEGER NOT NULL DEFAULT 0, viewersPeak INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER, deletedAt INTEGER, reportCount INTEGER NOT NULL DEFAULT 0,
  unlisted INTEGER NOT NULL DEFAULT 0, replayOff INTEGER NOT NULL DEFAULT 0, holder INTEGER NOT NULL DEFAULT 0,
  cli TEXT
);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, streamId TEXT, reason TEXT, ip_hash TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS holders(wallet TEXT, streamId TEXT PRIMARY KEY, verifiedAt INTEGER, balance TEXT);
CREATE TABLE IF NOT EXISTS gone(id TEXT PRIMARY KEY, reason TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS tips(txHash TEXT, logIndex INTEGER, block INTEGER, streamId TEXT, "from" TEXT, streamer TEXT, amount TEXT, t INTEGER, PRIMARY KEY(txHash, logIndex));
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, streamId TEXT NOT NULL, nick TEXT, text TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0, tx TEXT, t INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS chat_stream ON chat(streamId, id);
CREATE TABLE IF NOT EXISTS chat_reports(msgId INTEGER, ipHash TEXT, PRIMARY KEY(msgId, ipHash));
INSERT OR IGNORE INTO counters(k,v) VALUES('streamsTotal',0),('toolCalls',0),('secretsHidden',0),('msStreamed',0);
`);
  const addCol = (table, col, def) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  addCol('tips', 'token', 'TEXT');   // NULL = ETH (Tipped); lowercase address = TippedToken
  addCol('tips', 'src', 'TEXT');     // contract address (lowercase) the log came from
  addCol('streams', 'chatOn', 'INTEGER NOT NULL DEFAULT 1');
  addCol('streams', 'slowSec', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}
