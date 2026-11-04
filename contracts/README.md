# TipJar (PEEKMARQUEE)

`src/TipJar.sol` — one file, 37 lines, Solidity 0.8.24. No owner, no proxy, no upgrade, no withdraw, no constructor args.

## What it does
- `tip(bytes32 streamId, address payable streamer)` payable: requires `msg.value >= MIN_TIP` (0.00001 ETH; lowered from 0.0001 before deploy), rejects `streamer == 0` and `streamer == jar`, updates counters, emits `Tipped(streamId, from, streamer, amount)`, then forwards **100% of `msg.value` to `streamer` in the same call**. If the forward fails the whole tx reverts (`TransferFailed`) — funds never sit in the contract.
- On-chain counters (one `eth_call` each): `totalTipped()` (wei, gross), `tipCount()`, `receivedBy(address)`, `receivedFor(bytes32)`.
- `streamId = keccak256(bytes(id))` (computed by web/server).
- `receive()` / `fallback()` revert `NoDirectDeposits` — a plain `cast send <jar> --value …` fails.
- Event topic0 `Tipped(bytes32,address,address,uint256)` = `0xf16c198d9bc7f2358560566aabe9b43412ab77e09fb1db215be50ebb4843e1ee` (streamId, from, streamer indexed; amount in data).

Known and documented behaviour:
- Totals are **gross and unfiltered**: anyone can tip anyone, including themselves. A re-entrant streamer contract that re-tips counts the same wei once per hop (tested).
- A streamer address whose `receive()` reverts (or a contract without one) cannot be tipped: the tipper's tx fails, nothing gets stuck.
- ETH can only end up in the jar by force (selfdestruct beneficiary / block reward). It would be unrecoverable; normal use keeps `balance == 0` (invariant-tested).
- Gas (from tests, excl. 21k base): first tip to a fresh streamer account ≈162k, repeat tip same stream/streamer ≈62k. On Robinhood Chain at ~0.02 gwei that is < 0.000005 ETH.
- `block.number` on this chain is not the L2 block; take `deployBlock` from the deploy receipt.

## Build & test
```bash
cd contracts
forge build
forge test                       # unit + fuzz (1000 runs) + invariant (256 runs × depth 32)
forge test --fork-url https://robinhood-rpc.publicnode.com --match-contract TipJarForkTest -vv   # mainnet 4663 fork, no funds needed
```
Tests: `test/TipJar.t.sol` (forward 100%, exact event, MIN_TIP/MIN_TIP-1/zero value, `address(0)`/`address(jar)`, reverting streamer, bouncing streamer, re-entrant streamer, plain send / fallback revert, counter accumulation, self-tip, gas, fuzz), `test/TipJar.invariant.t.sol` (jar balance always 0; `totalTipped`/`tipCount`/`receivedBy`/`receivedFor` equal the sums of emitted `Tipped` logs), `test/TipJar.fork.t.sol` (deploy + tip on a mainnet fork; skipped unless chainid 4663).

## Deploy (maintainers only — testnet 46630 first, then mainnet 4663)
Script reads no env vars and no files; the signer comes only from CLI flags.
```bash
cd contracts
# 1) simulate (no broadcast)
forge script script/Deploy.s.sol:Deploy --rpc-url <RPC> --sender <DEPLOYER_ADDRESS>

# 2) broadcast
forge script script/Deploy.s.sol:Deploy --rpc-url <RPC> \
  --keystore <KEYSTORE_PATH> --password-file <PASSWORD_FILE> \
  --sender <DEPLOYER_ADDRESS> --broadcast
```
`<RPC>`: testnet `https://robinhood-sepolia-rpc.publicnode.com`, mainnet `https://robinhood-rpc.publicnode.com`.
Simulated (05-11-2026): ~263k gas (`cast estimate`), forge gas limit 342,136; at 0.021 gwei ≈ 0.0000055 ETH (forge reserves ≈0.000014 ETH at its max fee). Deployer balance 0.0001 ETH covers it.

