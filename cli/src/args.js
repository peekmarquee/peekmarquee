// Tiny argv parser (no dependency).
const VALUE = new Set(['file', 'agent', 'title', 'wallet', 'relay', 'hide']);
const BOOL = new Set(['private', 'no-replay', 'no-prompts', 'dry-run', 'from-start', 'help', 'version']);

export function parseArgs(argv) {
  const o = { command: 'stream', hide: [], errors: [] };
  const rest = [...argv];
  if (rest[0] === 'delete') { o.command = 'delete'; rest.shift(); }
  while (rest.length) {
    const a = rest.shift();
    if (a === '-h') { o.help = true; continue; }
    if (a === '-v') { o.version = true; continue; }
    if (!a.startsWith('--')) {
      if (o.command === 'delete' && !o.id) { o.id = a; continue; }
      o.errors.push(`unexpected argument: ${a}`);
      continue;
    }
    let [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL.has(name)) { o[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true; continue; }
    if (VALUE.has(name)) {
      const v = inline !== undefined ? inline : rest.shift();
      if (v === undefined || (inline === undefined && v.startsWith('--'))) { o.errors.push(`--${name} needs a value`); continue; }
      if (name === 'hide') o.hide.push(v); else o[name] = v;
      continue;
    }
    o.errors.push(`unknown option: --${name}`);
  }
  return o;
}

export const HELP = `peekmarquee - stream your Claude Code session to a public link (read-only)

Usage
  npx peekmarquee [options]            run in the folder where Claude Code is running
  npx peekmarquee delete <id>          delete a stream and its replay now

Options
  --title "<text>"     title shown to viewers (max 80 chars; default "Untitled session")
  --wallet 0x...       wallet that receives tips (EIP-55 checked); without it there is no Tip button
  --private            unlisted: not in the live directory or public stats
  --no-replay          relay keeps nothing; the stream disappears when you stop
  --no-prompts         do not send your prompts, only what the agent does
  --hide <glob|/re/>   extra redaction (repeatable), e.g. --hide "acme-*" --hide "/cust_\\d+/"
  --file <path>        tail this transcript .jsonl instead of auto-detecting
  --agent claude       only "claude" is supported in this version
  --from-start         also send what is already in the transcript (default: only new activity)
  --dry-run            do not connect; print exactly the events that WOULD be sent (already redacted)
  -h, --help  -v, --version

Nothing is sent from your machine except those events. cwd, branch and folder names are never sent.
`;
