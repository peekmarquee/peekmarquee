import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSessions, slugify, waitForSession } from '../src/session.js';
import { makeWorld, tmp } from './helpers/env.mjs';
import { buildLines } from './helpers/fixture.mjs';

const head = (cwd, id) => buildLines({ cwd, home: '/h', sessionId: id }).slice(0, 8);

test('slug: every non-alphanumeric char becomes "-" (matches real Claude Code folders)', () => {
  assert.equal(slugify('/Users/x/Documents/42. My App 01-01-2026'), '-Users-x-Documents-42--My-App-01-01-2026');
});

test('two fresh files: newest first; stale file ignored; cwd mismatch ignored', async () => {
  const w = makeWorld({ lines: [] });
  const now = Date.now();
  const mk = (id, ageSec, cwd = w.cwd) => {
    const f = path.join(w.dir, `${id}.jsonl`);
    fs.writeFileSync(f, `${head(cwd, id).join('\n')}\n`);
    const t = new Date(now - ageSec * 1000); fs.utimesSync(f, t, t);
    return f;
  };
  fs.rmSync(w.file);
  const newer = mk('new', 5); mk('old', 30); mk('stale', 600); mk('other', 2, '/somewhere/else');
  const found = await findSessions({ cwd: w.cwd, home: w.home, now });
  assert.deepEqual(found.map((f) => path.basename(f.file)), ['new.jsonl', 'old.jsonl']);
  assert.equal(found[0].file, newer);
  assert.equal(found[0].version, '2.1.317');
});

test('subfolder (subagents) files are not candidates', async () => {
  const w = makeWorld({ lines: head('/x', 's') });
  fs.mkdirSync(path.join(w.dir, 'sess-0001', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'sess-0001', 'subagents', 'agent-ab.jsonl'), `${head(w.cwd, 'a').join('\n')}\n`);
  fs.rmSync(w.file);
  assert.deepEqual(await findSessions({ cwd: w.cwd, home: w.home }), []);
});

test('no session: waitForSession gives up after timeout and announces once', async () => {
  const home = tmp('pm-h-'); const cwd = tmp('pm-c-');
  let announced = 0;
  const r = await waitForSession({ cwd, home }, { timeoutMs: 300, pollMs: 100, onWait: () => announced++ });
  assert.deepEqual(r, []);
  assert.equal(announced, 1);
});

test('fallback scan finds the session when the slug folder name differs', async () => {
  const home = tmp('pm-h-'); const cwd = tmp('pm-c-');
  const dir = path.join(home, '.claude', 'projects', 'some-other-slug-rule');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.jsonl'), `${head(cwd, 'x').join('\n')}\n`);
  const found = await findSessions({ cwd, home });
  assert.equal(found.length, 1);
});
