# outbe-chain drift: d7c78459 → 7a0aff51

PR #1 (`chore/outbe-chain-sync-20260918`, head `72b7995`) syncs the app to outbe-chain `d7c784592b51`. Upstream `main` is now `7a0aff51bbcf` (2026-10-09). That is 137 commits later and touches 325 files under `contracts/`. Everything below was found by diffing the two commits read-only. Nothing was changed, built or run against the new pin.

Most of this drift is hidden today. `config/abi/abi-pin.json` and `check-contract-profile.mjs` keep the submodule at `d7c78459`, so the build still passes. The breakage starts as soon as the pin is bumped, or as soon as the app points at a deployment built from current upstream.

Severity key:

- **REVERT**: a call or transaction fails.
- **WRONG**: the app silently shows wrong values or loses evidence.
- **ABI-NAME**: works today only because decoding is positional. It breaks when the ABI is regenerated.
- **HARNESS**: affects the local Anvil overlay only.

## 1. Signing profile changed (critical)

**REVERT** (stranded bond). `#549 3c9a9e3b "sign bids in units"` renamed the EIP-712 field:

```text
RevealBid(uint32 worldwideDay,address bidder,uint16 units,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)
```

The field type and position are unchanged, but the type string is different, so the typehash, the digest, the signature and `commitHash` all change. The app still signs `quantity` (`src/receipts/reveal-material.ts:17`). Against a 7a0aff51 deployment, the commit succeeds. The reveal then reverts with `RevealHashMismatch`, so the bond stays stranded until `revealEnd + 24h`.

Fix:
- Add a new profile/schema that signs `units`.
- Keep the `quantity` shape as a historical receipt profile only.
- Update the "Current commit/reveal profile" sections in `AGENTS.md` and `docs/current-production-contract-profile.md`.
- Update the golden digest test (`dev/local-chain/blockchain/test/foundry/helpers/GoldenRevealDigest.t.sol`).

## 2. IntexAuction

| # | Upstream change (7a0aff51) | App location | Impact |
|---|---|---|---|
| 2a | The whitelist gate was removed: no `whitelist()`, no `setWhitelist`, no `requireWhitelisted` in `commitBid`. `contracts/shared/src/Whitelist.sol` was deleted. | `src/bidding/commit-transaction.ts:52-147` (`requireWhitelistEligibility` calls `whitelist()`); `src/chain/revert-classify.ts` `NotWhitelisted`; `config/abi/IntexAuction.json`; the profile doc's "commitBid is whitelist-gated" section | **REVERT**: the preflight `eth_call` hits a missing selector, so **every commit is blocked**. Remove the preflight, the classifier, the ABI entry and the doc claim. |
| 2b | `claimCommitBond` no longer releases a red-day (Cancelled) bond immediately. Every no-reveal bond now waits until `revealEnd + UNREVEALED_BOND_LOCK_PERIOD`. | `src/recovery/recovery-domain.ts:85` (`stage === 'cancelled' ? null`) and its "release immediately" copy | **REVERT**: the app says the bond is claimable now, but the transaction reverts with `CommitBondNotYetClaimable`. |
| 2c | `wire()` no longer refuses to rotate while live locks exist (`EscrowHasLiveLocks` was removed). A day's locks can be split across two escrows. | wiring-epoch recovery and history scan | **WRONG** risk: recovery has to check every escrow epoch for a day, not only the current one. |
| 2d | `AuctionResult.issuedIntexLoadedPromis` → `issuedPromisLoadMinor`. | `venue-adapter.ts:282`, `profile-types.ts:128`, `public-discovery-runtime.ts:195` | **ABI-NAME** |
| 2e | `BidRevealed` arg `quantity` → `units` (topic unchanged). The arg was also renamed in `BidAmountOverflow`. | `completion-adapters.ts:333`, `venue-receipt-evidence.ts:113`, `venue-bid-history.ts:294` | **ABI-NAME** |
| 2f | The legacy `auctions(uint32)` and `revealedBids(uint32,uint256)` getters were removed. | None: a search of `src/`, `dev/local-chain/` and `tests/` found no calls to the removed getters | none |