Then read the address, tx hash and **block number from the receipt** (`broadcast/Deploy.s.sol/<chainId>/run-latest.json`, or `cast receipt <tx> --rpc-url <RPC>`) into `web/deployments.json` → `chains.<chainId>.{address,deployBlock,deployTx,deployer}`.

## Verify
Mainnet (4663):
```bash
forge verify-contract <JAR> src/TipJar.sol:TipJar --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
forge verify-contract <JAR> src/TipJar.sol:TipJar --chain-id 4663 --verifier sourcify
```
Testnet (46630):
```bash
forge verify-contract <JAR> src/TipJar.sol:TipJar --chain-id 46630 \
  --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
forge verify-contract <JAR> src/TipJar.sol:TipJar --chain-id 46630 --verifier sourcify
```
Check: `curl -s https://sourcify.dev/server/v2/contract/<CHAIN_ID>/<JAR>` and the Blockscout "Contract" tab. Set `verified.*` to `true` in `web/deployments.json` afterwards.

## Post-deploy acceptance check
```bash
cast call <JAR> "totalTipped()(uint256)" --rpc-url <RPC>
cast call <JAR> "tipCount()(uint256)" --rpc-url <RPC>
cast logs --from-block <DEPLOY_BLOCK> --address <JAR> "Tipped(bytes32,address,address,uint256)" --rpc-url <RPC>
cast send <JAR> --value 0.0001ether ...   # must fail: NoDirectDeposits
```
Sum of `amount` over all `Tipped` logs must equal `totalTipped()`, log count must equal `tipCount()`, and `cast balance <JAR>` must be 0.

---

# TipJar v2 (multi-token) — `src/TipJarV2.sol`

v1 (`src/TipJar.sol`) is left untouched for verification history; v2 is a new contract. 72 lines, solc 0.8.24, `evm_version = paris`, no owner, no proxy, no constructor args, holds no ETH and no tokens.

## What changes vs v1
- `tip(bytes32 streamId, address payable streamer)` — **identical** to v1 (MIN_TIP 0.00001 ETH, same checks, counters, `Tipped` event, reentrancy lock, `TransferFailed`).
- New `tipToken(bytes32 streamId, address streamer, address token, uint256 amount)` (non-payable):
  - reverts `TipTooSmall` if `amount == 0`, `BadStreamer` if `streamer` is `0`/the jar, `BadToken` if `token` has no code, `Reentrant` if called while the lock is held.
  - calls `token.transferFrom(msg.sender, streamer, amount)` with a low-level call: tokens that return nothing (USDT-style) are accepted; a failed call or any return value other than `true` reverts `TransferFailed`. Tokens go **tipper → streamer directly**, never through the jar. Needs a prior `approve(jar, amount)` (web: exact amount, not unlimited).
  - records what the streamer **actually received** (`balanceOf(streamer)` after − before; fee-on-transfer safe). If that is 0 (incl. a token that returns `true` but moves nothing, or `streamer == msg.sender`) it reverts `TransferFailed`.
  - counters `tokenTotal(address token)` (units actually received, all streamers) and `tokenTipCount()`; event `TippedToken(bytes32 indexed streamId, address indexed from, address indexed streamer, address token, uint256 amount)`, topic0 `0xf44c239c3c80b9f21e38838ae339d6851f5d4aa89e1fddbe4619621c302c4e4d` (token + received amount in data).
  - the same `_locked` flag covers the whole `balanceOf → transferFrom → balanceOf` sequence, so a token callback (ERC-777-style hook) cannot re-enter `tip()` or `tipToken()`. Counters and the event are written after the external calls (needed to know `received`); this is safe because of the lock (forge lint `reentrancy-*` notes are expected).
- Token tips do not touch the ETH counters (`totalTipped`, `tipCount`, `receivedBy`, `receivedFor`). There is no per-stream token counter on-chain: per-stream/per-streamer token totals come from `TippedToken` logs.
- Permissionless for any token. `tokenTotal` of a token is only as honest as that token's `balanceOf`; the server must only show allow-listed tokens (ETH, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` 6 dec, MARQ after T0).
- Differences from v1 that are intentional: token **self-tips revert** (balance does not grow), so `tokenTotal` cannot be pumped by tipping yourself; ETH self-tips are still allowed as in v1 (gross, unfiltered).

