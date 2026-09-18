# Implementation decisions — binding

**Date:** 2026-09-18. Supersedes the open questions in `outbe-chain-divergence-plan-20260918.md` §4.
Evidence: `outbe-chain-divergence-validation-20260918.md`. Chain: `d7c78459`.

---

## Decision 1 — D1 is fixed now; G1 stays deferred

The judge's plan deferred both. Splitting them is cheaper and more correct.

**Rule adopted: sync *shape* drift, tolerate *name* drift.** ABI field names do not affect positional tuple decoding; field count and types do.

**D1 — fix now.** `costAmountMinor` is verified dead: the only references are the decode line `src/protocol/origin-adapter.ts:315` and the optional type field `src/protocol/profile-types.ts:86`. No consumer. So:
- Replace `config/abi/IIntex.json`'s `SeriesData` tuple **verbatim** from `blockchain/outbe-chain/contracts/precompiles/abi-export/IIntex.json` (18 fields, ending `worldwideDay, settledUnits, exercisedUnits, gemFactoryUnits`; field 5 is `issuedUnits`).
- Delete `costAmountMinor` from `profile-types.ts` and from the `origin-adapter.ts` decode.
- One line in `origin-adapter.ts` reads `raw.issuedUnits` instead of `raw.issuedIntexCount`.

Net effect: a silently-wrong value (a unit count decoded as a monetary amount) is deleted rather than migrated. Net deletion, one renamed read. This is *smaller* than deferring plus documenting.

**G1 — defer.** `IntexAuction.json`, `IDesis.json` and `IIntexNFT1155.json` carry only a **name** change (`issuedIntexCount` → `issuedUnits`) at unchanged positions and types. They decode correctly today. Renaming 23 TS sites is churn with zero behavioural change. The `abi-pin.json` guard assertion is what protects a future regeneration. Do **not** rename the 23 sites.

## Decision 2 — D3: park state comes from `MessageParked` logs only

`sendId == 0` is never used to classify delivery. Parked ⇒ `sendId == 0` is confirmed; the converse is not, and depends on bridge semantics.

Consequence that must not be missed: because the `*Sent` emit is **unconditional** at all eight `_sendOrPark` sites, a surviving `*Sent` event **must stop implying `dispatched`** on its own. A leg is `dispatched` only when a `*Sent` event exists **and** no `MessageParked` for that idx. Absent evidence, report unknown — never "in flight".

## Decision 3 — A3: `PROMIS_SCALE` becomes 1e6, and the duplicate is deleted

Chain: `promisLoadMinor` and `entryPriceMinor` are both 1e6. `deriveStrikeAmountMinor = entry * promisLoad / PROMIS_SCALE` must yield a 1e6-scaled amount, so `PROMIS_SCALE = 1e6`.

The local `PROMIS_SCALE = 10n ** 18n` in `src/oracle/multi-currency-evidence.ts` is **deleted** and the module consumes the single shared constant from `src/domain/protocol-constants.ts`. One scale constant, one definition. `ORACLE_RATE_SCALE` is a different quantity and is left alone.

## Decision 4 — A2: reject an over-100% payment input, never clamp

Silently clamping to `BID_RATE_SCALE` makes a bidder sign the maximum escrow the auction permits. Rejecting is the edge-case-correct option at equal or smaller size. The commit form surfaces a validation error instead of a silent maximum.

---

## Parallel work partition

All agents work in the **same worktree** `/Users/oleg/Documents/Code/itx-wt-chain-sync` on branch `chore/outbe-chain-sync-20260918`. Ownership is **exclusive per file** so concurrent edits cannot collide.

No agent runs any `git` command. No agent runs `npm run check`, `npm run build` or the full suite. Each runs only its own listed test files. Integration, commits and the pin bump are sequential and owned by the orchestrator.

| Chunk | Items | Exclusively owned files |
| --- | --- | --- |
| **A** scale arithmetic | A1 A2 A3 | `src/domain/protocol-constants.ts`, `src/domain/escrow-lock.ts`, `src/domain/commit-domain.ts`, `src/oracle/multi-currency-evidence.ts`, `src/oracle/oracle-chart-model.ts`, `src/ui/display-format.ts` |
| **B** escrow recovery | B5, D4 (recovery side) | `src/protocol/venue-adapter.ts`, `src/protocol/profile-types.ts`, `src/recovery/recovery-domain.ts`, `src/recovery/wallet-recovery-history.ts`, `config/abi/EscrowAdapter.json` |
| **C** completion + D1 | B2 B3 B4 C1 D1 D2, D4 (completion side) | `src/completion/completion-adapters.ts`, `src/completion/completion-loader.ts`, `src/domain/completion-domain.ts`, `src/domain/enum-tag.ts`, `src/protocol/origin-adapter.ts`, `config/abi/IntexNFT1155.json`, `config/abi/TargetRouter.json`, `config/abi/IIntex.json` |
| **D** terminology | F1 | `src/bidding/commit-panel.tsx`, `src/bidding/commit-panel/reveal-receipt-card.tsx`, `src/bidding/receipt-tools.tsx`, `src/completion/completion-card.tsx`, `src/demand/venue-demand-ladder.tsx`, `src/demand/venue-demand-model.ts`, `src/demand/venue-demand-ladder/demand-curve-svg.tsx` |
| **E** origin delivery | B1 D3 F2 | `src/discovery/calendar-evidence.ts`, `src/discovery/public-auction-view-presentation.ts`, `config/abi/OriginRouter.json`, `config/abi/IDesis.json` |
| **F** whitelist preflight | E1 | `src/bidding/commit-transaction.ts`, `src/chain/revert-classify.ts`, `config/abi/IntexAuction.json` |

`src/protocol/profile-types.ts` is owned by **B**. Chunk **C** needs one deletion in it (`costAmountMinor`); C requests it and B applies it, or it is applied sequentially by the orchestrator after both land. C must not edit that file.

Sequential tail, orchestrator-owned: F3 (entry-price source), the submodule pin bump, `config/abi/abi-pin.json`, `scripts/build/check-contract-profile.mjs`, then full verification, then critics.