The escrow lock formula is unchanged. It moved into `BridgeMsgCodec.escrowAmount`, and the operation order is the same.

## 3. EscrowAdapter: push refunds replaced by pull claims (`a763d9fa`, `#430`)

| # | Upstream change | App location | Impact |
|---|---|---|---|
| 3a | `POST_FINALIZE_REFUND_DELAY` was removed. | `src/protocol/venue-adapter.ts:479`, `src/recovery/wallet-recovery-history.ts:523` | **REVERT**: the recovery-constants read fails, which takes down the recovery panel. |
| 3b | `BidLock` changed from `{lockedAmount, lockedAt, status, failedRefund, splitRecorded}` to `{lockedAmount, lockedAt, status, bidRate, quantity}`. | `src/protocol/venue-decode.ts:42-56` | **REVERT/WRONG**: `bidRate` is read as `failedRefund`, which trips the validation and throws. |
| 3c | `LockStatus` value 2 changed from `Finalized` to `Won`. A `Won` lock means the winner's remainder can be claimed immediately. | `venue-decode.ts`, `profile-types.ts:132` (`'finalized'`) | **WRONG** |
| 3d | There is no more split or burn (`BURN_ADDRESS`, `ProceedsBurned`, `failedRefund` were removed). `claimRefund` now pays:<br>• **Won**: `lockedAmount − escrowAmount(quantity, basis, clearingRate)`, immediately.<br>• **Finalized, not named**: full principal, immediately.<br>• **Never finalized**: full principal after `UNFINALIZED_REFUND_DELAY` (72h). | `src/recovery/recovery-domain.ts:170-230` (`escrow-failed-split-refund`, `escrow-no-split-refund`, `burnedAmount`; only triggers on `'locked'`) | **WRONG**: the app shows a burn that never happens and wrong timing, and it never offers winners their remainder. Winner-remainder claim is a **new bidder-facing recovery path**. |
| 3e | New view `getClaimableRefund(day, bidder) → (amount, claimableAt)`. | not in the ABI | Use it as the authoritative refund and timing source instead of recomputing locally. |
| 3f | Asset versions were added: `CommitBond.assetVersion`, `AuctionEscrowState.assetVersion`, `currentAssetVersion`, `getAssetVersion`, `AssetRetired`, `DayAssetRetired`. `LiveLocksOutstanding` was removed. | `venue-decode.ts` CommitBond/AuctionEscrowState, `profile-types.ts:159-170` | **WRONG/ABI**: returned tuples are longer, and the app has no asset-version awareness. |
| 3g | `finalizeAuction` now takes winners plus clearing terms. `lockFunds` takes 5 arguments. `FinalizationInstruction` and `processFinalizationOne` were removed. | `config/abi/EscrowAdapter.json` | **ABI** only (relayer/auction-role calls) |
| 3h | `check-contract-profile.mjs:165` forbids only older symbols. | | After the bump, the guard would pass against a stale ABI. Add the removed symbols to the forbidden list and require the new ones. |

The `AGENTS.md` rules that say "display exact returned amount and burned remainder" and "post-finalize refund delay" need revising so they match the claim model.

## 4. IntexNFT1155

| # | Upstream change | App location | Impact |
|---|---|---|---|
| 4a | `SeriesData.status` was **removed from the middle** of the struct, between `totalSupply` and `state`. | `completion-adapters.ts:162-172` `readData`; `config/abi/IntexNFT1155.json` | **WRONG/REVERT**: with the stale ABI, `state`, `worldwideDay` and `seriesId` decode shifted by one field, so the lifecycle and day are wrong. Regenerate the ABI and fix the decoders together. |
| 4b | `OwnerBalances {issued, settled}` → `{issuedUnits, settledUnits}`. Event args `quantity`/`amount` → `units`. `IntexStatusUpdated.callDeadlineAt` → `settlementDeadline`. | balance enumeration, completion | **ABI-NAME** |
| 4c | `Qualified` is now derived and never stored. The enum values are unchanged. `isQualified`, `vwapSource`, `setVwapSource`, `name`/`symbol` were added. `issue` → `issueIntex`. `markQualified` was removed. | lifecycle decoder | none, apart from a dead branch |

