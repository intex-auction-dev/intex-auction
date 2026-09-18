# outbe-chain divergence — chosen implementation plan (JUDGE)

**Date:** 2026-09-18. **Submodule HEAD (verified):** `d7c784592b51a86dee71367e50c2007e5aa0998d`.
**Inputs:** validation doc `outbe-chain-divergence-validation-20260918.md` (authoritative), three candidate plans (A=minimal, B=regen, C=risk-ordered), AGENTS.md, ponytail rubric.
**Scope:** plan only. This document is the single artifact produced.

---

## 1. Scorecard — verified vs falsified claims

I spot-checked every claim below against the real repo (`git -C blockchain/outbe-chain rev-parse HEAD`, `ls`, `grep` on bundled ABI, abi-export, `.sol` source, and app `src/`).

### Verified TRUE

| Claim | Who asserted | What I checked | Result |
| --- | --- | --- | --- |
| Bundled ABIs are pre-drift (`holderBalances`, `getAuctionWonCount`, `getOwnedSeriesWithBalancesPaginated`, `NO_SPLIT_REFUND_DELAY`, `parkedSend`, `SendParked`, `BidderRetried`; no `whitelist`) | A | grep on `config/abi/*.json` | TRUE — all present in bundled, absent/renamed in abi-export |
| `abi-export/` exists for the 5 intex impl contracts | B | `ls contracts/intex/abi-export/` | TRUE — 13 files incl. impl + interfaces |
| A1 escrow-lock stops at `/BID_RATE_SCALE`, never applies `*1e12` | A/B/C | read `src/domain/escrow-lock.ts` | TRUE — `(qty*basis*rate)/BID_RATE_SCALE`, throws on overflow |
| A1 `maxQuantityForEscrowLock` derives cap from same formula | A/C | read escrow-lock.ts | TRUE — `(UINT128_MAX*BID_RATE_SCALE)/(promisLoadMinor*bidRate)` |
| A3 `PRICE_SCALE=1e9`, `PROMIS_DECIMALS=18` | A/B/C | read `protocol-constants.ts` | TRUE (lines 12, 7) |
| B3 `holderBalances`→`ownerBalances`, same shape | A/B/C | grep bundled vs abi-export IntexNFT1155 | TRUE |
| B2 `getOwnedSeriesWithBalancesPaginated` removed; `balanceOfBatch`/`getSeriesPaginated`/`tokenIds` survive | A/C | grep abi-export IntexNFT1155 | TRUE — replacement surface present |
| B5 `NO_SPLIT_REFUND_DELAY` gone; `POST_FINALIZE_REFUND_DELAY`/`UNFINALIZED_REFUND_DELAY` remain | A/C | grep bundled vs abi-export EscrowAdapter | TRUE |
| D3 `parkedSend`→`parkedMessage`, `SendParked`→`MessageParked`, `resendParkedMessage` added | A/C | grep OriginRouter bundled vs abi-export | TRUE |
| D4 `BidderRetried` removed from EscrowAdapter | A/C | grep abi-export EscrowAdapter | TRUE (absent) |
| E1 pre-check IS possible — `whitelist()` + `isWhitelisted(address)` both exist; not in bundled ABI | A/B/C | grep `IIntexAuction.sol:235`, `Whitelist.sol:7`, bundled IntexAuction | TRUE — report's "impossible" claim is wrong |
| A2 lives in `rawBidRatePercent` | A/C | grep `commit-domain.ts:104` | TRUE |
| C's "23 `issuedIntexCount` usages in src/" | C | `grep -rn issuedIntexCount src \| wc -l` | TRUE — exactly 23 |
| Guard runs in `typecheck` → `check` | — | read package.json | TRUE — `check:contract-profile && tsc` |
| A's anti-tautology: guard reads **live source**, so the moved pin makes it fail the old sigs | A | guard asserts sig ∈ current `.sol`; source now has `parkedMessage` | TRUE — guard fails **today** on `parkedSend`/`SendParked` |

