import test from 'node:test';
import assert from 'node:assert/strict';
import WORDS from '../redact/wordlist.js';
import {
  createRedactor, redactText, isSensitivePath, classifyTool, isEnvDumpCommand,
  clipBytes, redactEvent, scrubSensitiveLines, shannon,
} from '../redact/index.js';

// All fixtures are synthetic.
const A = (n, ch = 'a') => ch.repeat(n);
const rnd = (n) => { // deterministic pseudo-random base62 (mulberry32)
  const c = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  let a = 0x9e3779b9; let s = '';
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    s += c[(((t ^ (t >>> 14)) >>> 0) % c.length)];
  }
  return s;
};
const red = (s, o) => redactText(s, o);
const SEED12 = WORDS.slice(100, 112).join(' ');
const SEED24 = WORDS.slice(300, 324).join(' ');
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${rnd(64)}\n${rnd(64)}\n${rnd(40)}\n-----END RSA PRIVATE KEY-----`;

const POSITIVE = [
  ['sk- openai', `key sk-${rnd(40)} end`, 'api_key'],
  ['sk-ant', `ANTHROPIC=sk-ant-api03-${rnd(60)}`, 'api_key'],
  ['ghp', `ghp_${rnd(36)}`, 'token'],
  ['gho', `gho_${rnd(40)}`, 'token'],
  ['github_pat', `github_pat_${rnd(30)}`, 'token'],
  ['glpat', `glpat-${rnd(24)}`, 'token'],
  ['AKIA', `id AKIA${'ABCDEFGH12345678'}`, 'api_key'],
  ['aws secret', `aws_secret_access_key = ${rnd(40)}`, 'api_key'],
  ['slack', `xoxb-${rnd(30)}`, 'token'],
  ['google AIza', `AIza${rnd(35)}`, 'api_key'],
  ['ya29', `ya29.${rnd(30)}`, 'token'],
  ['stripe live', `sk_live_${rnd(26)}`, 'api_key'],
  ['stripe test', `sk_test_${rnd(26)}`, 'api_key'],
  ['stripe rk', `rk_live_${rnd(26)}`, 'api_key'],
  ['sendgrid', `SG.${rnd(24)}.${rnd(24)}`, 'api_key'],
  ['npm', `npm_${rnd(36)}`, 'token'],
  ['pypi', `pypi-AgEIcHlwaS5vcmc${rnd(40)}`, 'token'],
  ['digitalocean', `dop_v1_${'0123456789abcdef'.repeat(4)}`, 'token'],
  ['hf', `hf_${rnd(34)}`, 'api_key'],
  ['replicate', `r8_${rnd(34)}`, 'api_key'],
  ['jwt', `eyJ${rnd(20)}.eyJ${rnd(30)}.${rnd(30)}`, 'jwt'],
  ['pem', `before\n${PEM}\nafter`, 'private_key'],
  ['hex64 with key word', `private key: 0x${'ab12'.repeat(16)}`, 'private_key'],
  ['hex64 after =', `PK=${'cd34'.repeat(16)}`, 'private_key'],
  ['seed 12', `my seed is ${SEED12} ok`, 'seed_phrase'],
  ['seed 24 multiline', `${WORDS.slice(300, 312).join(' ')}\n${WORDS.slice(312, 324).join(' ')}`, 'seed_phrase'],
  ['url user:pass', 'postgres://admin:hunter22pw@db.example.com:5432/app', 'credential_url'],
  ['url query token', 'https://api.example.com/v1?token=abcdef123456&x=1', 'credential_url'],
  ['url query sig', 'https://cdn.example.com/f?sig=zzzzzzzzzz', 'credential_url'],
  ['alchemy', `https://eth-mainnet.g.alchemy.com/v2/${rnd(32)}`, 'credential_url'],
  ['infura', `wss://mainnet.infura.io/ws/v3/${rnd(32)}`, 'credential_url'],
  ['quicknode', `https://foo-bar.quiknode.pro/${rnd(40)}/`, 'credential_url'],
  ['ankr', `https://rpc.ankr.com/eth/${rnd(40)}`, 'credential_url'],
  ['drpc', `https://lb.drpc.org/ogrpc?network=ethereum&dkey=${rnd(30)}`, 'credential_url'],
  ['chainstack', `https://nd-123-456.p2pify.chainstack.com/${rnd(32)}`, 'credential_url'],
  ['bearer', 'curl -H "Authorization: Bearer abc.def-ghi_jkl1234" x', 'token'],
  ['basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'token'],
  ['password kv', 'password = "correcthorse99"', 'token'],
  ['api_key kv json', '{"api_key": "plainvalue12345"}', 'token'],
  ['client_secret kv', 'CLIENT_SECRET=plainvalue12345', 'token'],
  ['database url', 'DATABASE_URL=postgres://localhost/mydb', 'env_value'],
  ['redis url', 'REDIS_URL="redis://localhost:6379/0"', 'env_value'],
  ['mongodb', 'MONGODB_URI=mongodb://localhost/x', 'env_value'],
  ['telegram', `bot 123456789:${rnd(35)}`, 'token'],
  ['discord', `M${rnd(23)}.${rnd(6)}.${rnd(27)}`, 'token'],
  ['entropy', `value ${rnd(40)} end`, 'high-entropy'],
];

