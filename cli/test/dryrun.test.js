import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeWorld, until, sleep } from './helpers/env.mjs';
import { buildLines, needles } from './helpers/fixture.mjs';
import { validateClientMessage } from '../src/shared/schema/index.js';

const BIN = path.resolve(import.meta.dirname, '../bin/peekmarquee.js');

function runCli(args, { cwd, home, env = {} }) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const o = { out: '', err: '', child, code: null };
  child.stdout.on('data', (d) => { o.out += d; });
  child.stderr.on('data', (d) => { o.err += d; });
  o.exit = new Promise((r) => child.on('exit', (c) => { o.code = c; r(c); }));
  return o;
}

async function counterServer() {
  let connections = 0;
  const srv = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, count: () => connections, close: () => srv.close() };
}

test('--dry-run: fixture secrets never appear on stdout/stderr, no socket is opened, all events valid', async () => {
  const w = makeWorld();
  const lines = buildLines({ cwd: w.cwd, home: w.home });
  fs.writeFileSync(w.file, `${lines.join('\n')}\n`);
  const srv = await counterServer();
  const p = runCli(['--dry-run', '--from-start', '--file', w.file, '--title', 'Dry test', '--wallet', '0x806a315f23C241692e16fcC563Ff67b4E11BEf73'], {
    cwd: w.cwd, home: w.home, env: { PEEKMARQUEE_RELAY: `ws://127.0.0.1:${srv.port}` },
  });
  await until(() => p.out.includes('"text":"done. password='), 8000);
  p.child.kill('SIGINT');
  await p.exit;
  await sleep(150);
  assert.equal(srv.count(), 0, 'dry-run must not connect to the relay');
  srv.close();
  const all = `${p.out}\n${p.err}`;
  for (const needle of needles({ cwd: w.cwd, home: w.home })) assert.ok(!all.includes(needle), `leaked in output: ${needle.slice(0, 24)}`);
  // grep-style checks (automated, as in the spec)
  assert.ok(!/sk-ant-/.test(all));
  assert.ok(!/BEGIN (OPENSSH |RSA )?PRIVATE KEY/.test(all));
  assert.ok(!/API_KEY=/.test(all));
  const evs = p.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs[0].type, 'hello');
  assert.equal(evs[0].data.title, 'Dry test');
  assert.equal(evs[0].data.agentVersion, '2.1.317');
  assert.equal(evs.at(-1).type, 'end');
  assert.equal(evs.at(-1).data.reason, 'ctrl_c');
  evs.forEach((e, i) => { assert.equal(e.seq, i + 1); assert.deepEqual(validateClientMessage(e), { ok: true, kind: 'event' }, JSON.stringify(e).slice(0, 120)); });
  assert.ok(evs.some((e) => e.type === 'tool_result' && e.data.hidden === 'sensitive_path'));
  assert.match(p.err, /secrets hidden/);
  assert.equal(p.code, 0);
});

test('--dry-run live: auto-detects the session, prints only new activity, within 2 s', async () => {
  const w = makeWorld({ lines: buildLines({ cwd: '/x', home: '/h' }).map((l) => l.replace('/x', '/x')) });
  // rewrite with the real cwd so detection matches
  fs.writeFileSync(w.file, `${buildLines({ cwd: w.cwd, home: w.home }).slice(0, 6).join('\n')}\n`);
  const p = runCli(['--dry-run', '--no-prompts'], { cwd: w.cwd, home: w.home });
  await until(() => p.out.includes('"type":"hello"'), 5000);
  await sleep(300);
  assert.ok(!p.out.includes('"type":"text"'), 'history must not be replayed');
  const t0 = Date.now();
  const line = JSON.stringify({ type: 'assistant', cwd: w.cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'brand new action' }] } });
  fs.appendFileSync(w.file, `${line}\n`);
  await until(() => p.out.includes('brand new action'), 2000);
  assert.ok(Date.now() - t0 < 2000);
  fs.appendFileSync(w.file, JSON.stringify({ type: 'user', cwd: w.cwd, message: { content: 'secret prompt text' }, origin: { kind: 'human' } }) + '\n');
  await sleep(1300);
  assert.ok(!p.out.includes('secret prompt text'), '--no-prompts');
  p.child.kill('SIGINT');
  await p.exit;
  assert.equal(p.code, 0);
});

test('--agent codex and bad wallet exit 2; no session in folder waits then exits 1 (short wait via --file missing)', async () => {
  const w = makeWorld();
  const a = runCli(['--agent', 'codex', '--dry-run'], { cwd: w.cwd, home: w.home });
  assert.equal(await a.exit, 2);
  assert.match(a.err, /not supported in this version/);
  const b = runCli(['--wallet', '0x12', '--dry-run'], { cwd: w.cwd, home: w.home });
  assert.equal(await b.exit, 2);
  const c = runCli(['--dry-run', '--file', '/nonexistent.jsonl'], { cwd: w.cwd, home: w.home });
  assert.equal(await c.exit, 1);
});

test('no active session: prints guidance and does not create a stream', async () => {
  const w = makeWorld({ lines: [] });
  fs.rmSync(w.file);
  const p = runCli([], { cwd: w.cwd, home: w.home, env: { PEEKMARQUEE_RELAY: 'ws://127.0.0.1:1' } });
  await until(() => p.err.includes('No active Claude Code session'), 4000);
  p.child.kill('SIGINT');
  await p.exit;
  assert.ok(!p.out.includes('Streaming'));
});