### Verified FALSE / materially wrong

| Claim | Who | What I found | Impact |
| --- | --- | --- | --- |
| "`IIntex.json` is a precompile **with no abi-export**; the resync must extract it via custom solc/hardhat tooling" | **B** | `contracts/precompiles/abi-export/IIntex.json` **exists** (verified `ls`). All 40+ precompile interfaces have abi-exports. | **Collapses B's central justification for building `regen-abis.mjs` extraction tooling.** No custom solc path is needed; the artifacts are already generated and committed upstream. |
| "regen collapses D1/G1 into a clean field rename; compiler enumerates renamed keys" | **B** | abi-export `IIntex.json` **drops** `issuedIntexCount` AND `costAmountMinor` and **adds** `issuedUnits`/`settledUnits`/`exercisedUnits`/`eligibleNominalTotal`/`gemFactoryUnits`. This is a **schema reshape, not a rename.** | The 23 `issuedIntexCount` sites cannot be mechanically "renamed" — there is no 1:1 successor key. B's "compiler-driven rename harvest" understates this as a semantic remodel requiring per-site domain decisions. C's blast-radius warning is the correct read. |
| Guard "validates the pin against itself / compares an ABI to itself" (tautology framing) | B, C (loosely) | Guard asserts each sig ∈ **live `.sol` source** AND ∈ bundled ABI. Tautology holds **only** when pin == ABI-gen commit. With the pin moved, source and ABI disagree and it fails. | A's characterization is the precise one. The durability fix is still needed (a future re-pin that also regenerates ABIs would re-tautologize), but the "compares ABI to itself" description is inaccurate. |
| A: "C1 is not a confirmed break; defer" | A | Validation doc confirms the throw sits on the **canonical** `decodeIntexLifecycle` path (tags 0–2) and the chain now derives tag 3. | A under-rates C1. It is a confirmed throw on a canonical read; a one-line map addition. Not deferrable. |
| B: "DEFERRALS: none … D1 resolved by the build" | B | D1 has no located consumer AND no 1:1 successor field; the build cannot "resolve" a semantic reshape, only surface it. | B's "no deferrals" is a false comfort; D1/G1 genuinely need a user decision (open question 1). |

### Scoring (priority order from the brief)

| Axis | A (minimal) | B (regen) | C (risk-ordered) |
| --- | --- | --- | --- |
| 1. Ponytail | **Strong** — smallest correct diff, hand-patch only named+drifted entries, no new tooling | Weak — builds a generator + PROVENANCE + rewrites 11 ABIs + 25–30 files for 3 money bugs; the generator rests on a false premise | Strong — staged, one runnable check per slice; one unrequested abstraction (Slice 0 gate) |
| 2. Correctness | Strong on A1/B5/E1; **wrong to defer C1**; D3 log-driven correct | Correct on A1/B5; **wrong on IIntex-no-export and "rename" framing** for G1/D1 | **Strongest** — A1 truncation, B5 delete-not-remap, E1 pre-check, D3 log-not-sendId all correct; correctly sizes the G1 reshape |
| 3. Durability | Good — pin-HEAD assertion added to guard | Best-in-theory (generator-equality) but built on false-premise tooling | Good — pin-SHA mismatch fails loudly; per-selector assertions |
| 4. AGENTS.md | Compliant; read-only submodule | Compliant but heavy; risks scope creep the rules warn against | **Most compliant** — explicit scope control, defers G1 with reason, no invented behaviour |
| 5. Reviewability | Good — localized string edits + focused TS | Poor for humans — 250KB JSON churn in one PR (mechanical, but the reshape hides inside it) | Best — every slice independently reviewable |