for (const [name, input, cls] of POSITIVE) {
  test(`redact positive: ${name}`, () => {
    const { text, hits } = red(input);
    assert.ok(text.includes(`[redacted:${cls}]`), `expected [redacted:${cls}] in: ${text}`);
    assert.ok((hits[cls] || 0) >= 1);
    // the secret-ish payload must be gone: no long alnum run from the input survives
    const run = /[A-Za-z0-9]{24,}/.exec(text);
    assert.equal(run, null, `leftover long token: ${run && run[0]}`);
  });
}

const NEGATIVE = [
  ['tx hash without context', `tx ${'0x' + 'ab12'.repeat(16)} mined`, '0x' + 'ab12'.repeat(16)],
  ['tx_hash label with =', `tx_hash=0x${'ef56'.repeat(16)}`, 'ef56'.repeat(16)],
  ['sha256 file hash plain', `${'0123abcd'.repeat(8)}  file.tgz`, '0123abcd'.repeat(8)],
  ['uuid', 'id 123e4567-e89b-12d3-a456-426614174000 ok', '123e4567-e89b-12d3-a456-426614174000'],
  ['0x40 address', 'to 0x806a315f23C241692e16fcC563Ff67b4E11BEf73 done', '0x806a315f23C241692e16fcC563Ff67b4E11BEf73'],
  ['task- not sk-', 'run task-' + 'x'.repeat(30), 'task-'],
  ['prose 12 words', 'The quick brown fox jumps over the lazy dog while it is raining outside today', 'quick brown fox'],
  ['11 seed words', `x ${WORDS.slice(100, 111).join(' ')} y`, WORDS[100]],
  ['long path with long segments', 'in /Users/someone/Documents/project-name-2026/subdirectory-with-long-name/file-name-here', 'subdirectory-with-long-name'],
  ['kebab slug with digits', 'image my-long-project-slug-v2-release-candidate-build-2026 ok', 'my-long-project-slug-v2-release-candidate-build-2026'],
  ['kebab path', 'see src/components/features/dashboard/widgets/chart-panel.tsx', 'chart-panel.tsx'],
  ['camelCase identifier', 'call useEffectCallbackHandlerRefsAbstractionLayerBuilder now', 'useEffectCallbackHandlerRefsAbstractionLayerBuilder'],
  ['sha512 integrity', `integrity sha512-${rnd(40)}`, 'sha512-'],
  ['plain url', 'https://example.com/docs/page?id=12', 'https://example.com/docs/page?id=12'],
  ['max_tokens', 'max_tokens: 4096000000', 'max_tokens: 4096000000'],
  ['rpc without key', 'https://robinhood-rpc.publicnode.com', 'https://robinhood-rpc.publicnode.com'],
];
for (const [name, input, mustKeep] of NEGATIVE) {
  test(`redact negative: ${name}`, () => {
    const { text, hits } = red(input);
    assert.ok(text.includes(mustKeep), `lost "${mustKeep}" -> ${text}`);
    assert.deepEqual(hits, {});
  });
}

