# Divergence report validation — outbe-chain `f5477b56` → `d7c78459`

**Validated:** 2026-09-18. **Source report:** `intex-auction-app-divergence-20260918.md` (dated at chain `d5018f7e`).
**Actual chain head validated against:** `d7c78459` ("fix: update Nod namings and logic (#433)"), 192 commits ahead of the pin — two commits newer than the report's baseline. No claim changed as a result.

Every one of the report's 20 claims is **CONFIRMED**. Five carry material corrections; all corrections are additive or design-relevant, none reverse a verdict.

---

## Verdict table

| Claim | Verdict | Severity (validated) | Correction |
| --- | --- | --- | --- |
| A1 escrow lock short by 1e12 | CONFIRMED | Critical | +2 affected sites; truncation order matters |
| A2 payment input saturates rate | CONFIRMED | Critical | code moved to `rawBidRatePercent` |
| A3 price/PROMIS display scales | CONFIRMED | High | wider blast radius (oracle chart, COEN fallback) |
| B1 `parkedSend` → `parkedMessage` | CONFIRMED | High | struct layout unchanged → rename suffices |
| B2 `getOwnedSeriesWithBalancesPaginated` removed | CONFIRMED | High | not in the B3/B4 `Promise.all` |
| B3 `holderBalances` → `ownerBalances` | CONFIRMED | High | pure rename, same args/return |
| B4 `getAuctionWonCount` removed | CONFIRMED | High | — |
| B5 `NO_SPLIT_REFUND_DELAY` removed | CONFIRMED | Critical | invariant genuinely unsatisfiable |
| C1 `IntexState.Expired` derived on read | CONFIRMED | High | throw is on the canonical decoder, not the target path |
| D1 `IIntex.SeriesData` reshaped | CONFIRMED | High | no UI consumer of `costAmountMinor` found |
| D2 TargetRouter park events renamed | CONFIRMED | High | — |
| D3 OriginRouter park events renamed | CONFIRMED | High | 8 emit sites, not 1 |
| D4 `BidderRetried` removed | CONFIRMED | Low | — |
| E1 `commitBid` whitelist-gated | CONFIRMED | High | **pre-check IS possible** — report wrong |
| F1 `bidRate` labelled "of strike" | CONFIRMED | High | 14 sites, report cited 6 |
| F2 `AuctionCancelledUnpriced` never scanned | CONFIRMED | Medium | — |
| F3 entry-price source never read | CONFIRMED | Medium | — |
| G1–G5 latent | CONFIRMED | Low | — |
| Missed divergences | none found | — | independent ABI-vs-interface sweep clean |

---

## Design-relevant corrections

### E1 — a pre-commit eligibility check is possible (report is wrong)

The report claims the app can only surface an unnamed revert after the bidder has signed. Both getters exist:

- `IIntexAuction.whitelist() external view returns (address)` — `contracts/intex/src/target/interfaces/IIntexAuction.sol:235` (impl `IntexAuction.sol:171`)
- `IWhitelist.isWhitelisted(address) external view returns (bool)` — `contracts/shared/src/Whitelist.sol:7`

Zero registry leaves the gate open, by design:

```solidity
function requireWhitelisted(IWhitelist registry, address caller) view {
    if (address(registry) != address(0) && !registry.isWhitelisted(caller)) {
        revert NotWhitelisted(caller);
    }
}
```

Only `commitBid` is gated (single `requireWhitelisted` at `IntexAuction.sol:298`). `revealBid`, `cancelCommit` and the claim paths are not. So a bidder already committed on a gated deployment can always still reveal and recover.

### A1 — truncation order is load-bearing

Chain: `qty * basis * rate / SCALE_1E6 * NATIVE_UNITS_PER_PROTOCOL_UNIT` — truncates at `/1e6` **before** the `*1e12`.
App: `(qty * basis * rate) / BID_RATE_SCALE` — truncates last.