**Verdict:** No candidate wins outright. **C's staging + correctness + scope discipline is the spine.** **A's precise anti-tautology guard analysis and lazier choices (no `formatPriceMinor9` rename, inline whitelist ABI, hand-patch) are adopted.** **B is rejected as a plan** — its generator tooling rests on a verified-false premise (IIntex has no abi-export) and its "resync makes G1 a mechanical rename" is verified-false (it is a schema reshape). B contributes exactly one idea worth keeping: a **PROVENANCE pin record** consumed by the durability fix, implemented without a generator.

---

## 2. Chosen plan

**Stance:** hand-patch the bundled ABIs for entries the app names AND that drifted (copying the exact entry from the committed `abi-export/` artifact — not hand-typing tuples). Regenerate nothing wholesale this cycle. Defer the G1/D1 `IIntex.SeriesData` reshape to a tracked task pending a user decision, because it has no 1:1 mechanical fix. Ship strictly by user harm.

**Synthesis decisions (justified):**
- **From C:** slice ordering by harm, one runnable check per slice, defer G1/D1 with evidence, C1 is a real fix (against A), delete-not-remap for B5, log-driven D3.
- **From A:** the precise guard analysis (guard already fails on drift; add a pin assertion, don't rebuild it); do **not** rename `formatPriceMinor9` (it's re-exported through 6 files — churn for a cosmetic name); inline the 1-function `IWhitelist` ABI rather than a new config file + guard entry; hand-patch by **copying from `abi-export/`** so tuples are byte-correct, not hand-typed.
- **Rejected from C:** Slice 0 "refuse-to-transact gate." It is an unrequested abstraction (ponytail rung 1). A1/B5 are fixed in the first slices; a separate probe-and-degrade subsystem is net-new behaviour, new copy, and new state for a window that closes as soon as slices 1 and 4 merge. If the fixes ship, the gate guards nothing. **Cut it.**
- **Rejected from B:** `regen-abis.mjs`, `PROVENANCE.json`-as-generator-anchor, wholesale 11-ABI rewrite, precompile solc extraction. All rest on the false IIntex premise or exceed scope.
- **Kept from B (only this):** record the ABI-generation commit SHA in a tiny `config/abi/abi-pin.json` so the guard can fail when the submodule advances past it. No generator.

Each slice = one worktree/branch/PR per AGENTS.md; post-merge `npm run build` is the required integration check (Temporary CI bypass active). Hand-patched ABI entries are **copied verbatim from the matching `blockchain/outbe-chain/contracts/intex/abi-export/*.json`** to guarantee tuple correctness.

### Slice 1 — A1/A2/A3 scale arithmetic (CRITICAL, money; no ABI) — branch `fix/scale-native18`
- **A1** `src/domain/escrow-lock.ts`: add `NATIVE_UNITS_PER_PROTOCOL_UNIT = 10n**12n` (in `protocol-constants.ts`). `calculateEscrowLockMinor`: `((quantity*promisLoadMinor*bidRate)/BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT` — **divide before multiply** (load-bearing: `(x/1e6)*1e12 ≠ (x*1e12)/1e6`; chain `LockAmountParity.t.sol` truncates at `/1e6`). Replace the `>UINT128_MAX` **throw with saturation to `UINT128_MAX`** (chain saturates). `maxQuantityForEscrowLock`: recompute ceiling on native-18: `byLockCap = (UINT128_MAX/NATIVE_UNITS_PER_PROTOCOL_UNIT*BID_RATE_SCALE)/(promisLoadMinor*bidRate)`.
- **A2** `src/domain/commit-domain.ts` `rawBidRatePercent`: reject payment input implying >100% rate rather than silently clamping to `BID_RATE_SCALE`. Keep ceil-division intent.
- **A3** `src/domain/protocol-constants.ts`: `PRICE_SCALE` `1e9`→`1e6`, `PROMIS_DECIMALS` `18`→`6`. Blast radius rides `PRICE_SCALE` automatically into `oracle-chart-model.priceToChartNumber`, `display-format.formatPrice`, and the `ORACLE_RATE_SCALE/PRICE_SCALE` fallback lift in `multi-currency-evidence.coenToQuoteRate`. **Do not rename `formatPriceMinor9`** (re-exported via multi-currency-evidence, used in currency-state, instrument-specification, public-auction-view). Leave one `// name predates 1e6 scale` comment.
  - **Verify** `deriveStrikeAmountMinor`'s local `PROMIS_SCALE=1e18` in `multi-currency-evidence.ts` against a re-pinned test before touching it (open risk — see §4).
