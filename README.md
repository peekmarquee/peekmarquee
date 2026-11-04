# PEEKMARQUEE

Your coding agent, live. Anyone can watch it build.

```
npx peekmarquee
```

Run it in the folder where Claude Code is running. It prints a public, read-only link. Secrets are hidden on your machine before anything leaves it. Site: https://peekmarquee.live

| folder | what it is |
|---|---|
| `cli/` | the `peekmarquee` npm package (Node ≥18, 3 dependencies). `npx peekmarquee --dry-run` prints exactly what would be sent and connects to nothing. |
| `shared/` | the redaction filter and wire schema, used by both the CLI and the relay |
| `server/` | the relay: WebSocket ingest, SSE for viewers, replays (24 h), live chat, tip indexer |
| `contracts/` | `TipJarV2` on Robinhood Chain (4663): tips in ETH or any ERC-20 go straight to the streamer in the same call; the contract holds nothing and has no owner. `TipJar` (v1, ETH only) is retired. |
| `web/` | the site source |

Contracts (Robinhood Chain, chain id 4663, source verified on Sourcify):
- TipJarV2 `0x00e1bef6f06ebee0a2ff5741dab8d74d97c10b92`
- TipJar v1 (retired) `0x8d6ca67d3d1335037e876183f61fdd02f7a1bdc4`

Run the tests:

```
cd cli && npm ci && npm test
cd server && npm ci && npm test
cd contracts && forge install foundry-rs/forge-std --no-git && forge test
```

Not audited. No promise of returns. Not affiliated with Anthropic or OpenAI. MIT licence.
