# shared/ — redaction + wire schema (v1 API)

ESM, Node >= 18, zero dependencies. `shared/package.json` has `"type":"module"`.
The CLI keeps a verbatim copy in `cli/src/shared/` (synced by `cli/scripts/sync-shared.mjs`; a test fails if they differ).
Relay: either import directly (`../../shared/redact/index.js`) or copy the two folders into `server/` at build. The CLI keeps its own synced copy in `cli/src/shared/` (`npm run sync-shared`).

Run tests: `cd shared && npm test`.

## `shared/redact/index.js`

```js
import { createRedactor, redactEvent, redactText, clipBytes } from '../shared/redact/index.js';
```

| Export | Purpose |
|---|---|
| `createRedactor({ hide?: string[] })` | Stateful redactor. `.text(str, { entropy = true })` returns the redacted string; `.count` = cumulative replacements (this is the wire `red`; on the relay it becomes `redServer`); `.classes` = per-class counts; `.bump(cls)`; `.reset()`. |
| `redactEvent(event, redactor)` | **Relay second pass.** Returns a NEW wire event with every string in `event.data` redacted (ids, `tool`, `state`, `hidden`, `wallet`, `cli`, `agent` are skipped; `path`/`summary`/args-paths skip the entropy rule). Never touches `seq`, `t`, `type`, `red`. Idempotent: already-redacted text is unchanged and adds 0 to `redactor.count`. Use one redactor per stream: `redServer = redactor.count`. |
| `redactText(str, { entropy?, hide? })` | Stateless; returns `{ text, hits }` (`hits` = class -> count). |
| `clipBytes(str, maxBytes)` | UTF-8-safe truncate -> `{ text, truncated, bytes }` (bytes = original size). Always call AFTER redaction. |
| `classifyTool(tool, input)` | `{ hidden: null \| 'sensitive_path' \| 'env_dump', path? }` — whether a tool result must be hidden entirely (CLI only; the relay never sees tool inputs of results). |
| `isSensitivePath`, `bashTouchesSensitivePath`, `isEnvDumpCommand`, `scrubSensitiveLines`, `compileHide`, `shannon` | building blocks (exported for tests / docs). |
| `CLASSES` | `api_key, token, private_key, seed_phrase, credential_url, jwt, high-entropy, env_value, custom`. Replacement text is always `[redacted:<class>]`. |

Rules in order: PEM (also truncated), JWT, prefixed tokens (sk-, gh*_, github_pat_, glpat-, AKIA, xox*, AIza, ya29., Stripe, SendGrid, npm_, pypi-AgEI, dop_v1_, hf_, r8_, Telegram, Discord), DATABASE_URL-style env values, paid RPC URLs (key segment only), `user:pass@` URLs, secret query params, `Authorization: Bearer|Basic|Token`, `aws_secret_access_key`, `password|secret|token|api_key|…[:=]value` (value >= 8 chars; the key name is kept), 64-hex with key-ish context (see below), BIP-39 runs of >= 12 words, user `--hide`, then entropy.

Decisions / deviations from the spec (all conservative):
- 64-hex: redacted if the line contains `key|private|secret|pk|mnemonic|seed` (as a word, `PRIVATE_KEY` counts), or if the value follows `=`/`:` **unless** the label directly before is `tx|hash|txhash|block|commit|sha*|digest|id|root|checksum|salt|nonce|topic`. Bare tx hashes and 0x40 addresses are untouched.
- Entropy rule additionally requires at least one digit and one letter (pure-letter 32+ runs are identifiers), skips `sha512-…` integrity strings, path-like tokens (>= 2 slashes and no `+`/`=`) and lowercase kebab/snake-case names (>= 4 parts).
- `.env` family also covers `.envrc`; `env` is a dump only when bare (`env FOO=1 cmd` is not).
- Class `custom` is added for `--hide` matches.

Known limits (also for docs): no prefix + low entropy + no keyword (`hunter2`) is not caught; secrets split over lines / spelled out / inside images are not caught; non-secret personal data is not caught; git branch names are not scrubbed.

## `shared/schema/index.js` (wire v1, the spec)

| Export | Purpose |
|---|---|
| `PROTOCOL_VERSION` (1), `LIMITS` | `FRAME_MAX_BYTES` 32768, `FRAME_TARGET_BYTES` 8192, `TITLE_MAX` 80, per-field caps, `RING_BUFFER_EVENTS` 2000 |
| `EVENT_TYPES`, `STATES`, `HIDDEN`, `END_REASONS`, `SERVER_ERROR_CODES`, `WALLET_RE` | enums |
| `makeEvent(seq, type, data, red, t?)` | envelope `{v,seq,t,type,data,red}` (`red` omitted for hello/end) |
| `makeResume(lastAckedSeq)` | `{v:1,type:'resume',data:{lastAckedSeq}}` (no seq) |
| `validateClientMessage(obj)` | `{ ok:true, kind:'event'\|'resume' }` or `{ ok:false, error }`. Extra fields tolerated. |
| `parseServerMessage(raw)` | CLI side; only `ack`/`viewers`/`error`, else `null` |
| `serverMsg.ack(seq) / .viewers(n) / .error(code,msg)` | relay helpers returning JSON strings the CLI understands |

Additions vs the spec: `hello.data.agentVersion` (optional string, Claude Code version) is sent by the CLI; the relay must tolerate/ignore unknown fields. `tool_result.hidden` is `null` when not hidden; `tool_call.args` is always an object.

## Wire flow the CLI implements (for SERVER)
1. `POST {http}/api/streams {title, agent:'claude', wallet|null, public, replay}` -> `{id, ingestToken, manageKey, url}` (HTTP base = relay URL with `ws`->`http`, `wss`->`https`; errors with HTTP 400 and `{error|msg}` are shown to the user and a new title is asked for).
2. `WS {ws}/ingest/<id>` with header `Authorization: Bearer <ingestToken>`. First frame = `hello` with `seq:1`; subsequent events `seq` 2,3,… contiguous.
3. On reconnect the CLI sends `resume {lastAckedSeq}` first and waits (<= 3 s) for `{type:'ack',seq:<highest stored>}`, then re-sends every buffered event with seq > that ack. No hello on reconnect.
4. CLI sends `end` on exit; `DELETE {http}/api/streams/<id>` with `Authorization: Bearer <ingestToken>` for `peekmarquee delete <id>`.
5. Server close code 4401 / `error bad_token|stream_closed` = fatal for the CLI; `rate_limited` = CLI throttles; `too_large` / close 1009 = CLI re-truncates unacked frames to <= 8 KB.