- **Runnable checks (3):** `escrow-lock.test.ts` — a case where `qty*basis*rate % 1e6 ≠ 0` asserting divide-then-multiply, plus a saturation case (fails if order flips or throw returns). `multi-currency-evidence.test.ts` — flip the existing "pins to 1e9" assertion to 1e6. `oracle-chart-model.test.ts` — re-pin decimals 9→6.

### Slice 2 — B5 no-split refund invariant deletion (CRITICAL, blocks refund) — branch `fix/b5-no-split-delay`
- `src/protocol/venue-adapter.ts`: remove the `NO_SPLIT_REFUND_DELAY` read from the `Promise.all` and remove the `postFinalizeRefundDelay >= noSplitRefundDelay` throw (fires on any remap — proven wrong path).
- `src/protocol/profile-types.ts`: drop `noSplitRefundDelay` from `VenueRecoveryContractConstants`.
- `src/recovery/recovery-domain.ts`: `escrow-no-split-refund` branch gates on `finalizedAt + postFinalizeRefundDelay` (chain uses the same 72h gate, refunds full `lockedAmount`, burns nothing). Keep the distinct `path`/explanation; **fix the `:210` copy from 30 days to 72h.**
- `config/abi/EscrowAdapter.json`: remove the `NO_SPLIT_REFUND_DELAY` entry (copy the drifted EscrowAdapter shape from abi-export minus BidderRetried — see Slice 5 for D4).
- **Runnable check:** `recovery-domain.test.ts` — finalized + no-split ⇒ `claimableAt == finalizedAt + postFinalizeRefundDelay`, `returnedAmount == lockedAmount`, `burnedAmount == 0`; and `venue-bidder-adapter.test.ts` with a stub escrow lacking `NO_SPLIT_REFUND_DELAY` must **not** throw.

### Slice 3 — C1 Expired lifecycle decode (HIGH, throw on canonical read) — branch `fix/c1-expired-tag3`
- `src/domain/completion-domain.ts` + `src/domain/enum-tag.ts`: add `3:'expired'` to `decodeIntexLifecycle` and the `IntexLifecycle` type. App's existing `isTargetSeriesExpired` (same formula) aligns.
- **Runnable check:** `completion-domain.test.ts` — `decodeIntexLifecycle(3) === 'expired'` and does not throw. (Corrects Candidate A, which wrongly deferred this.)

### Slice 4 — F1 "of strike" mislabel (HIGH, mis-states payment math) — branch `fix/f1-strike-copy`
- 14 sites (exact lines in validation doc): `commit-panel.tsx:161,162`; `reveal-receipt-card.tsx:255,343`; `receipt-tools.tsx:114,200`; `completion-card.tsx:114,129,134,212`; `venue-demand-ladder.tsx:90`; `venue-demand-model.ts:255,259`; `demand-curve-svg.tsx:580`. `bidRate` is a % of escrow basis (`promisLoadMinor`), not "of strike" (terminology rule 4). The separate `Strike amount`/`Total strike amount` rows stay.
- **Runnable check:** one rendered-DOM regression assertion that the `bidRate` label on `commit-panel` does not contain "strike" (AGENTS.md "leave one small rendered-DOM check").

