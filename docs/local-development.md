# Local contract environment

The production application uses a single deterministic Anvil chain for local integration. Origin and venue are separate logical profiles and separate contracts even though both use chain ID `31337` and RPC `http://127.0.0.1:8545`.


## Repository layout

All repository-owned local-chain development infrastructure and controls live under `dev/local-chain/`: the Foundry overlay (`blockchain/`), Node command and phase-runner scripts (`scripts/`), and the separate `/dev` control surface plus its endpoint and Vite configuration (`controls/`). This directory is development-source only and is excluded from the release archive by its strict allowlist.

Generated chain state, deployment metadata, generated runtime config and logs remain in ignored `.local/`; they are runtime state, not source. Local-chain tests remain under `tests/` so the repository’s central test-discovery rules continue to apply.
## Prerequisites

- Node 24 and npm 11.6.2
- Foundry 1.7.1 (`forge`, `anvil`, and `cast` on `PATH`)
- `npm ci` at the repository root

## Keep the pinned submodule in sync

`blockchain/outbe-chain` is a read-only protocol reference pinned to one reviewed commit. Set it up once per clone:

```sh
git submodule update --init --recursive
git config submodule.recurse true
```

`git config submodule.recurse true` makes `git pull`, `git checkout` and `git switch` move the submodule to the commit the superproject pins, so a later pull cannot leave the contract sources behind the application. `git clone` does not honour that setting, which is why the initial `git submodule update --init --recursive` is still required. If you prefer not to set it, run `git submodule update --init --recursive` after every pull instead.

Do not run `git submodule update --remote`: it replaces the reviewed pin with upstream's latest contracts. Upstream contract changes reach this application only through a deliberate pin bump and a re-reviewed contract profile, and `npm run check` fails when the checked-out submodule does not match the profile the application expects.

If an existing checkout has a sparse copy of that submodule, restore it before installing dependencies:

```sh
git -C blockchain/outbe-chain sparse-checkout disable
git submodule update --init --recursive
```

`npm start` and `npm run build` do not read the submodule; `npm run typecheck` and `npm run check` do, through `scripts/build/check-contract-profile.mjs`.

## Workflow

```sh
npm run local:anvil
npm run local:seed -- --list
npm run local:seed -- commit-open
npm run local:advance -- commit-end
npm run local:web
```

`local:anvil` starts only the Anvil process recorded in `.local/anvil.json`, deploys the real Intex core contracts behind ERC1967/UUPS proxies, wires the loopback topology, generates `.local/config/`, runs smoke checks and records a clean post-deployment snapshot. The generated config and snapshot metadata are never committed.

`local:web` also exposes a development-only control surface at `http://127.0.0.1:5173/dev`. It is unavailable from the production build and from ordinary `npm run dev`. The control page advances the real local controller, auction, escrow, router and NFT contracts, then polls their current state. Reset, Red Day and Seed Past Auctions replace the fixture; reveal, clearing, result, refund, issuance, qualification and call controls preserve live wallet-created commitments and locks.

Set `ITX_TESTER_WALLET_ADDRESS` to the wallet you connect with for manual testing; each fresh local deployment gives that address 100,000 native units and 1,000,000 wCOEN, with no pre-approved escrow allowance. When the variable is unset it falls back to a neutral, publicly known Anvil account (mnemonic index 3, `0x90F79bf6EB2c4f870365E785982E1f101E93b906`) so the local workflow runs with no configuration. The wallet must still approve and sign its own commit/reveal transactions. `ITX_TESTER_WALLET_ADDRESS` exists only for local deterministic checks and must not be used to configure a production profile.

Every `local:seed` restores that post-deployment snapshot before constructing the requested scenario, so a failed or previous seed cannot leak bids, timestamps, transport settings or controller evidence into the next scenario. Post-seed assertions read deployed contract state or transaction logs before `.local/scenario.json` is written.

