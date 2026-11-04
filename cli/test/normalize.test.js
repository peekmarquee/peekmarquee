import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/shared/redact/index.js';
import { createNormalizer } from '../src/normalize.js';
import { buildLines, needles, FAKE, SEED } from './helpers/fixture.mjs';

const cwd = '/Users/fixtureuser/work/secret-project-name';
const home = '/Users/fixtureuser';

function run(opts = {}) {
  const redactor = createRedactor();
  const n = createNormalizer({ cwd, home, redactor, ...opts });
  const evs = [];
  for (const l of buildLines({ cwd, home })) for (const e of n.feed(JSON.parse(l))) evs.push({ ...e, red: redactor.count });
  return { evs, n, redactor };
}

test('no needle appears anywhere in the normalized events', () => {
  const { evs } = run();
  const blob = JSON.stringify(evs);
  for (const needle of needles({ cwd, home })) assert.ok(!blob.includes(needle), `leaked: ${needle.slice(0, 30)}`);
  assert.ok(!blob.includes('secret-project-name'));
  assert.ok(!blob.includes('fixtureuser'));
});

test('event mapping and shapes', () => {
  const { evs } = run();
  const types = evs.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'prompt').length, 1);
  assert.equal(types.filter((t) => t === 'tool_call').length, 12);
  assert.equal(evs.filter((e) => e.type === 'status' && e.data.state === 'thinking').length, 1);
  const prompt = evs.find((e) => e.type === 'prompt');
  assert.match(prompt.data.text, /\[redacted:seed_phrase\]/);
  assert.match(prompt.data.text, /\.\/src/); // cwd rewritten
  const text = evs.filter((e) => e.type === 'text');
  assert.match(text[0].data.text, /\[redacted:api_key\]/);
});

test('sensitive tool results are hidden entirely', () => {
  const { evs } = run();
  const r = (id) => evs.find((e) => e.type === 'tool_result' && e.data.forId === id);
  assert.deepEqual([r('toolu_01').data.hidden, r('toolu_01').data.text], ['sensitive_path', '[file hidden: .env]']);
  assert.equal(r('toolu_02').data.hidden, 'sensitive_path'); // Bash cat .env
  assert.equal(r('toolu_04').data.hidden, 'sensitive_path'); // Read ~/.ssh/id_rsa
  assert.equal(r('toolu_05').data.hidden, 'env_dump');
  const editEnv = evs.find((e) => e.type === 'edit' && e.data.path.endsWith('.env.local'));
  assert.equal(editEnv.data.snippet, '[edit hidden]');
  const call = evs.find((e) => e.type === 'tool_call' && e.data.id === 'toolu_03');
  assert.equal(call.data.args.new_string, '[hidden]');
  assert.equal(call.data.args.file_path, '.env.local');
});

test('normal results: truncated, redacted, paths relative; grep lines from .env dropped', () => {
  const { evs } = run();
  const t6 = evs.find((e) => e.type === 'tool_result' && e.data.forId === 'toolu_06');
  assert.equal(t6.data.hidden, null);
  assert.match(t6.data.text, /PASS src\/a\.test\.js/);
  assert.match(t6.data.text, /\[redacted:api_key\]/);
  assert.match(t6.data.text, /\[redacted:seed_phrase\]/);
  assert.match(t6.data.text, /\[redacted:private_key\]/);
  assert.match(t6.data.text, /running in \./);
  const t9 = evs.find((e) => e.type === 'tool_result' && e.data.forId === 'toolu_09');
  assert.ok(!t9.data.text.includes('hunter2'));
  assert.match(t9.data.text, /src\/db\.js:7/);
});

test('edit events from structuredPatch / Write', () => {
  const { evs } = run();
  const e7 = evs.find((e) => e.type === 'edit' && e.data.path === 'src/app.ts');
  assert.equal(e7.data.added, 3); assert.equal(e7.data.removed, 1);
  assert.match(e7.data.snippet, /\+new line one/);
  assert.match(e7.data.snippet, /\[redacted:api_key\]/);
  const e8 = evs.find((e) => e.type === 'edit' && e.data.path === 'notes.md');
  assert.equal(e8.data.added, 3);
  assert.match(e8.data.snippet, /redacted:seed_phrase/);
});

test('image result, subagent, MCP summary, args limits', () => {
  const { evs } = run();
  const img = evs.find((e) => e.type === 'tool_result' && e.data.forId === 'toolu_10');
  assert.deepEqual([img.data.text, img.data.hidden], ['[image]', 'binary']);
  const agent = evs.find((e) => e.type === 'tool_call' && e.data.tool === 'Agent');
  assert.equal(agent.data.summary, 'subagent: explore the repo');
  const mcp = evs.find((e) => e.type === 'tool_call' && e.data.tool.startsWith('mcp__'));
  assert.equal(mcp.data.summary, 'mcp__server__do_thing');
  assert.ok(Buffer.byteLength(JSON.stringify(mcp.data.args)) <= 4096);
  assert.ok(!JSON.stringify(mcp.data.args).includes('ghp_'));
  const bash = evs.find((e) => e.type === 'tool_call' && e.data.id === 'toolu_06');
  assert.equal(bash.data.summary, 'cd . && npm test');
  // sidechain / attachment / subagent content absent
  assert.ok(!JSON.stringify(evs).includes('sidechain'));
});

test('red counter is cumulative and monotonic, rises for hidden results', () => {
  const { evs, redactor } = run();
  let prev = 0;
  for (const e of evs) { assert.ok(e.red >= prev); prev = e.red; }
  assert.ok(redactor.count >= 15);
  assert.ok(redactor.classes.sensitive_path >= 3);
  assert.equal(redactor.classes.env_dump, 1);
});

test('--no-prompts drops prompts only', () => {
  const { evs } = run({ noPrompts: true });
  assert.equal(evs.filter((e) => e.type === 'prompt').length, 0);
  assert.ok(evs.some((e) => e.type === 'text'));
});

test('non-human user lines and meta are not prompts; tool_result text blocks ignored', () => {
  const redactor = createRedactor();
  const n = createNormalizer({ cwd, home, redactor });
  const user = (c, extra) => ({ type: 'user', message: { content: c }, cwd, ...extra });
  assert.equal(n.feed(user('hello', { isMeta: true })).length, 0);
  assert.equal(n.feed(user('hello', { origin: { kind: 'peer' } })).length, 0);
  assert.equal(n.feed(user('<system-reminder>x</system-reminder>')).length, 0);
  assert.equal(n.feed(user('hello there')).length, 1); // string, no origin (older versions)
  assert.equal(n.feed({ type: 'weird' }).length, 0);
  assert.equal(n.feed({ type: 'assistant' }).length, 0);
  assert.equal(n.stats.unknownShapes, 1);
});

test('1.5 MB tool result is cut to <= 4 KB, marked truncated, bytes preserved', () => {
  const redactor = createRedactor();
  const n = createNormalizer({ cwd, home, redactor });
  n.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat big.txt' } }] } });
  const big = ('line of output with some words 12345\n').repeat(45000); // ~1.6 MB
  const [ev] = n.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } });
  assert.ok(Buffer.byteLength(ev.data.text) <= 4096);
  assert.equal(ev.data.truncated, true);
  assert.equal(ev.data.bytes, Buffer.byteLength(big));
});
void FAKE; void SEED;