### Slice 5 — ABI surface renames B1/B3/D2/D3/D4 (HIGH) — branch `fix/abi-surface-renames`
Copy each drifted entry verbatim from the matching `abi-export/*.json`.
- **B3** `config/abi/IntexNFT1155.json`: `holderBalances`→`ownerBalances`. Site `completion-adapters.ts:214` (`functionName`) + coerce labels.
- **B1/D3** `config/abi/OriginRouter.json`: `parkedSend`→`parkedMessage`, `SendParked`→`MessageParked`, add `resendParkedMessage`, `ParkedMessageResent`, `parkedMessageCount`. App reads no OriginRouter park events today (origin-adapter uses `targetsOf`/`WorldwideDayCleanedUp`/terminal receipt), so this is ABI + guard only. If `calendar-evidence.ts` references `SendParked`, rename there. **sendId semantics: classify park state from `MessageParked` logs, never `sendId==0`** (converse unresolved — open question 2).
- **D2** `config/abi/TargetRouter.json`: apply only renames for event names the app actually scans (`IssuanceInstructionsReceived` + the two mint events). Sweep abi-export TargetRouter; patch only names with a live scan site. Otherwise ABI + guard only.
- **D4** `config/abi/EscrowAdapter.json`: remove `BidderRetried` (already dropped in abi-export). Delete the scan + `exactRetriedRefund/exactRetriedPaid` fields in `completion-adapters.readBidderCompletion` and `BidderCompletionEvidence`; leave the `deriveBidderEconomics` refund/paid branch (still reached via recovery evidence), just stop feeding retry data. Also drop the dead scan at `wallet-recovery-history.ts:132`.
- **Runnable check:** `completion-adapters.test.ts` — assert `ownerBalances` read path and a string assertion that no `holderBalances`/`BidderRetried`/`parkedSend`/`SendParked` survives in the touched adapters.

### Slice 6 — B3+B4 "did I win" view (HIGH, broken view) — branch `fix/b4-won-count`
- `readRecipientEvidence` `Promise.all` (`completion-adapters.ts:214`) holds B3 + B4 (view fails whole). B4 `getAuctionWonCount` **removed** with no successor getter — derive won-count from the `IntexIssued` logs already scanned (filter `to==wallet`, tokenId==series issued tokenId). If per-series won semantics need a ledger the logs cannot supply, surface **`unknown` economics** rather than fabricate (AGENTS.md: never invent; do not claim delivered without both log + instructions).
- `config/abi/IntexNFT1155.json`: remove `getAuctionWonCount`.
- **Runnable check:** `completion-adapters.test.ts` — win view resolves via `ownerBalances` + derived won-count, no `getAuctionWonCount` call; a `wonCount` derivable from a single `IntexIssued` fixture asserts 1.

### Slice 7 — B2 portfolio rebuild (HIGH, broken view) — branch `fix/b2-portfolio-enum`
- `getOwnedSeriesWithBalancesPaginated` **removed** (`readPortfolio` at `:408`). Keep the paginated `getSeriesPaginated` loop that builds `tokenMap` seriesId→{issued,settled tokenId}. Rebuild the owned step: collect issued+settled tokenIds, call `balanceOfBatch([wallet…], tokenIds)` in page-sized chunks, filter `balance>0`, map through `tokenMap`. Same `PortfolioTokenRow[]` output and same "unmapped owned token throws" invariant. No transfer-history replay (AGENTS.md). Stays paginated (AGENTS.md).
- `config/abi/IntexNFT1155.json`: remove `getOwnedSeriesWithBalancesPaginated`. `balanceOfBatch`/`getSeriesPaginated`/`tokenIds` already present.
- **Runnable check:** `completion-adapters.test.ts` — stub client: 2 series (4 tokenIds), wallet holds 1 issued token ⇒ exactly one row, correct balance; batch-length mismatch throws.

