# AGENTS.md — Project Rules for AI Agents

## Project Structure

- **This repo** contains the production bidder application and references the protocol contracts through the pinned submodule.
- **Production application (the product):** `src/` (TypeScript/React/Vite), driven by `config/` runtime JSON and the reviewed contract profiles. Local-chain testing uses the `/dev` dashboard (`dev/local-chain/controls/app/`) against a local Anvil deployment that deploys the real bidder-facing Solidity stack before production addresses exist.
- **Current on-chain source of truth:** the `blockchain/outbe-chain` git submodule (read-only, pinned), materialized in full including `contracts/`, `crates/`, `docs/` and `adr/`. App-owned Solidity lives in `dev/local-chain/blockchain/` (Foundry overlay) and references upstream via remappings.
- **Tests** live under `tests/`, never colocated with source: `tests/unit/src/**` mirrors the production `src/**` tree, `tests/unit/scripts/**` covers Node helpers (including local-chain helpers), `tests/e2e/browser/**` holds Playwright specs with helpers in `tests/e2e/support/**`, and `tests/e2e/anvil/**` holds the Anvil-backed phase tests. Default `vitest run` discovers only `tests/unit/**`; the phase runners select `vitest.anvil.config.ts` explicitly. Unit tests reach production code through the `@/*` alias for `src/*`.
- **Scripts** are grouped by responsibility: `scripts/build/`, `scripts/release/`, `scripts/server/`, `dev/local-chain/scripts/local/{commands,controls,infrastructure,scenarios}/` and `dev/local-chain/scripts/runners/`. The canonical local phase suite is `npm run test:phases:local`; do not rename its underlying phase runners.
- **Protocol documentation:** `blockchain/outbe-chain/docs/` and `blockchain/outbe-chain/adr/` contain the pinned cross-chain flows, protocol intent and decisions. Current contract code and tests win when prose disagrees.
- **Production decisions:** the confirmed product constraints live in this file under "Production Direction"; read `docs/current-production-contract-profile.md` and the architecture documents under `docs/` before planning or implementing production functionality. Per-surface protocol behavior comes from the pinned contracts and tests under `blockchain/outbe-chain/`.
- **Design tokens and UI primitives:** `src/ui/tokens.css` and `src/ui/primitives.tsx` — AppShell, Card, Button, Banner, Badge, Notice, InfoTip, Metric, MetricGrid, ViewToggle, Icon. Reuse these for customer-facing work.

---

## Production Direction

The application under `src/` is the current product: a real bidder app that reads authoritative contract state, signs and submits transactions, and persists receipts. Its local dev controls (`/dev`) manipulate a local Anvil deployment for testing — they must not leak into the production bundle or be mistaken for product behaviour.

Confirmed production constraints:

- Static React application; no backend, local API, SQLite, server indexer, Docker or desktop wrapper.
- Production application source is TypeScript/TSX only with strict type checking and `allowJs: false` for application code.
- Browser-local persistence, initially `localStorage`.
- Connected wallet is the only user identity.
- Support injected wallets and WalletConnect-compatible connections.
- Use `viem`, direct EIP-6963 injected-wallet discovery and `@walletconnect/ethereum-provider`; do not add Wagmi initially.
- Bidder-facing auction lifecycle only: Commit → Reveal → auction result → Intex issuance, plus bidder recovery and a minimal read-only portfolio.
- Users may browse auctions without a wallet; BNB Chain mainnet is the default disconnected read-only venue.
- Connected wallet chain ID determines the active venue. Do not add a separate connected-operation environment or venue selector.
- Canonical WorldwideDay existence, processing lifecycle, day type and calendar lookahead are always read from Outbe Metadosis. Global auction/chain-participation state comes from Outbe Desis, origin delivery from OriginRouter, prices from Oracle and canonical series lifecycle from Outbe Intex, regardless of the active venue or wallet chain.
- The active venue contributes only local auction delivery, schedule, bids, escrow, result, target NFT representation and balances, joined to origin state by `worldwideDay` and `seriesId`.
- The first release reads one fixed Outbe origin plus one active venue at a time; do not aggregate all spoke chains.
- Treat each venue chain as an isolated application environment. Do not aggregate another venue's bids, history, transaction state or portfolio into the active experience.
- On unsupported wallet chains, show a persistent non-dismissible notification and keep settings/wallet controls available, but do not show another venue's chain-bound data as active. Already loaded Outbe WWD facts remain origin data, not unsupported-chain data.
- Load RPCs, deployment addresses, confirmation depths and WalletConnect settings from plain runtime JSON files under `config/`.
- Do not add an in-application RPC or deployment editor. Users edit documented files and restart the application.
- Use ordered RPC lists with one sticky healthy endpoint per active context and conservative failover. Do not mix endpoints inside one logical operation.
- Custom deployment addresses may be supplied in files, but they use only the bundled ABI and reviewed behaviour profile. Do not add arbitrary ABI/configurable behaviour support.
- Use a versioned chain/deployment manifest; do not hard-code BNB/Outbe branches throughout components.
- Placeholder deployments remain disabled and use obviously absent values, never fabricated addresses or blocks.
- The public calendar requests a 90-day WWD window and fetches additional periods on demand, but it must not claim canonical history beyond evidence retained by Metadosis or reviewed durable origin logs. Cleaned history is shown as unavailable, not as a missing WWD.
- Active-wallet history scans from relevant deployment blocks and wiring epochs, regardless of the 90-day global window.
- No background notifications.
- Request exact token approvals only. The spender is the currently wired `EscrowAdapter`, not `IntexAuction`.
- Browser `localStorage` reveal material is the canonical live receipt store. Do not auto-download receipts after commit. Keep explicit user-controlled receipt backup actions available, including manual per-receipt download/export and import; browser download status is not authoritative proof that a file remains durable.
- Receipts persist across wallet disconnects, account changes and chain switches.
- Preserve immutable reveal material through supported receipt-schema compatibility paths without retaining duplicate raw import JSON. Current export-schema-v1 backups are accepted one-way for reveal-material recovery under the canonical receipt-storage rules; their mutable transaction attempts and backup state are not restored.
- Silently restore the last wallet session when supported; never trigger an automatic wallet or signature popup.
- Revealed bids and the bit ladder update live during reveal with periodic RPC reconciliation.
- Historical revealed-bid ladders must be reconstructible from logs because `reapAuction` can delete stored bid arrays after terminal auctions.
- Commit cancellation is available only during the commit stage, returns the current embedded contract's bond immediately, and permits recommit while the window remains open.
- A green-day no-reveal bond is claimable through `IntexAuction` at `revealEnd + UNREVEALED_BOND_LOCK_PERIOD`; the current embedded constant is 24 hours.
- The escrow-local `claimAbandonedCommitBond` fallback is independently claimable at `lockedAt + COMMIT_BOND_ABANDON_DELAY`; the current embedded constant is 30 days.
- Escrow refund recovery is bidder-facing. Display the exact returned amount and any burned remainder before submission.
- Auction result, escrow finalization and winner mint delivery are independent cross-chain outcomes. Never use a single `Completed` flag to imply all three succeeded.
- Desktop-oriented product. Minimum viewport is `600 × 720`.
- Expected local workflow is `npm ci` followed by `npm start`.
- `npm start` must bind only to `http://127.0.0.1:4173` and fail clearly if the port is occupied; never silently select a different origin.
- Runtime configuration is loaded only at startup; configuration changes require restart and browser reload.
- Each release supports one pinned Node major and exact npm version. Routine dependency upgrades wait for the next major; critical security or broken-wallet fixes may ship as patches.
- Tagged releases include a checksummed prebuilt static application archive, editable runtime configuration, and tested toolchain/schema versions. GitHub source archives remain development-source snapshots.
- Support the latest two major desktop releases of Chrome, Edge, Firefox and Safari at release time, with explicit capability checks.
- All JavaScript, fonts, icons, ABIs, documentation and visual assets are local. No analytics, error-reporting SaaS, CDN assets, remote manifests or automatic update checks.
- npm/Node scripts must run on Windows, macOS and Linux without Bash-specific assumptions.

### Critical bid-persistence rule

The exact EIP-712 reveal signature and required reveal fields must be successfully persisted and read back before broadcasting a commit. Never submit a commit first and attempt to save reveal material afterward.

### Current commit/reveal profile

The reviewed embedded contract profile uses:

```text
EIP-712 domain: IntexAuction / version 1 / active chain ID / auction proxy
Typed value: RevealBid(uint32 worldwideDay,address bidder,uint16 quantity,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)
commitHash: keccak256(signature)
```

`revealBid` also receives the active chain ID and rejects a mismatch with `block.chainid`. The older reviewed profiles (`fc739b3`: 4-field message, domain v1; `multi-issuance-usd-reference-v2`: 5-field message, domain v2) remain valid only for validating historical receipts. Revalidate this profile whenever the production contract implementation or proxy domain changes.

### Production data rules

- Contract state and logs are authoritative. Never silently fall back to seed or mock data.
- Use integer/`bigint` domain arithmetic for token amounts and fixed-point rates. Do not use JavaScript floating point for production contract values.
- Contract addresses, deployment blocks, ABI/profile versions, ordered RPC endpoints and enabled networks belong in versioned runtime configuration.
- Read current contract wiring before preparing transactions. Historical recovery may depend on prior auction/escrow wiring epochs.
- Namespace bid records, settings, caches and history cursors by chain ID, contract deployment and wallet as applicable.
- Namespace origin WWD caches by Outbe profile and WWD/range; namespace venue overlays by venue chain and deployment.
- A wallet account or chain change is a full venue-context transition and must reload all venue-bound reads and local records. It must not replace canonical Outbe WWD state when the origin profile is unchanged.
- Canonical WWD state derives from Outbe Metadosis-compatible reads; global clearing and chain inclusion/skipping derive from Desis; parked/dispatched origin legs derive from OriginRouter; canonical series lifecycle derives from Intex. A WWD key is a `YYYYMMDD` date in the protocol's UTC+14 calendar, not an ordinary UTC accounting date. Contract schedules remain Unix timestamps in UTC seconds.
- The exact venue auction date and schedule derive only from delivered venue schedule fields or another reviewed Desis schedule read. A missing spoke-side `IntexAuction` record is delayed or absent venue delivery, not proof that the canonical WWD is missing, and the frontend must not guess its auction date from a fixed WWD offset or `scheduledProcessTime`.
- Origin WWD cleanup must be represented explicitly. A cleaned terminal record is not equivalent to a WWD that never existed.
- `IntexAuction.Completed` means an auction result was applied; it does not prove global inclusion, escrow finalization, target series provisioning, recipient delivery or lifecycle-message delivery.
- `ChainSkipped` means the venue was excluded from global clearing and its bidders use the never-finalized escrow path; do not wait for normal refund instructions.
- Origin send/park/flush evidence does not prove target receipt.
- Current portfolio balances should use paginated `IntexNFT1155` enumerable reads rather than replaying transfer history or unbounded lists.
- Distinguish token status (`Issued`/`Settled`), canonical origin lifecycle and delivered target lifecycle.
- Target expiry is derived from `Called` plus the stored deadline. The reviewed NFT has no `expireSeries` action, expiry-progress events or automatic outstanding-Issued burn.
- Offered quantity is shown only from a successful Desis clearing joined to unused-supply evidence; `AuctionCleared.totalDemand` is gross included demand, not eligible or all-chain demand.
- The venue ladder is local revealed demand only and never proves global rank, winner status, allocation or clearing rate.
- Production types retain `worldwideDay → zero or more seriesIds`. The v1 profile may use `seriesId == worldwideDay`; the v2 profile requires OriginRouter’s explicit immutable `seriesId -> worldwideDay` mapping for issuance and lifecycle fan-out.
- Re-read token allowance and perform fresh `eth_call` and `eth_estimateGas` preflight before each approval-dependent submission.
- Recovery UI must read bidder-level lock/bond state. `getAuctionStatus().hasLocks` is historical (`lockCount > 0`), not proof that a live bidder lock remains.
- Keep injected-wallet operation functional when WalletConnect infrastructure is unavailable.
- Manifest validation must prevent any placeholder chain from becoming transaction-capable.
- A malformed runtime profile disables only that profile; valid profiles remain usable.
- Keep unresolved architecture questions explicit. Do not silently invent answers; update the decision document when agreement is reached.

---

## Hard Design Rules

### outbe-chain is read-only

