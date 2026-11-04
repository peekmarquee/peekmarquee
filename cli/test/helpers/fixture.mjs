// Hand-written SYNTHETIC transcript in the shape of the spec (not copied from any real transcript).
// Every "needle" below must never appear in any outgoing event.
import WORDS from '../../src/shared/redact/wordlist.js';

const mk = (seed) => { // deterministic base62
  const c = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  let a = seed; let s = '';
  return (n) => { s = ''; for (let i = 0; i < n; i++) { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; s += c[(((t ^ (t >>> 14)) >>> 0) % c.length)]; } return s; };
};
const r = mk(42);

export const FAKE = {
  anthropic: `sk-ant-api03-${r(60)}`,
  seedWords: WORDS.slice(500, 512),
  pemBody: [r(64), r(64), r(48)],
  envValue: `SuperSecretEnvValue${r(10)}`,
  envToken: `ghp_${r(36)}`,
  sshBody: r(70),
  thinking: 'THINKING_SECRET_MARKER_9931',
  branch: 'feature-private-branch-xyz',
  attachment: `ATTACH_${r(20)}`,
  fileHistory: `FILEHISTORY_${r(20)}`,
  apiRequest: `APIREQ_${r(20)}`,
  dbPassword: 'hunter2hunter2',
  alchemy: `https://eth-mainnet.g.alchemy.com/v2/${r(32)}`,
};
export const SEED = FAKE.seedWords.join(' ');
export const PEM = `-----BEGIN PRIVATE KEY-----\n${FAKE.pemBody.join('\n')}\n-----END PRIVATE KEY-----`;

/** needles that must be absent from all output (plus cwd/home which depend on the test) */
export function needles({ cwd, home }) {
  return [FAKE.anthropic, SEED, FAKE.seedWords.slice(0, 6).join(' '), ...FAKE.pemBody, FAKE.envValue, FAKE.envToken, FAKE.sshBody,
    FAKE.thinking, FAKE.branch, FAKE.attachment, FAKE.fileHistory, FAKE.apiRequest, FAKE.dbPassword, FAKE.alchemy.split('/').pop(), cwd, home];
}