### Slice 8 — E1 whitelist pre-commit preflight (HIGH, avoidable post-signature revert) — branch `feat/e1-whitelist-preflight`
- `config/abi/IntexAuction.json`: add `whitelist()` (copy from abi-export). Add a **1-function `IWhitelist` ABI inline** in the commit adapter (`isWhitelisted(address)`) — no new config file, no new guard entry (lazier than a file per A).
- `src/bidding/commit-transaction.ts`: **before** the EIP-712 sign/approval, read `IntexAuction.whitelist()`; if non-zero, read `IWhitelist.isWhitelisted(bidder)`; if false, throw `CommitPreflightError('This wallet is not whitelisted to commit on this venue.')`. Zero registry = open gate (skip). Only `commitBid` gated — reveal/cancel/claim get no preflight (verified: single `requireWhitelisted` at `IntexAuction.sol:298`).
- **Runnable checks:** unit — non-zero registry + not-whitelisted throws **before** `signTypedData`; zero registry passes. Plus (AGENTS.md wallet-flow rule) one agent-browser/Playwright run with a fake EIP-1193 provider + stubbed `isWhitelisted=false` asserting the panel surfaces the named ineligibility and **no signature popup fires**; read console clean.

### Slice 9 — F2 AuctionCancelledUnpriced scan (MEDIUM) — branch `fix/f2-cancelled-unpriced`
- `src/discovery/calendar-evidence.ts` (or completion-loader): add `AuctionCancelledUnpriced` to the scan set so a cancelled-unpriced auction surfaces instead of appearing stuck.
- **Runnable check:** `calendar-evidence.test.ts` — emitting the event marks the day cancelled-unpriced.

### Slice 10 — F3 entry-price source read (MEDIUM) — branch `fix/f3-entry-price-source`
- Read the stored per-currency entry-price source rather than deriving from live Oracle (terminology rule 4: v2 stored strike terms are contract-authoritative).
- **Runnable check:** `multi-currency-evidence.test.ts` — asserts stored value used, not Oracle-derived.

### Slice 11 — durability: de-tautologize the guard (see §durability) — branch `chore/guard-pin-assertion`

### Deferred (tracked, not fixed this cycle)
- **G1 / D1 — `IIntex.SeriesData` reshape.** `issuedIntexCount` (23 sites) and `costAmountMinor` are **gone**; abi-export adds `issuedUnits`/`settledUnits`/`exercisedUnits`/`eligibleNominalTotal`/`gemFactoryUnits`. No 1:1 mechanical rename exists; `targetAuctionResult()` pivots sale/no-sale on `issuedIntexCount`. This is a semantic remodel needing a user decision (open question 1) and its own task. **Do not touch `config/abi/IIntex.json` in slices 1–11** so the 23 sites keep decoding today's committed shape. Track in `itx-acn`.
- **G2–G5 latent renames** — Low, ride with the deferred resync.

### Merge order (harm-first): 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11.

---

## 3. Durability fix for `check-contract-profile.mjs`

**Verified root cause (precise):** the guard asserts each expected signature appears in the **live submodule `.sol` source** AND in the bundled ABI. Tautology exists **only** when the pin == the ABI-generation commit — then source and ABI necessarily agree. It is **not** "comparing an ABI to itself" (B/C framing); it reads independent source. With the pin at `d7c78459`, the guard **already fails today** on `parkedSend`/`SendParked`/`getOwnedSeriesWithBalancesPaginated` — the drift is detectable (A verified-correct).

**Fix (minimal, no generator):**
1. Update the hand-maintained expected lists to the `d7c78459` names touched in slices 5–8: `parkedMessage`, `MessageParked`, `resendParkedMessage`, `ownerBalances`, add `whitelist`; drop `parkedSend`, `SendParked`, `getOwnedSeriesWithBalancesPaginated`, `getAuctionWonCount`, `NO_SPLIT_REFUND_DELAY`, `BidderRetried`. Add C1 tag-3 selector assertions.
2. Add `config/abi/abi-pin.json` recording the commit the ABIs were hand-patched against (`d7c78459…`). At the top of the guard, read the actual submodule HEAD (`git -C blockchain/outbe-chain rev-parse HEAD`) and **assert it equals `abi-pin.json`**. A future pin bump that does not re-run the divergence review fails loudly. This is the anti-tautology anchor: the guard fails whenever pin ≠ recorded ABI commit, exactly the invisible case the validation doc names. (Adopts B's provenance idea without B's generator.)
3. Keep the source-signature assertions (they are the second, independent axis and catch a rename the pin file misses).
- **Runnable check:** temporarily set `abi-pin.json` to a wrong SHA in a scratch copy ⇒ guard FAILS; restore ⇒ passes. Guard already runs in `typecheck` → `check`.

