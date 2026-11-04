import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Tailer } from '../src/tail.js';
import { tmp, until, sleep } from './helpers/env.mjs';

function setup(initial = '', opts = {}) {
  const dir = tmp('pm-tail-');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, initial);
  const lines = [];
  const t = new Tailer({ file, pollMs: 50, onLine: (l) => lines.push(l), ...opts });
  return { file, lines, t };
}

test('partial line without newline is not handed out until completed', async () => {
  const { file, lines, t } = setup('', { fromStart: true });
  await t.start();
  fs.appendFileSync(file, '{"type":"user","message":{"content":"par');
  await sleep(250);
  assert.equal(lines.length, 0);
  fs.appendFileSync(file, 'tial"}}\n{"type":"user","message":{"content":"two"}}');
  await until(() => lines.length === 1);
  await sleep(200);
  assert.equal(lines.length, 1); // second still unterminated
  assert.equal(JSON.parse(lines[0]).message.content, 'partial');
  fs.appendFileSync(file, '\n');
  await until(() => lines.length === 2);
  t.close();
});

test('starts at end of file: history is not replayed; half line at start is dropped', async () => {
  const { file, lines, t } = setup('{"type":"user","a":1}\n{"type":"user","b":2}\n{"type":"user","c');
  await t.start();
  fs.appendFileSync(file, '":3}\n{"type":"user","d":4}\n');
  await until(() => lines.length === 1);
  assert.equal(JSON.parse(lines[0]).d, 4);
  t.close();
});

test('fromStart reads existing lines', async () => {
  const { lines, t } = setup('{"type":"user","a":1}\n{"type":"assistant","b":2}\n', { fromStart: true });
  await t.start();
  await until(() => lines.length === 2);
  t.close();
});

test('non-conversation line types that start with {"type":"…"} are dropped before decoding', async () => {
  const { lines, t } = setup('{"type":"api-request-blob","x":"y"}\n{"type":"file-history-snapshot"}\n{"parentUuid":null,"type":"user"}\n', { fromStart: true });
  await t.start();
  await until(() => lines.length === 1);
  await sleep(150);
  assert.equal(lines.length, 1);
  t.close();
});

test('1.5 MB line is delivered once, in one piece, across chunk boundaries', async () => {
  const big = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1_500_000) } });
  const { file, lines, t } = setup('', { fromStart: true });
  await t.start();
  fs.appendFileSync(file, big.slice(0, 700_000));
  await sleep(150);
  fs.appendFileSync(file, `${big.slice(700_000)}\n{"type":"user","after":1}\n`);
  await until(() => lines.length === 2, 8000);
  assert.equal(lines[0].length, big.length);
  assert.equal(JSON.parse(lines[1]).after, 1);
  t.close();
});

test('lines above the hard limit are skipped, following lines survive', async () => {
  const skipped = [];
  const { file, lines, t } = setup('', { fromStart: true, onSkip: (n) => skipped.push(n) });
  await t.start();
  fs.appendFileSync(file, `{"type":"user","x":"${'y'.repeat(9 * 1024 * 1024)}"}\n{"type":"user","ok":1}\n`);
  await until(() => lines.length === 1, 10000);
  assert.equal(JSON.parse(lines[0]).ok, 1);
  assert.ok(skipped.length >= 1);
  t.close();
});

test('truncated/rewritten file restarts from 0', async () => {
  const { file, lines, t } = setup('{"type":"user","a":1}\n', { fromStart: true });
  await t.start();
  await until(() => lines.length === 1);
  fs.writeFileSync(file, '{"type":"user"}\n');
  await until(() => lines.length === 2);
  t.close();
});