## 5. Outbe origin (Desis / Metadosis / Intex / Oracle)

| # | Upstream change | App location | Impact |
|---|---|---|---|
| 5a | `UnusedSupplyReported(uint32,uint256 unusedPromis)` was **removed**. It was replaced by `UnusedDesisLimitReported(uint32,uint256 unusedDesisLimitMinor)` and `DesisAllocationRecorded(uint32,uint256,uint256)`, which carry different semantics (a Desis-Limit amount). | `src/discovery/calendar-evidence.ts:426-494`, offered-quantity math at `:1040`, `:1231` | **WRONG**: the scan silently returns nothing, so offered quantity loses its unused-supply evidence. This needs a product decision on how to derive offered quantity from the new events. |
| 5b | New cancellation events: `AuctionCancelledBelowOneUnit(uint32,uint256,uint128)` and `AuctionCancelledLateStart(uint32)`. | calendar cancellation scan | **WRONG**: these cancelled days are not recognized. |
| 5c | `AuctionBriefRejectedToCarryOver` args were renamed. | `config/abi/IDesis.json` | **ABI-NAME** |
| 5d | `IIntex.SeriesView` gained a trailing `uint64 settlementDeadline`. | `config/abi/IIntex.json` | Low. It is a trailing field, and it gives an authoritative source for the expiry deadline. |
| 5e | Metadosis fields were renamed to `*Minor` (`previousVwapMinor`, `promisLimit*Minor`, and others). `ReferenceCurrencyUnpriced` was removed. The tuple shapes are unchanged. | `origin-adapter.ts`, `profile-types.ts` | **ABI-NAME** |
| 5f | Oracle `getFourHourVwap` was replaced by snapshot-VWAP reads. | not used | none |

`AuctionCleared` was already `issuedUnits` at d7c78459. That mismatch is not new; it is the `issuedIntexCount` drift PR #1 already lists as retained. `ChainSkipped`, `AuctionCancelledUnpriced` and `AuctionClearedEmpty` are unchanged.

## 6. Routers

These are unchanged, so the app's scans stay valid: `MessageParked`, `IssuanceParked`, `ParkedIssuanceApplied`, `IssuanceInstructionsReceived`, `BidsDone*` and `getSeriesPaginated`.

What did change:
- `sendMarkQualified` and `MarkQualified*` events were removed.
- `sendDailyVwap` and `VwapRegistry` were added. `TargetRouter` now has `setVwapRegistry`.
- `MarkParked` and `ParkedMarkApplied` dropped their `msgType` topic.

The app does not scan any of these.

## 7. Local Anvil overlay (HARNESS)

- `LocalProtocolController.sol:840-843` calls `originRouter.sendMarkQualified`. This **fails to compile** after the bump. It is also used by `local-control.mjs:112,582`.
- `LocalProtocolController.sol:208-234` still has `relayGeneration` in `processBidsBatch` and `processBidsDone`. Upstream `IDesis` dropped it, so OriginRouter's 4-argument `processBidsDone` selector will not reach the mock and inbound bid fan-in reverts.
- `DeployLocal.s.sol` never deploys or wires a `VwapRegistry`.
- The `foundry.toml` comment that mentions Whitelist is stale.

## Suggested order

1. Signing (§1) and the whitelist preflight (2a). Without these, commits are blocked or bonds get stranded.
2. Escrow claim model (§3) and the red-day bond gate (2b). These cover the recovery reverts, wrong amounts and the missing winner-remainder claim.
3. The `SeriesData` reorder (4a) and the unused-supply/cancel events (5a, 5b).
4. Regenerate the bundled ABIs from `contracts/intex/abi-export/` and `contracts/precompiles/abi-export/`, and do the ABI-NAME renames at the same time.
5. Fix the overlay (§7). Bump `abi-pin.json` and extend `check-contract-profile.mjs`.

## Not verified

- Live deployments: none are configured.
- Rust runtime behaviour beyond the interface and event changes, for example Desis clearing semantics behind `DesisAllocationRecorded`.
- `docs/` and `adr/` prose changes upstream. Only the contract and interface diffs were reviewed in depth.