"Multiply the app result by 1e12" is the correct transformation only because the app's truncation point already matches; `(x/1e6)*1e12` and `(x*1e12)/1e6` differ whenever `x % 1e6 != 0`. The fix must keep the divide before the multiply. Pinned upstream by `contracts/intex/test/foundry/cross-chain/LockAmountParity.t.sol`, which also pins that Outbe `Desis.rate_lock` evaluates the identical expression.

`src/domain/escrow-lock.ts` `maxQuantityForEscrowLock` (report omits it) derives its uint128 cap from the same formula and must move to the native-18 ceiling; otherwise the UI accepts quantities that overflow the real lock.

### A3 — confirmed scales, independently

`contracts/intex/src/shared/interfaces/IIntexNFT1155.sol` `SeriesData`:

```solidity
/// @notice PROMIS-units per Intex unit (1e6).
uint128 promisLoadMinor;
/// @notice Per-unit entry price in ISO stable-units (1e6).
uint64 entryPriceMinor;
/// @notice Floor price in ISO stable-units (1e6).
uint64 floorPriceMinor;
/// @notice Call price in ISO stable-units (1e6).
uint64 callPriceMinor;
```

Corroborated by `contracts/precompiles/src/IIntex.sol:24-32` and `crates/core/intex/src/schema.rs:189-197`. App uses `PRICE_SCALE = 1e9` and `PROMIS_DECIMALS = 18`. Both wrong; both 1e6.

`PRICE_SCALE` additionally drives `src/oracle/oracle-chart-model.ts` `priceToChartNumber`, `src/ui/display-format.ts` `formatPrice`, and the `ORACLE_RATE_SCALE / PRICE_SCALE` fallback lift in `src/oracle/multi-currency-evidence.ts` — a wider blast radius than the report states.

### B5 — the invariant cannot be satisfied

`EscrowAdapter` at `d7c78459` exposes exactly three delay constants: `UNFINALIZED_REFUND_DELAY = 72 hours`, `POST_FINALIZE_REFUND_DELAY = 72 hours`, `COMMIT_BOND_ABANDON_DELAY = 30 days`. `claimRefund` gates all three refund cases:

- unfinalized → `lock.lockedAt + UNFINALIZED_REFUND_DELAY`, refunds full `lockedAmount`
- finalized + split recorded → `state.finalizedAt + POST_FINALIZE_REFUND_DELAY`, refunds `failedRefund`, burns the remainder
- finalized + no split → **same** gate, refunds full `lockedAmount`

So the no-split delay does not exist as a separate quantity. Any patch mapping `noSplitRefundDelay` to `POST_FINALIZE_REFUND_DELAY` makes `venue-adapter.ts:501`'s `postFinalizeRefundDelay >= noSplitRefundDelay` true and throws. The concept must be deleted, not remapped. `recovery-domain.ts:210` currently quotes a 30-day wait where the chain permits 72 hours.

### C1 — the throw is on the canonical decoder

`decodeIntexLifecycle` (`src/domain/completion-domain.ts:46-47`) accepts tags 0–2 only and `src/domain/enum-tag.ts` throws on anything else. The chain derives `Expired` (tag 3) without storing it — `IntexNFT1155.sol:503-513`, applied at `:124`, `:498`, `:540`, mirrored by `crates/core/intex/src/schema.rs:268-274`. The app's own `isTargetSeriesExpired` implements the identical formula, same `>` operator and same `calledAt + callNoticePeriod` fields, but the report's claim that it is "unreachable behind the throw" is **not confirmed** — the throw sits on the canonical path, not the target path.

### B2/B3/B4 — two failure paths, not one

`readRecipientEvidence` opens one `Promise.all` at `completion-adapters.ts:214` holding B3 (`holderBalances`) and B4 (`getAuctionWonCount`) — so the "did I win" view fails whole. B2 (`getOwnedSeriesWithBalancesPaginated`) is in `readPortfolio` at `:408`, a separate failure. The report merges them.