All scenarios use the current date as the WorldwideDay (the protocol's UTC+14 calendar date at chain creation). The genesis timestamp is computed dynamically so the local chain always starts inside "today" in UTC+14, keeping the live auction and schedule natural relative to the developer's wall clock.

When changing fixtures:

```sh
npm run local:reset
npm run local:seed -- <scenario>
npm run local:smoke
npm run test:local-scenarios
npm run local:down
```

## Browser happy paths

Install the pinned Chromium build once, then run the browser suite against the real local contracts:

```sh
npx playwright install chromium
npm run local:anvil
npm run test:e2e:local
npm run local:down
```

The Playwright suite drives the product UI through an injected EIP-1193 test wallet and covers exact bond approval plus commit, cancellation plus receipt-preserving recommit, and reveal plus escrow lock. It uses the deterministic Anvil bidder and does not automate MetaMask's extension window.

`local:reset` recreates the chain and verifies that all deterministic deployment addresses are unchanged. `local:down` terminates only the recorded Anvil process. `local:status` reports whether the recorded process and expected RPC are both active.

## Wallet nonce desync after a reseed

MetaMask keeps its own per-network nonce tracker, while every `local:seed` restores an Anvil snapshot and moves the chain nonce backwards. The wallet then signs ahead of the chain, Anvil parks the transaction in the non-executable `queued` pool, automine never mines it, and resubmitting the identical payload is rejected with `transaction already imported`. In the application this shows up as an approval that never confirms, then a misleading "approve reverted" error. The application also detects this itself: a submitted transaction whose nonce is ahead of the chain nonce fails with the exact wallet and chain nonces instead of waiting for the RPC timeout. See [transaction-lifecycle.md](transaction-lifecycle.md) for the full nonce-gap detection and state model.

Clear the wallet's activity data for the network (MetaMask → Settings → Advanced → Clear activity tab data). That resets the wallet's nonce tracker to the chain and is the fix after any reseed; do it before resubmitting.

## Deterministic scenarios

| Scenario | Contract-backed state proved | First consumer |
| --- | --- | --- |
| `commit-open` | Completed Green WWD, global `Started`, delivered venue auction with a fresh contract-stored 24-hour commit deadline, zero live commits, seven prior contract-backed demand observations and 90 recent daily COEN/USD snapshots around 1 USD | Phase 3 read adapter and auction view |
| `reveal-open` | Green auction with one real EIP-712 commitment; commit boundary asserted immediately before, exactly at and immediately after `commitEnd`; deterministic COEN/USD history is newest-first, capped at the 365-day retention boundary and paired with authoritative Entry/Floor/Call parameters | Phase 4 chart and public ladder; Phase 8 reveal flow |
| `oracle-unavailable` | Retained Completed Green WWD and delivered commit-stage venue auction remain readable while every local Oracle read fails | Phase 4 scoped chart-unavailable state |
| `reaped-historical-auction` | Two real bids are committed and revealed, the target becomes Completed, time passes `issuanceEnd`, `reapAuction` empties the stored bid array and both `BidRevealed` logs remain durable | Phase 4 historical ladder and log reconciliation |
| `failed-green` | Retained WWD reads as `Failed` and `Green` with no Red, no-sale, cancellation or missing-WWD implication | Phase 4 WWD/calendar reconciliation |
| `cleaned-history-unavailable` | Exact `WorldwideDayCleanedUp` evidence remains after the retained record is removed; only final lifecycle is durable, so old Green/Red type is unavailable | Phase 4 `CleanedHistoryUnavailable` classification |
| `completed-green-sold-out` | Global `AuctionCleared`, no unused-supply event, nonzero target aggregate result and canonical origin series; recipient delivery and escrow finalization remain unasserted | Phase 4 clearing evidence; Phase 10 delivery reconciliation |
| `completed-green-partial` | Nonzero issued quantity plus same-transaction `UnusedSupplyReported` evidence with deterministic conversion dust; `offered = issued + floor(unused / promisLoad)` | Phase 4 offered-supply evidence |
| `completed-green-no-sale` | Green terminal clearing with zero winners, zero target result and no origin or target series | Phase 4 terminal presentation; Phase 10 `NotApplicableNoSale` |
| `completed-red` | Completed Red WWD with separately cancelled global and target auctions and no Green clearing evidence | Phase 4 WWD/calendar reconciliation |
| `terminal-no-auction` | Failed WWD with one reviewed `MissedOffering` terminal receipt and no global or venue auction | Phase 4 terminal disposition |
| `venue-delivery-pending` | Frozen venue target and global auction exist while target delivery is absent, so no authoritative venue schedule exists | Phase 4 `VenueSchedulePending` |
| `venue-chain-skipped` | Venue was frozen, its real revealed bid relay remained parked, Desis-side `ChainSkipped` evidence exists, no normal refund instruction arrived and the bidder escrow remains unfinalized | Phase 4 skipped overlay; Phase 9 recovery |
| `origin-send-parked` | Global clearing completed, result send was parked at origin and no target receipt occurred | Phase 4 transport overlay; Phase 10 lifecycle lag |
| `origin-send-flushed-target-pending` | Previously parked result was dispatched successfully while bridge delivery stayed disabled and target receipt remained absent | Phase 4 transport overlay; Phase 10 lifecycle lag |
| `unrevealed-bond-waiting` | Real unrevealed commitment and bidder-level commit bond remain live; stored early-snapped `revealEnd + 24 hours` is one second away and `claimCommitBond` returns the exact not-yet-claimable error | Phase 9 auction-side bond recovery |
| `unrevealed-bond-claimable` | Same live auction-side bond reaches the exact 24-hour boundary; account 1 claims permissionlessly, account 2 receives the exact bond and the bidder-level bond record is cleared | Phase 9 auction-side bond recovery |
| `abandoned-commit-bond-waiting` | Real bidder-level bond survives an auction wiring rotation; `lockedAt + 30 days` is one second away and escrow-local recovery is blocked | Phase 9 escrow-local bond recovery |
| `abandoned-commit-bond-claimable` | At the exact escrow-local 30-day boundary, account 1 claims against the original escrow, account 2 receives the exact bond and the old wiring epoch remains reconstructible from `Wired` | Phase 9 escrow-local bond recovery |
| `unfinalized-escrow-waiting` | Reuses the skipped-chain path: a real revealed bidder lock remains active, aggregate escrow is never finalized and `lockedAt + 72 hours` is one second away | Phase 9 never-finalized recovery |
| `unfinalized-escrow-claimable` | At the exact 72-hour boundary, account 1 recovers account 2's full principal; bidder lock becomes terminal while historical `hasLocks` remains true | Phase 9 never-finalized recovery |
| `finalized-failed-split` | Aggregate finalization succeeds for a control bidder while a valid split for account 2 fails at Compact withdrawal; bidder-level `failedRefund` and `splitRecorded` remain live, then exact `finalizedAt + 72 hours` recovery returns the refund portion and burns the remainder | Phase 9 failed-split recovery |
| `finalized-without-split` | Aggregate finalization exists and a control bidder settles, but account 2 is omitted and has no split; recovery is blocked through the 72-hour retry window and succeeds exactly at `finalizedAt + 30 days` with full principal returned | Phase 9 no-split recovery |
| `finalization-no-op` | The sole real bidder instruction fails amount validation; `AuctionEscrowFinalized`, `BidderRefundFailed` and named `FinalizationNoOp` evidence coexist while the bidder remains active and recoverable through the 30-day no-split fallback | Phase 9 bidder-level finalization reconciliation |
| `past-auctions` | Three prior WorldwideDays hold real Completed Green WWD records with Desis clearing (`AuctionCleared` sold-out evidence, offered quantity equal to issued count) and a revealed venue ladder of 3–4 synthetic bidders per completed day, one Red cancelled day sits between them, and the active auction stays in commit stage | Public calendar, revealed-bid history and previous-demand widget verification |

The deterministic operator is Anvil account 0. Account 1 is the manual bidder and permissionless recovery caller; account 2 is the background bidder and recorded recovery recipient. Reaped-ladder and split-control fixtures use both bidder accounts. They are local-only funded test accounts; no runtime-generated or production-funded key is used.

`npm run local:advance -- <target>` reads the active scenario and live contract state, derives the requested stage or recovery deadline, sets the next Anvil block timestamp and mines one block. It refuses non-31337 chains, missing scenarios and incompatible scenario/target combinations. Useful targets include `commit-before-end`, `commit-end`, `reveal-before-end`, `reveal-end`, `issuance-end`, `unrevealed-bond-claimable`, `abandoned-bond-claimable`, `unfinalized-refund-claimable`, `failed-split-claimable` and `no-split-claimable`. Reseed before moving to an earlier timestamp.

| Recovery boundary | Contract anchor | Before | Exact | After |
| --- | --- | --- | --- | --- |
| Auction-side unrevealed bond | stored `revealEnd + UNREVEALED_BOND_LOCK_PERIOD` | blocked | allowed | allowed |
| Escrow-local abandoned bond | `CommitBond.lockedAt + COMMIT_BOND_ABANDON_DELAY` | blocked | allowed | allowed |
| Never-finalized refund | `BidLock.lockedAt + UNFINALIZED_REFUND_DELAY` | blocked | allowed | allowed |
| Failed-split fallback | `AuctionEscrowState.finalizedAt + POST_FINALIZE_REFUND_DELAY` | blocked | allowed | allowed |
| No-split fallback | `AuctionEscrowState.finalizedAt + NO_SPLIT_REFUND_DELAY` | blocked | allowed | allowed |

Every fixture executes the `deadline - 1`, `deadline`, and `deadline + 1` assertions against real contract calls before writing `.local/scenario.json`. `npm run test:local-scenarios` reseeds all recovery fixtures, runs smoke checks, and verifies clean snapshot timestamps, deterministic addresses and balances, old wiring retention, and distinct permissionless caller/recipient accounts.

## Boundaries

The local controller is a development-only authority and read fixture. It occupies both OriginRouter authority slots and provides minimal Desis, payable factory, Metadosis, and Oracle behavior. Its Oracle fixture keeps one configured pair, returns snapshots newest-first, prunes entries older than 365 days relative to the newest snapshot and can fail independently of WWD or venue reads. Its cleanup control emits the reviewed `WorldwideDayCleanedUp(uint32,uint8)` event before the retained record becomes unreadable. The auction, escrow, routers, NFT, NFT bridge, proxy topology, and application RPC/config path are real. No production profile may reference the local controller or local dependency contracts.

## Test and scenario ownership

The embedded contract snapshot already contains its matching OutB Foundry tests. Do not recreate them, cherry-pick newer protocol tests without the matching contract snapshot, or translate protocol unit/invariant assertions into frontend tests.

`npm run test:contracts:local` deliberately runs only the application-owned deployment test and the adapted full-loopback lifecycle test. They verify that the local fixture exposes the real proxy, wiring, router and auction behavior the application depends on. The full embedded protocol suite is a snapshot-update check, not ordinary application CI.

The scenario pack prepares contract-backed read states beside the sequential production implementation. It does not implement adapters, React state, wallet flows or recovery transactions. The embedded protocol suite still owns clearing mathematics, escrow conservation, codecs, router internals, upgradeability, NFT invariants and authorization behavior.

### Deliberate simplifications in the local harness

Each of these is intentional, with the condition that should replace it:

- Origin and venue share one Anvil chain, and the local controller projects reviewed Desis/Metadosis evidence for deterministic browser testing. Replace the controller with deployed OutB contracts and separate chains only when cross-chain transport or OutB execution itself becomes the test subject.
- Positive-clearing scenarios seed the canonical origin series read after real target result application but do not route issuance recipients. Replace this projection with end-to-end IntexFactory issuance when recipient delivery becomes the test subject in Phase 10.
- The local Compact mock can reject one selected withdrawal amount so a deterministic batch can contain one failed valid split and one successful bidder. Replace this amount selector with calibrated transport/Compact fault injection when the real external dependency becomes the integration subject.