test('hex64: with key word is redacted even without separator', () => {
  const { text } = red(`the wallet seed hash ${'9f'.repeat(32)}`);
  assert.match(text, /\[redacted:private_key\]/);
});

test('seed phrases 12 and 24 are replaced whole, surrounding text kept', () => {
  const r12 = red(`a ${SEED12} b`).text;
  assert.equal(r12, 'a [redacted:seed_phrase] b');
  const r24 = red(`a ${SEED24} b`);
  assert.equal(r24.text, 'a [redacted:seed_phrase] b');
  assert.equal(r24.hits.seed_phrase, 1);
});

test('PEM multi-line replaced entirely, also when truncated', () => {
  const r = red(`x\n${PEM}\ny`).text;
  assert.equal(r, 'x\n[redacted:private_key]\ny');
  const cut = red(`-----BEGIN PRIVATE KEY-----\n${rnd(100)}`).text;
  assert.equal(cut, '[redacted:private_key]');
});

test('replacement never contains original, length or hash', () => {
  const secret = `sk-ant-${rnd(50)}`;
  const { text } = red(`a ${secret} b`);
  assert.equal(text, 'a [redacted:api_key] b');
});

test('idempotent: second pass finds nothing and changes nothing', () => {
  const first = red(`k sk-${rnd(40)} p password=hunter2hunter ${PEM} ${SEED12}`).text;
  const second = red(first);
  assert.equal(second.text, first);
  assert.deepEqual(second.hits, {});
});

test('redactor counter rises exactly once per replacement', () => {
  const r = createRedactor();
  assert.equal(r.count, 0);
  r.text(`a sk-${rnd(40)} b ghp_${rnd(36)}`);
  assert.equal(r.count, 2);
  r.text('nothing here');
  assert.equal(r.count, 2);
  r.bump('sensitive_path');
  assert.equal(r.count, 3);
  assert.equal(r.classes.api_key, 1);
  assert.equal(r.classes.token, 1);
});

test('entropy can be disabled (paths) and does not hit uuid/hex', () => {
  const p = 'node_modules/.pnpm/some-package@1.2.3/node_modules/some-package/dist/index.js';
  assert.equal(red(p, { entropy: false }).text, p);
  const t = rnd(40);
  assert.equal(red(t, { entropy: false }).text, t);
  assert.equal(red(t).text, '[redacted:high-entropy]');
});

test('custom --hide: glob, literal and /regex/', () => {
  const r = createRedactor({ hide: ['acme-*', 'Jane Doe', '/cust_\\d{4}/'] });
  const out = r.text('acme-internal-tool , Jane Doe and cust_1234 ok');
  assert.equal(out, '[redacted:custom] , [redacted:custom] and [redacted:custom] ok');
  assert.equal(r.count, 3);
});

test('truncation happens after redaction: partial secret cannot survive', () => {
  const big = `${'x '.repeat(100)}sk-${rnd(60)} tail`;
  const redacted = red(big).text;
  const { text, truncated } = clipBytes(redacted, 210);
  assert.ok(truncated);
  assert.ok(!/sk-/.test(text));
});

test('clipBytes respects UTF-8 and flags truncation', () => {
  const s = 'é'.repeat(100); // 200 bytes
  const c = clipBytes(s, 51);
  assert.ok(c.truncated);
  assert.ok(Buffer.byteLength(c.text) <= 51);
  assert.equal(c.bytes, 200);
  assert.deepEqual(clipBytes('abc', 10), { text: 'abc', truncated: false, bytes: 3 });
});

// ------------------------------------------------------------ sensitive paths

test('sensitive path list: positives', () => {
  for (const p of ['.env', 'app/.env.local', '/x/.env.production', 'server.pem', 'a/b/tls.key', 'c.p12', 'c.pfx',
    '~/.ssh/id_rsa', '/home/u/.ssh/id_ed25519.pub', 'a.keystore', 'credentials.json', 'secrets.yaml', 'x.secret', '.npmrc',
    '.netrc', '.pypirc', '.git-credentials', '/h/.aws/credentials', '.aws/config', '.ssh/config', '.gnupg/pubring.kbx',
    '/h/.kube/config', 'a.jks', 'wallet-main.json', 'keystore/UTC--2024', '.claude/settings.json',
    '.claude/settings.local.json', '/h/.docker/config.json', '**/.env*', '*.pem']) {
    assert.ok(isSensitivePath(p), p);
  }
});

