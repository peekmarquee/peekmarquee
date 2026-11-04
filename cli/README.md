# peekmarquee

Your coding agent, live. Anyone can watch it build.

```
npx peekmarquee
```

Run it in the folder where Claude Code is running. It prints a public link in seconds. Works with Claude Code.

- **Read-only.** Viewers can't type into your session; there is no channel from the page back to your terminal. The CLI only accepts three message types from the relay (`ack`, `viewers`, `error`) and never executes anything it receives.
- **Secrets are hidden on your machine, before anything leaves it.** The relay runs the same filter again.
- **See exactly what would be sent:** `npx peekmarquee --dry-run` connects to nothing and prints the events (JSON lines, already redacted) that would be sent.
- Replays stay 24 hours, then they're deleted. Delete earlier with `npx peekmarquee delete <id>`.
- Unlisted streams: `--private` keeps the link out of the directory and the stats.
- The CLI's source is readable in the npm tarball (no minification).

Codex support is being verified against real session files; not claimed yet.

## Usage

```
npx peekmarquee [options]
npx peekmarquee delete <id>

--title "<text>"     title shown to viewers (max 80 chars, default "Untitled session")
--wallet 0x...       wallet that receives tips (EIP-55 checked); without it there is no Tip button
--private            unlisted: not in the live directory or public stats
--no-replay          the relay keeps nothing; the stream disappears when you stop
--no-prompts         do not send your prompts, only what the agent does
--hide <glob|/re/>   extra redaction, repeatable (e.g. --hide "acme-*" --hide "/cust_\d+/")
--file <path>        tail this transcript (.jsonl) instead of auto-detecting
--from-start         also send what is already in the transcript (default: only new activity)
--agent claude       only "claude" in this version
--dry-run            print what would be sent; connect to nothing
```

Requires Node 18 or newer. Dependencies: `ws`, `picocolors`, `qrcode-terminal`. Environment: `PEEKMARQUEE_RELAY` overrides the relay (default `wss://peekmarquee.live`).

While live, the terminal shows one status line, for example `● LIVE 12:34 · 3 viewers · 37 secrets hidden · last: Edit src/app.ts`, and a small QR code of the link. Ctrl+C ends the stream and prints the replay link and a summary.

## What is sent

Per session event, after redaction and truncation: your prompts (unless `--no-prompts`), the agent's text, tool calls (tool name, a short summary, trimmed arguments), tool results (up to 4 KB), and file edits (path, +/- counts, a short diff). Never sent: the agent's thinking, usage data, your working directory, git branch, or folder names (absolute paths are rewritten to `.` and `~`), and any transcript entry that is not a user or assistant message. Your stream token is stored in `~/.config/peekmarquee/streams.json` (mode 0600) so `delete` can work.

Results of tools that touch sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/*`, `.aws/*`, `.npmrc`, `credentials*`, `secrets*`, wallet and keystore files and similar) and of environment dumps (`printenv`, `env`, `gh auth token`, ...) are replaced by a placeholder. Well-known secret formats (API keys, tokens, JWTs, private keys, seed phrases, credentialed URLs, paid RPC URLs, `Authorization` headers, `password=` style pairs) and long high-entropy strings are replaced with `[redacted:<class>]`. The original text, its length and its hash are never sent.

## What it can't catch

- Secrets without a known prefix and with low entropy (for example a password like `hunter2`) are not caught unless a keyword such as `password` or `token` is on the same line.
- Secrets split over several lines, spelled out character by character, or inside images and screenshots are not caught.
- Personal content that is not a secret (customer names, emails, database rows that get printed) is not caught unless you pass `--hide`.
- Redaction uses regular expressions, not an understanding of context. Transaction hashes and addresses are left visible on purpose. Git branch names that appear inside command output are not removed.
- Use `--dry-run` to check before you go live. **Don't stream a session that holds production credentials.**

If something slips through: `npx peekmarquee delete <id>` removes the stream and its replay immediately.

## Development

`npm test` (Node 20+). `shared/` in the repository root holds the redaction and wire-schema modules; `scripts/sync-shared.mjs` copies them into `src/shared/` so the tarball is self-contained.