- **Absolute write boundary: never perform any write operation against the `outbe/outbe-chain` repository unless the user explicitly authorizes that exact upstream write in the current request.** Reading source, commits, tests, issues, and PRs for evidence is allowed; creating or modifying anything is not.
- Forbidden upstream writes include, without limitation: editing or pushing code, creating branches or commits, opening or modifying pull requests, opening or modifying issues, posting comments or reviews, adding labels/assignees/reactions, changing settings, triggering write-capable workflows, or any other GitHub mutation.
- **Do not interpret “raise upstream”, “upstream task”, or similar wording as authorization to write upstream.** When an upstream change is needed, record the requirement in `itx-acn` documentation/issues or report it to the user. Only the user can separately authorize an upstream action.
- `blockchain/outbe-chain/` is a pinned git submodule that references upstream outbe-chain contracts **read-only**; treat everything under it as immutable and never stage, commit, amend, or push changes inside it.
- All app-owned and scenario-owned Solidity lives in `dev/local-chain/blockchain/` (Foundry overlay) and is referenced via `@contracts/`, `@precompiles/`, `@test-mocks/` remappings into the submodule. Never copy upstream files into `dev/local-chain/blockchain/`; import them through the remappings.
- If upstream behavior must change, implement only repo-owned mitigations here and track the unresolved protocol requirement inside `itx-acn` unless the user explicitly authorizes upstream work.

### Customer-facing change workflow

Product decisions come from the reviewed contracts, tests and current architecture documents.

- For every customer-facing change, name the accepted product requirement or reviewed contract behaviour it implements.
- Functional work preserves the existing customer-facing composition unless presentation changes are explicitly in scope.
- Review copy, controls, ordering and behaviour before geometry. Rendering correctly and satisfying the requirement are separate conclusions.
- When fixing missed copy, controls or behaviour, leave one small rendered-DOM regression check that would have caught the mistake.
- Review the final diff against `main`. After a stacked parent merges, update the child and rerun affected checks before merge.
- Queued, skipped, cancelled, missing or failing required checks are not merge-ready.
- Do not call work “1:1”, “exact” or “approved” from author self-review alone; state the states you exercised and the known differences.

### Never invent domain behavior

- **Do not describe when/how something is fixed, stored, calculated, claimable or complete without citing the exact contract, test or reviewed source.**
- If a value is not explicit in the reviewed source, state that it is unresolved.
- Labels such as “completed”, “refunded”, “fixed at auction start” and “claimable” are contract claims and require exact state predicates.

### Typography

- **Minimum font size: 15px.** No exceptions.
- **Font family:** use the `--font-sans` custom property from `src/ui/tokens.css`.
- Use weight and color, not sub-15px text, for hierarchy.

### Colors & Tokens

- Use the `--color-*` custom properties from `src/ui/tokens.css`. Do not hard-code hex colors except white where required for contrast.
- Panels use `--color-surface` with a `--color-border` hairline.
- Use the shared shadow custom properties rather than ad-hoc `box-shadow` values.

### Spacing & Radii

- Card radius: `--radius-card`; fields/inner: `--radius-field`; buttons: `--radius-button`; CTAs: `--radius-cta`; pills: `--radius-pill`.
- Prefer the established spacing scale.

### Components

- Reuse the primitives in `src/ui/primitives.tsx` for customer-facing work.
- `Button` always receives a variant.

---

## Terminology Rules

1. Never use “mint” in user-facing product copy. Use “mine” where the product terminology requires it; code and contract references may retain canonical names such as `mint` and `IntexIssued`.
2. “price” is Promis-level; “amount” is Intex-level. Use “strike amount”, not “strike price”.
3. “strike” is allowed on primary auction UI only.
4. Under reviewed auction profiles, `bidRate` is a percentage of the escrow basis and the escrow basis is `promisLoadMinor`. Show the exact wCOEN lock amount prominently. Only `multi-issuance-usd-reference-v2` supplies contract-authoritative per-currency strike terms; display those stored values directly and never derive them from live Oracle reads.
5. Show nominal (`promis_load` / `promisLoadMinor`) prominently.
6. Bids and payments are in COEN/wCOEN. Currency conversions and Entry/Floor/Call reference values are informational unless a contract explicitly connects them to payment math.
7. Auction schedule and Intex lifecycle are separate.
8. Match contract fields in UI labels where possible.
9. Never invent terminology.
10. Clearing is not settlement.
11. Plural of Intex is “intexes”.