export function buildLines({ cwd, home, sessionId = 'sess-0001', version = '2.1.317' }) {
  let n = 0; let ts = Date.UTC(2026, 10, 5, 12, 0, 0);
  const base = (type, extra) => ({ parentUuid: n ? `u${n}` : null, isSidechain: false, type, uuid: `u${++n}`, timestamp: new Date(ts += 1500).toISOString(), userType: 'external', cwd, sessionId, version, gitBranch: FAKE.branch, ...extra });
  const L = [];
  const user = (content, extra = {}) => L.push(base('user', { message: { role: 'user', content }, origin: { kind: 'human' }, ...extra }));
  const asst = (content) => L.push(base('assistant', { message: { id: `msg_${n}`, role: 'assistant', model: 'claude-x', content, usage: { input_tokens: 1, output_tokens: 1 } } }));
  const result = (id, content, tur, extra = {}) => L.push(base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, toolUseResult: tur }));

  L.push({ type: 'session-owner', accountUuid: 'acc', sessionId });
  L.push({ type: 'file-history-snapshot', messageId: 'm', snapshot: { note: FAKE.fileHistory } });
  L.push({ type: 'api-request', sessionId, id: 'r1', params: { x: FAKE.apiRequest } });
  user([{ type: 'text', text: `please deploy; my seed is ${SEED} (testing) and work in ${cwd}/src` }]);
  asst([{ type: 'thinking', thinking: FAKE.thinking, signature: 'sig' }]);
  asst([{ type: 'text', text: `Looking at ${cwd}/src/app.ts first. Key ${FAKE.anthropic} should not be here.` }]);
  asst([{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: `${cwd}/.env` } }]);
  result('toolu_01', `API_KEY=${FAKE.envValue}\nGITHUB_TOKEN=${FAKE.envToken}\nDB_PASSWORD=${FAKE.dbPassword}`, { type: 'text', file: { filePath: `${cwd}/.env`, content: FAKE.envValue } });
  asst([{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'cat .env' } }]);
  result('toolu_02', `API_KEY=${FAKE.envValue}\nTOKEN=${FAKE.envToken}`, { stdout: FAKE.envValue, stderr: '', interrupted: false, isImage: false });
  asst([{ type: 'tool_use', id: 'toolu_03', name: 'Edit', input: { file_path: `${cwd}/.env.local`, old_string: 'A=1', new_string: `A=${FAKE.envValue}` } }]);
  result('toolu_03', 'The file has been updated.', { filePath: `${cwd}/.env.local`, oldString: 'A=1', newString: `A=${FAKE.envValue}`, originalFile: FAKE.envValue, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A=1', `+A=${FAKE.envValue}`] }] });
  asst([{ type: 'tool_use', id: 'toolu_04', name: 'Read', input: { file_path: `${home}/.ssh/id_rsa` } }]);
  result('toolu_04', `-----BEGIN OPENSSH PRIVATE KEY-----\n${FAKE.sshBody}\n-----END OPENSSH PRIVATE KEY-----`, { type: 'text' });
  asst([{ type: 'tool_use', id: 'toolu_05', name: 'Bash', input: { command: 'printenv' } }]);
  result('toolu_05', `HOME=${home}\nSECRET=${FAKE.envValue}`, { stdout: FAKE.envValue, stderr: '', interrupted: false });
  asst([{ type: 'tool_use', id: 'toolu_06', name: 'Bash', input: { command: `cd ${cwd} && npm test`, description: 'run tests' } }]);
  result('toolu_06', `> test\nrunning in ${cwd}\nPASS src/a.test.js\nleaked: ${FAKE.anthropic}\nseed: ${SEED}\n${PEM}\nrpc ${FAKE.alchemy}\n`, { stdout: 'x', stderr: '', interrupted: false, isImage: false });
  asst([{ type: 'tool_use', id: 'toolu_07', name: 'Edit', input: { file_path: `${cwd}/src/app.ts`, old_string: 'a', new_string: 'b' } }]);
  result('toolu_07', 'The file has been updated.', { filePath: `${cwd}/src/app.ts`, structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 4, lines: [' keep', '-old line', '+new line one', `+// ${FAKE.anthropic}`, '+new line three'] }] });
  asst([{ type: 'tool_use', id: 'toolu_08', name: 'Write', input: { file_path: `${cwd}/notes.md`, content: `# notes\nseed ${SEED}\n` } }]);
  result('toolu_08', 'File created successfully', { type: 'create', filePath: `${cwd}/notes.md`, content: 'x', structuredPatch: [] });
  asst([{ type: 'tool_use', id: 'toolu_09', name: 'Grep', input: { pattern: 'password', path: cwd } }]);
  result('toolu_09', `.env:2:DB_PASSWORD=${FAKE.dbPassword}\nsrc/db.js:7:const password = process.env.DB_PASSWORD`, { mode: 'content' });
  asst([{ type: 'tool_use', id: 'toolu_10', name: 'Read', input: { file_path: `${cwd}/shot.png` } }]);
  result('toolu_10', [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }], { type: 'image', isImage: true });
  asst([{ type: 'tool_use', id: 'toolu_11', name: 'Agent', input: { description: 'explore the repo', prompt: `secret prompt ${FAKE.anthropic}` } }]);
  L.push(base('user', { isSidechain: true, message: { role: 'user', content: `sidechain ${FAKE.thinking}` } }));
  L.push(base('attachment', { attachment: { type: 'x', text: FAKE.attachment } }));
  result('toolu_11', [{ type: 'text', text: 'subagent done: all good' }], { status: 'completed' });
  asst([{ type: 'tool_use', id: 'toolu_12', name: 'mcp__server__do_thing', input: { q: 'x'.repeat(5000), token: FAKE.envToken } }]);
  result('toolu_12', 'ok', {}, { is_error: false });
  asst([{ type: 'text', text: `done. password=${FAKE.dbPassword}` }]);
  return L.map((o) => JSON.stringify(o));
}