---

## 4. Open questions (need USER decision before implementation)

1. **G1/D1 `IIntex.SeriesData` reshape (blocking for those reads).** `issuedIntexCount` and `costAmountMinor` are removed upstream; there is no 1:1 successor. Options: (a) full ABI resync + per-site migration of all 23 `issuedIntexCount` reads to the new `issuedUnits`/`settledUnits`/… semantics (large, touches sale/no-sale logic in `targetAuctionResult()`); (b) keep the bundled `IIntex.json` at the old shape and accept that these completion reads are stale against `d7c78459` until the resync lands. **The chosen plan takes (b) this cycle and tracks (a).** Confirm this is acceptable, or authorize (a) as a separate task.
2. **D3 sent ⇒ non-zero `sendId`.** Parked ⇒ `sendId==0` is confirmed; the converse is unresolved and depends on bridge semantics. The plan classifies park state from `MessageParked` logs only. Confirm no product surface needs to assert "sent" from a non-zero `sendId` before release.
3. **D1 `costAmountMinor` liveness.** No UI consumer located. Confirm the field is genuinely dead (it is dropped upstream) before the resync removes it — folded into question 1.
4. **A3 `deriveStrikeAmountMinor` local `PROMIS_SCALE=1e18`.** Whether it must also move to 1e6 is not settled by the validation doc. The re-pinned `multi-currency-evidence.test.ts` is the tripwire; if it forces 1e6, Slice 1 adjusts. Flag if you have authoritative guidance.

---

## 5. Risks (honest)

1. **Knowingly-divergent ABIs remain** for every entry the app does not name (including the deferred `IIntex.json`). A future feature reading one breaks until the guard's pin assertion or a source-signature check catches it. Accepted for diff size; documented in `config/abi/README.md`. (Same risk A and C accept; B would eliminate it but on false-premise tooling.)
2. **B4 won-count from logs vs a removed ledger getter.** If the chain had a distinct won semantic (partial fills) the old getter captured, log-derivation may under/over-count. Mitigation: prefer `unknown` economics over a fabricated number; never claim delivered without both `IntexIssued` log and instructions. Needs a real-chain release check.
3. **A3 scale change is broad** (chart, format, fallback lift). A missed decimals literal shows numbers 1000× off. Mitigation: the re-pinned "1e6" tests + one rendered visual check on a price surface before merge.
4. **Hand-patched ABI edits can mis-decode** a tuple. Mitigation: **copy entries verbatim from the committed `abi-export/` artifact** (not hand-typed), and the guard's canonical tuple-signature check is the tripwire. Run the guard in slices 5–8.
5. **Deferred G1/D1** means completion reads touching `issuedIntexCount` (e.g. `targetAuctionResult()` sale/no-sale) decode the old shape against new-chain data and may be wrong for series created under the reshaped schema. This is the honest cost of not resyncing now. There is **no refuse-to-transact gate** in this plan (cut as an unrequested abstraction), so this is a read-only-correctness risk, not a fund-safety risk — A1 (approval math) and B5 (refund gate) are fixed in slices 1–2, which is where fund safety actually lives. If the user judges the stale completion reads unacceptable before the resync, escalate question 1 to authorize the full resync task ahead of the MEDIUM slices.
6. **`abi-pin.json` requires discipline:** it only helps if updated by whoever bumps the submodule. That is the intended forcing function (a bump without review fails CI), but a careless bump-and-edit-pin defeats it. The independent source-signature axis is the backstop.