---

## Scope Boundary

Transaction-capable product scope:

```text
Commit → Reveal → auction result → Intex issuance
```

Also in scope:

- commit cancellation under the active contract profile;
- commit-bond and escrow recovery;
- receipt import/export and missing-receipt recovery;
- minimal read-only current balances.

Out of scope as application action flows:

- settlement;
- bridging;
- transfer/portfolio management beyond the balance list;
- mining Promis;
- mining COEN;
- privileged protocol/operator actions.

Permissionless protocol retries may be observed to explain user state, but are not automatically product actions unless separately approved.

---

## Durable fixes only

- Fix root causes in the canonical repository, configuration, or service definition. Do not use temporary worktrees, temporary branches, temporary runners, ad-hoc file patches, or one-off process changes as the delivered solution.
- Do not create empty/no-op commits, force-push churn, or synthetic changes solely to retrigger or bypass CI. Repair the actual CI or runner configuration instead.
- Diagnostic scratch files may exist only in ignored local paths while investigating. They must not become dependencies, deployment inputs, or substitutes for a committed long-term fix, and they must be removed when the investigation ends.
- Treat only committed source as a reproducible result; never declare success from uncommitted local state.

---

## Efficient repository workflow

### Temporary CI bypass

Until this subsection is explicitly removed, it overrides conflicting pre-merge CI and required-check guidance elsewhere in this file.

- Do not wait for or run hosted CI before merging feature work to `main`; CI may be skipped while this temporary policy is active.
- As soon as feature work is complete and its minimal affected local check passes, merge it to `main` immediately; do not leave completed work waiting in a feature branch or pull request.
- Before merge, keep verification to the cheapest affected local check needed to catch obvious regressions. Do not treat skipped CI as evidence that the change works.
- After merging committed code to `main`, run `npm run build` from the resulting main checkout. The post-merge build is the required integration check.
- If the build, startup, or focused local smoke check fails, fix the blocking issue immediately and repeat the check. The work is not complete while the application cannot build or start.
- Never hide or bypass build failures, and do not rely on uncommitted host-only fixes.

### Canonical checkout

- Before substantive work, run only the minimal preflight: read this file, `git status --short --branch`, and `git log -1 --oneline`.
- **Feature work happens in worktrees, never directly on `main`'s working tree.** Create one worktree per feature (or per genuinely concurrent task) on a descriptive feature branch. Editing the checked-out `main` working tree directly is prohibited: it is not isolated, and concurrent git operations on `main` can discard uncommitted work.
- Do not create worktrees under `/tmp`.
- Never test or merge from an unidentified checkout. State the checkout path, branch and commit in the final verification summary.

### Feature delivery lifecycle

Every completed feature follows this lifecycle, in order:

1. Build the feature in its worktree on a feature branch and keep the branch pushed to the remote as work proceeds.
2. Inspect the final diff against `main` from the feature branch; remove unrelated changes before merge.
3. Push the feature branch to the remote and open a pull request into `main`.
4. Merge the pull request into `main`. Merge promptly: the Temporary CI bypass above still governs CI-waiting while it is active, so do not leave completed work waiting in a pull request.
5. Delete the remote feature branch and remove the local worktree after confirming the worktree contains no unique commits or uncommitted changes.

Completed work is never left sitting on a local `main` working tree or in an unpushed feature branch.

### Scope control

- Translate the request into a short list of observable outcomes before editing. Each changed file must support one of those outcomes.
- Stop at the first layer that can correctly solve the problem. A UI or copy task stays in the UI unless an exact failing contract predicate, adapter read or production-data boundary proves otherwise.
- Do not redesign protocol schemas, bridge messages, Rust runtimes, deployment infrastructure or unrelated domain models during customer-facing work. Put genuinely required cross-layer work in a separate task and branch.
- When existing product wording conflicts with reviewed contract behaviour, do not silently substitute new wording. Record the exact conflict and preserve the closest safe customer experience.
- Before widening scope, identify the visible or testable requirement that cannot be satisfied inside the current layer. No evidence means no scope expansion.

### Investigation discipline