Remaining enumeration surface for the B2 rebuild: `getAllSeries()`, `getSeriesPaginated(uint256,uint256)`, `tokenIds(bytes14)`, `ownerBalances(bytes14,address)`, `balanceOfBatch(address[],uint256[])`, `totalSupply(uint256)`, `totalSeries()`.

### D3 — eight emit sites

`_sendOrPark` call sites at `OriginRouter.sol:268, 283, 304, 322, 359, 380, 398`, plus a self-chain direct park at `:510`. Every one emits its `*Sent` event unconditionally with `sendId == 0` on the parked path. Parked ⇒ `sendId == 0` is confirmed; the converse (sent ⇒ non-zero) is **UNRESOLVED** and depends on bridge semantics. Permissionless recovery is `resendParkedMessage(uint256)` at `:214`.

### F1 — 14 sites

`src/bidding/commit-panel.tsx:161,162`; `src/bidding/commit-panel/reveal-receipt-card.tsx:255,343`; `src/bidding/receipt-tools.tsx:114,200`; `src/completion/completion-card.tsx:114,129,134,212`; `src/demand/venue-demand-ladder.tsx:90`; `src/demand/venue-demand-model.ts:255,259`; `src/demand/venue-demand-ladder/demand-curve-svg.tsx:580`.

The separate `Strike amount` / `Total strike amount` rows (`commit-panel.tsx:540,549`; `reveal-receipt-card.tsx:241,242`) are correct and stay.

---

## Why `check-contract-profile.mjs` reported none of this

`scripts/build/check-contract-profile.mjs` validates the bundled ABIs against the submodule source text, and the submodule was pinned to the same commit the ABIs were generated from. The check is tautological under a stale pin. This is itself a finding: the guard cannot detect drift by construction.

---

## Tests that encode the wrong behaviour

Fixing the divergences requires updating these; they currently assert the pre-drift contract.

**Scale (A1/A2/A3):** `tests/unit/src/domain/escrow-lock.test.ts`, `tests/unit/src/domain/commit-domain.test.ts`, `tests/unit/src/oracle/multi-currency-evidence.test.ts` (explicitly "pins the auction price scale to 1e9"). Likely also `tests/unit/src/ui/display-format.test.ts`, `tests/unit/src/oracle/oracle-chart-model.test.ts`, `tests/unit/src/protocol/current-price-authority.test.ts`, `tests/unit/src/discovery/instrument-tooltips.test.tsx`, `tests/unit/src/bidding/commit-view-model.test.ts`.

**Surface (B/C/D):** `tests/unit/src/completion/completion-adapters.test.ts`, `tests/unit/src/discovery/calendar-evidence.test.ts`, `tests/unit/src/recovery/recovery-domain.test.ts`, `tests/unit/src/recovery/wallet-recovery-history.test.ts`, `tests/unit/src/recovery/recovery-transaction.test.ts`, `tests/unit/src/protocol/venue-bidder-adapter.test.ts`, `tests/unit/src/domain/completion-domain.test.ts`, `tests/unit/src/completion/completion-loader.test.ts`, `tests/unit/src/protocol/origin-adapter.test.ts`, `tests/unit/scripts/local/controls/control-status.test.mjs`, `tests/e2e/anvil/phase12-multi-currency-anvil.mjs`, `tests/e2e/anvil/phase9-recovery-anvil.test.mts`, `tests/e2e/anvil/phase10-completion-anvil.test.mts`.

---

## Open questions for the user

1. **G1 forces an ABI-regeneration decision.** Regenerating from `contracts/intex/abi-export/` fixes B1–B4 and D1–D4 wholesale but breaks every `issuedIntexCount` read at once. Hand-patching the bundled ABIs avoids that but leaves the ABIs knowingly divergent. This is the single largest structural choice in the fix.
2. **D3's sent ⇒ non-zero `sendId`** is unresolved. If a successful send can also yield `sendId == 0`, `sendId` alone cannot classify delivery and the park state must come from `MessageParked` logs only.
3. **D1's `costAmountMinor`** has no located UI consumer. Confirm whether the field is genuinely dead before deciding between removing it and remapping it.