## Gas (measured)
| call | gas (excl. 21k base) |
|---|---|
| `tip` ETH, first tip to fresh account / repeat | ≈184k / ≈84k (unit), ≈182k (fork) |
| `tipToken` mock ERC-20, new holder / repeat | ≈141k / ≈81k |
| `tipToken` **real USDG** on 4663 fork, new holder / repeat | ≈158k / ≈107k |
| deploy (`cast estimate --create`, 4663 and 46630) | **534,597** |

Deploy simulation 05-11-2026 (`forge script`, no broadcast, sender `0x806a…Ef73`): forge gas limit 694,976; mainnet base fee 0.0206 gwei → ≈0.000011 ETH actual (forge reserves 0.0000286 ETH at its max fee), testnet 0.01 gwei → ≈0.0000053 ETH (reserve 0.0000139). Deployer balance at simulation: 0.0000944 ETH (4663), 0.0000960 ETH (46630) — enough for both.
Runtime code size 2,204 bytes.

## Tests
- `test/TipJarV2.t.sol` — `TipJarV2EthTest`: every v1 ETH case re-run against v2 (19 incl. 2 fuzz); `TipJarV2TokenTest` (23 incl. 2 fuzz): ERC-20 happy path + exact event, counters across tokens, exact-approve then second tip fails, no-return-value token (+ without allowance), false-returning token, token that returns true but moves nothing, fee-on-transfer (records 99%), blacklisting token, insufficient balance, zero amount, streamer `0`/jar, token without code / `address(0)`, non-token contract, re-entrant token callback into `tipToken` and into `tip` (blocked, whole tx reverts), re-entry caught by token → `Reentrant` and tip counted once, ETH sent to `tipToken` rejected, token self-tip reverts, gas.
- `test/TipJarV2.invariant.t.sol` (256 runs × depth 32, `fail_on_revert`): jar ETH balance 0; jar balance of every token (standard, no-return, false, fee, blacklist) 0; ETH counters == `Tipped` sums; `tokenTotal`/`tokenTipCount` == `TippedToken` sums; false-returning token never counted.
- `test/TipJarV2.fork.t.sol` (skipped unless chainid 4663): deploy on mainnet fork, ETH tip, real **USDG** tip via `deal` + exact approve (allowance back to 0, second tip reverts), insufficient USDG reverts.

```bash
forge test
forge test --fork-url https://robinhood-rpc.publicnode.com --match-contract TipJarV2ForkTest -vv
```

## Deploy v2 (maintainers only — testnet 46630 first, then mainnet 4663)
```bash
# simulate (no broadcast)
forge script script/DeployV2.s.sol:DeployV2 --rpc-url <RPC> --sender <DEPLOYER_ADDRESS>
# broadcast
forge script script/DeployV2.s.sol:DeployV2 --rpc-url <RPC> \
  --keystore <KEYSTORE_PATH> --password-file <PASSWORD_FILE> --sender <DEPLOYER_ADDRESS> --broadcast
# verify
forge verify-contract <JAR2> src/TipJarV2.sol:TipJarV2 --chain-id <CHAIN_ID> --verifier sourcify
forge verify-contract <JAR2> src/TipJarV2.sol:TipJarV2 --chain-id 4663 \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
```
Then `web/deployments.json`: v2 → `address`/`deployBlock`/`deployTx`, v1 → `retired`.

Post-deploy check (v2):
```bash
cast call <JAR2> "MIN_TIP()(uint256)" --rpc-url <RPC>          # 10000000000000
cast call <JAR2> "tokenTotal(address)(uint256)" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 --rpc-url <RPC>
cast logs --from-block <DEPLOY_BLOCK> --address <JAR2> "TippedToken(bytes32,address,address,address,uint256)" --rpc-url <RPC>
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" <JAR2> --rpc-url <RPC>   # must be 0
```