- Prefer `rg` over recursive `grep`, restrict searches to relevant directories and file types, and bound output.
- Inspect the final diff against `main` before running expensive checks. Remove unrelated changes first.
- For customer-facing corrections, create a concrete mismatch list: required state, current product state, owning component and required correction. Do not begin broad implementation from a screenshot alone.
- Reuse known repository paths, ports and installed tools. Do not repeatedly invoke `find /`, reinstall tools with `npx --yes`, or rediscover information already established in the task.

### Verification ladder

Run checks from cheapest and closest to broadest:

1. The exact affected test file or smallest runnable self-check.
2. The affected interaction or rendered-DOM state.
3. `npm run check` for typecheck, unit tests and the production build.
4. One rendered visual check of the affected states when customer-facing output changed.
5. Full required verification once, immediately before merge.
6. One focused deployed smoke check after committed `main` is deployed.

Do not run contract, Rust, Docker, local-chain or full end-to-end suites for a frontend-only change unless the changed boundary or a failing targeted check requires them. Do not repeat a passing full suite after changes that cannot affect it.

### Process hygiene

- Every temporary server, browser session, Anvil process or container started by a command must be stopped by that command, preferably with an exit trap.
- Use strict, documented ports. Diagnose an occupied port; do not silently move to another one.
- Close `agent-browser` sessions after evidence is captured. Do not leave persistent browser profiles or development servers running between tasks.
- Screenshots prove rendered appearance only. Important conditional copy, controls and behaviour require a small rendered-DOM or interaction regression check.

### Progress reporting

- Report concrete findings: mismatches found, files changed, targeted checks passing and remaining differences.
- Avoid activity narration such as “tracing”, “designing” or “continuing” without a testable result.
- Do not claim merge readiness until the final diff is scoped, required checks pass, and the exact tested commit is known.

---

## Verification

- Always build after application changes.
- Before handing any change over to the user or merging to `main`, verify it in a real browser with `agent-browser` (or Playwright where it is the repo's harness): load the affected page, exercise the changed control, and capture the rendered result. Do not hand over an unverified UI change.
- Screenshot visual changes using `agent-browser`.
- Production functionality requires tests at domain, contract-adapter, storage-migration and transaction-state boundaries.
- Contract-facing tests must cover exact timestamp boundaries, receipt validation, active wiring, event/read reconciliation, replacement transactions, partial cross-chain delivery and recovery amounts.
- Pull requests and tagged releases must verify `npm ci`, typecheck, tests, build, `npm start`, and an HTTP smoke test on Windows, macOS and Ubuntu.
- Public-RPC compatibility checks remain separate manually triggered workflows so required CI does not depend on third-party availability.

### Browser changes must be verified and console-clean

Every change that touches browser behaviour — wallet connection, lifecycle, transaction flows, UI state, event handling — is not done until it is verified in a real browser with `agent-browser` (or the repo's Playwright harness). For each such change:

- Decide whether it needs a **standalone e2e test** in the repo's Playwright suite, or **manual one-off verification** with `agent-browser`. Wallet connect/disconnect/reconnect, transaction submission, receipt flows and lifecycle transitions need a standalone e2e regression test; isolated presentation tweaks may be manually verified.
- Exercise the affected control (connect, disconnect, reconnect, switch, submit) and verify the resulting rendered-DOM state, not just a screenshot.
- **Read the browser console and page errors** (`agent-browser console` / `agent-browser errors`) and confirm no uncaught errors are introduced by the change. A change that leaves an uncaught React or provider error is not complete.
- Reproduce the failure mode the fix targets with a faithful stub or harness (e.g., a fake EIP-1193 provider that simulates the wallet's quirk), and confirm the fix changes the outcome.
- Where the real external dependency (wallet extension, relay, network) cannot run in the automated browser, state that limitation explicitly and record what still needs a manual release check.

```text
agent-browser screenshot http://localhost:5173 --width 1440 --height 900
```

---

## Code Style

- Presentation lives in colocated CSS files next to the component that owns it.
- Preserve visual output while separating domain, chain, persistence and presentation concerns in production code.
- Top-level components use function declarations; helpers/callbacks use arrows.
- Imports: external libraries → tokens/hooks/format → model/domain → other local.