test('sensitive path list: negatives', () => {
  for (const p of ['src/app.ts', 'README.md', 'package.json', 'environment.ts', 'keyboard.js', 'src/envelope.ts', '.envsomething/x'.replace('.envsomething', 'env'), 'docs/ssh-guide.md', 'wallet.ts', 'monkey.js', '.claude/commands/x.md']) {
    assert.ok(!isSensitivePath(p), p);
  }
});

test('classifyTool: Read .env / Edit .env.local / Read ~/.ssh/id_rsa / Bash cat .env / Grep pattern', () => {
  assert.equal(classifyTool('Read', { file_path: '/p/.env' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Edit', { file_path: '/p/.env.local', old_string: 'a', new_string: 'b' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Read', { file_path: '/Users/x/.ssh/id_rsa' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Write', { file_path: 'deploy/server.pem', content: 'x' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Bash', { command: 'cat .env | head' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Bash', { command: 'source ./.env.local && npm start' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Grep', { pattern: 'x', path: '/p/.aws' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Glob', { pattern: '**/*.pem' }).hidden, 'sensitive_path');
  assert.equal(classifyTool('Read', { file_path: '/p/src/app.ts' }).hidden, null);
  assert.equal(classifyTool('Bash', { command: 'npm test' }).hidden, null);
});

test('env dumps', () => {
  for (const c of ['printenv', 'printenv HOME', 'env', 'env | sort', 'export -p', 'set', 'echo a; set', 'security find-generic-password -s x',
    'gh auth token', 'aws configure get aws_access_key_id', 'vault read secret/x', 'op read op://a/b', 'sudo printenv']) {
    assert.ok(isEnvDumpCommand(c), c);
    assert.equal(classifyTool('Bash', { command: c }).hidden, 'env_dump');
  }
  for (const c of ['env FOO=1 node a.js', 'npm run set-version', 'git status', 'open file', 'echo settings']) {
    assert.ok(!isEnvDumpCommand(c), c);
  }
});

test('scrubSensitiveLines hides grep hits from sensitive files', () => {
  const r = scrubSensitiveLines('src/a.ts:3:foo\n.env:1:KEY=abc\napp/.env.local:9:x');
  assert.equal(r.hidden, 2);
  assert.equal(r.text.split('\n')[0], 'src/a.ts:3:foo');
  assert.ok(!r.text.includes('KEY=abc'));
});

// ------------------------------------------------------------ event helper (relay)

test('redactEvent: second pass catches sk- and leaves ids/state alone, counts', () => {
  const r = createRedactor();
  const ev = { v: 1, seq: 5, t: 1, type: 'tool_call', red: 2, data: { id: 'toolu_01' + rnd(30), tool: 'Bash', summary: `curl -H x sk-${rnd(40)}`, args: { command: `echo sk-${rnd(40)}`, file_path: 'a/b' } } };
  const out = redactEvent(ev, r);
  assert.equal(out.data.id, ev.data.id);
  assert.match(out.data.summary, /\[redacted:api_key\]/);
  assert.match(out.data.args.command, /\[redacted:api_key\]/);
  assert.equal(out.seq, 5);
  assert.equal(out.red, 2);
  assert.equal(r.count, 2);
  assert.ok(ev.data.summary.includes('sk-'), 'input event not mutated');
});

test('shannon sanity', () => {
  assert.ok(shannon('aaaaaaaa') < 0.1);
  assert.ok(shannon(rnd(40)) > 4);
});

test('performance: 1.5 MB string redacts in well under 5 s', () => {
  const s = ('lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30000)).slice(0, 1_500_000);
  const t0 = Date.now();
  red(s);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('A() helper exists', () => assert.equal(A(3), 'aaa'));
