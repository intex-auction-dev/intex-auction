# Transaction confirmation, replacement, and nonce-desync lifecycle

Status: authoritative implementation audit for issue #139  
Audited baseline: `main@2454c54d39e8291675188cb1acbc8111b419a267`  
Date: 2026-08-24

## Purpose

This document is the authoritative application-level description of transaction attempt state for bidder commit, cancellation, recommit, reveal, token approval, and bidder recovery flows.

It reconciles the current implementation without changing it. Contract state and durable logs remain authoritative for auction and recovery state. Browser transaction attempts are mutable local evidence about a wallet submission; they are not a second auction state machine and they are not portable receipt data.

The six persisted transaction-attempt states are:

```text
submitted -> confirmed
          -> reverted
          -> replaced -> submitted successor  # safe repricing only
          -> dropped
          -> unknown
```

Before `submitted`, the UI may be preparing, simulating, estimating, or awaiting the wallet. Those are operation-progress states, not persisted transaction-attempt states, because no transaction hash has yet been returned.

`replaced`, `reverted`, `dropped`, and `unknown` do not themselves authorize a retry. Every new protocol write still starts from fresh contract reads, current wiring, simulation, and the flow-specific safety checks.

## Sources and precedence

This audit reconciles:

- wallet/network context isolation;
- bid recovery and local receipt requirements;
- transaction/retry policy;
- local diagnostics;
- canonical bid receipt storage and backups;
- `docs/auction-app-system-architecture.md`;
- `docs/local-development.md`;
- `src/chain/transaction-confirmation.ts` and its tests;
- bidder commit/cancel/reveal transaction helpers and controllers;
- `src/bidding/transaction-attempt.ts` and receipt-store attempt persistence;
- recovery transaction, attempt, and controller code and tests.

When evidence conflicts, use this order:

1. current contract state and durable contract logs for auction/recovery truth;
2. a confirmed transaction receipt for execution of one transaction hash;
3. persisted local attempt history for what this browser observed;
4. diagnostics for support correlation only.

A transaction receipt proves execution of that transaction. It does not by itself prove the flow-specific economic postcondition. Commit, cancellation, reveal, and recovery therefore perform fresh post-confirmation reconciliation before showing the corresponding business success state.

## State machine

```text
not submitted / awaiting wallet
        |
        | wallet/provider returns hash
        v
    submitted
      |  |  |  \
      |  |  |   \ wait cannot establish outcome
      |  |  |    +------------------------> unknown
      |  |  |
      |  |  +---- provider classifies wait as dropped -> dropped
      |  |
      |  +------- receipt.status == reverted ----------> reverted
      |
      +---------- receipt success at confirmation depth -> confirmed
      |
      +---------- same-nonce replacement
                   |
                   +-- repriced -> old: replaced
                   |              new hash: submitted -> ...
                   |
                   +-- cancelled/different tx -> replaced + stop
```

A persistent nonce gap detected while waiting does not create a seventh state. `StalledTransactionError` is currently persisted as `unknown` with an actionable explanation.

## Evidence and safe interpretation

| State/progress | Evidence | Safe user interpretation | Retry guidance |
| --- | --- | --- | --- |
| not submitted / awaiting wallet | No returned hash. The app may have simulated/estimated and is waiting for wallet approval/signature/submission. | No known transaction attempt exists yet. A provider rejection before a hash is not a chain revert. | Retry only as a newly prepared action after fresh reads; user rejection may simply be retried by the user. |
| `submitted` | Wallet/provider returned a hash and the app created the attempt. | The node/provider accepted enough of the submission path to return a hash; mining and success are unproven. | Never auto-retry. Continue tracking while live; after reload, use fresh state plus local history. |
| `confirmed` | Successful receipt reached configured confirmation depth. | This transaction executed without EVM revert. The intended auction/recovery postcondition may still require targeted reconciliation. | Do not resubmit. Reconcile contract state/logs. |
| `reverted` | Mined receipt has `status == reverted`. | This hash executed and reverted. | A later retry must be a newly prepared action after fresh reads/simulation. |
| `replaced` | viem `onReplaced` observed same-nonce replacement. | The original hash is no longer the live proof. Repricing may be followed; wallet cancellation/different replacement may not. | Follow only `repriced`. Otherwise stop and fresh-read before any user retry. |
| `dropped` | Current wait error code/name/message contains `dropped`. | The provider could not resolve the tracked hash and labeled it dropped; permanent disappearance is not proven. | Do not auto-retry. Treat as unresolved until fresh state makes the next action safe. |
| `unknown` | Any other wait failure, including transport failure and persistent nonce-gap watchdog failure. | The app cannot prove outcome. The transaction may still mine later. | Do not auto-retry. Fresh contract state is authoritative. |

## Persistence ownership and attempt identity

### Bidder transaction attempts

`TransactionAttemptV1` is stored under the browser-local transaction-attempt prefix and references immutable reveal material by `revealMaterialKey`.

Its mutable lifecycle fields are:

- `state`;
- `transactionHash` when known;
- `replacementAttemptId` for a safe repricing successor;
- `updatedAt`;
- `lastReconciliationError`;
- `reconciliationErrorKind` for a confirmed contract mismatch.

Identity fields such as `attemptId`, `revealMaterialKey`, `kind`, and `submittedAt` cannot be rewritten as a different attempt. Writes are read back and validated. A post-broadcast persistence failure raises `TransactionAttemptPersistenceError` with the returned hash because the chain transaction may already exist even when local tracking failed.

Bidder transaction attempts are deliberately excluded from portable receipt backups. Only immutable reveal material is portable.

### Recovery transaction attempts

`RecoveryAttemptV1` is browser-local mutable history keyed to a recovery item and includes chain, deployment, bidder, contracts, payment token, custody path, and expected returned/burned amounts. Its state set is identical to the bidder attempt state set.

Recovery attempt writes are also read back and validated. `RecoveryAttemptPersistenceError` preserves the returned transaction hash in memory when post-broadcast persistence fails.

Recovery attempts are not portable receipt data.

### Storage failure boundaries

Critical reveal material is different from mutable attempt history:

- reveal material must persist and read back before a commit can be broadcast;
- a transaction-attempt write can fail after the wallet/provider already returned a hash;
- therefore an attempt persistence error must never be presented as proof that submission failed.

The bidder controller treats browser receipt storage as required for commit safety. Recovery attempt history may fall back to session-only volatile storage when local storage is unavailable because fresh recovery contract state remains authoritative.

## Submission boundary

Protocol writes use `submitWalletWrite` where integrated. It does exactly one wallet submission call. There is no automatic retry loop for writes.

If the wallet/provider rejects submission with a known duplicate/reused-nonce shape (`transaction already imported`, `already known`, or `nonce too low`), the helper does not relabel that as a revert. It reads the sender's latest chain nonce when possible and returns an explanation that nothing new was proven broadcast by that call.

Automatic retries are for idempotent reads, never for wallet writes.

A user rejection or unrelated provider failure before a hash is returned has no `submitted` attempt because there is no known submitted transaction to track.

## Confirmation depth and wait algorithm

Each runtime profile supplies `confirmationDepth`. A transaction becomes `confirmed` only after `waitForTransactionReceipt` returns a successful receipt at that configured depth. The UI must not infer confirmation from elapsed time, a returned hash, or an optimistic local state transition.

For persisted bidder and recovery attempts, `waitForTransactionConfirmation` delegates the receipt wait to `waitForMinedTransaction` and supplies viem's replacement callback.

The algorithm is:

1. wait for the tracked hash at the configured confirmation depth;
2. in parallel, after the stall delay, inspect the known transaction and latest account nonce for a persistent nonce gap;
3. on safe repricing, create a successor `submitted` attempt for the replacement hash and mark the original `replaced` with `replacementAttemptId`;
4. on wallet cancellation or a different same-nonce replacement, mark the original `replaced`, preserve the explanation, and stop;
5. on a receipt with `status == reverted`, persist `reverted` and fail the operation;
6. on a successful receipt, persist `confirmed` and return the receipt plus current attempt;
7. on any other wait failure, persist `dropped` only when the current error classifier sees `dropped`; otherwise persist `unknown`, then rethrow the original failure.

There is no synthetic success and no retry submission in this algorithm.

## Replacement, repricing, and wallet cancellation

Replacement reason is supplied by viem.

### Safe repricing

`reason == repriced` is the only replacement the application follows automatically.

For persisted bidder/recovery attempts:

1. create a new attempt with the replacement hash and `state = submitted`;
2. mark the original `state = replaced`;
3. set the original `replacementAttemptId` to the successor attempt;
4. continue the same receipt wait;
5. persist the terminal state on the successor.

This preserves both hashes across reload. The old hash is historical; the successor is the live leg of that repricing chain.

### Wallet cancellation

`reason == cancelled` is unsafe to follow as proof of the intended call. The original attempt becomes `replaced`, the replacement hash is included in the persisted error text, and the active operation fails.

Fresh contract state decides whether the original action is still available. No automatic retry follows the cancellation transaction.

### Different same-nonce replacement

`reason == replaced` has the same safety rule as cancellation. The replacement is a different wallet transaction and cannot prove the intended auction/recovery action. The original becomes `replaced`; the operation stops; fresh state decides what can happen next.

For recovery only, an unsafe wallet-replaced attempt with no `replacementAttemptId` is considered retryable *only after* a fresh recovery read still exposes that item as claimable. The original leg of a safe repricing chain is never separately retryable.

## Nonce gaps and local-chain desynchronization

A known transaction can be accepted by a node but unmineable because its nonce is ahead of the account's current executable nonce. This is especially reproducible in local development when an Anvil snapshot is restored but MetaMask retains its previous per-network nonce tracker.

Example:

```text
chain latest nonce = 2
wallet signs tx nonce = 4
=> nonce 2 and/or 3 are missing
=> tx 4 can remain queued even with automine enabled
```

### Watchdog behavior

`waitForMinedTransaction` starts a nonce-gap watchdog after 15 seconds by default. `describeStalledTransaction`:

1. reads the tracked transaction by hash;
2. returns no stall if it is already mined;
3. reads the sender's `latest` transaction count;
4. reports a gap only when `transaction.nonce > latest chain nonce`.

One observation is not enough because public RPC propagation can temporarily expose inconsistent mempools. The default requires three consecutive observations from the same client, ten seconds apart. A persistent gap throws `StalledTransactionError` with the signed transaction nonce, endpoint chain nonce, and recovery advice.

The current six-state persistence model records that thrown stall as `unknown`, with the actionable nonce-gap text in `lastReconciliationError`; there is intentionally no seventh `stalled` state in the current implementation.

### Duplicate/reused-nonce submission rejection

When a new wallet write itself is rejected as already imported/known or nonce-too-low, there may be no new hash to persist. `submitWalletWrite`/`describeRejectedResubmission` therefore report the latest chain nonce and explicitly say the call did not prove that a new transaction was broadcast.

### Local-development recovery

Clearing the wallet's activity data for the reset local network is the wallet-side reset for a queued transaction stranded by a snapshot restore. See [local-development.md](local-development.md).

Production application code must not fill nonce gaps, impersonate accounts, or automatically resubmit writes.

## Reload and recovery limitations

Persistent local history survives an ordinary page reload, wallet disconnect, and later reconnect because it is browser storage. It is still scoped by the relevant receipt or recovery identity.

The application does **not** resume the in-progress JavaScript receipt waiter after reload. Current behavior is reconstruction, not waiter resumption:

1. reload immutable reveal material and mutable attempt history;
2. read fresh contract/recovery state for the active wallet, chain, deployment, and auction;
3. use persisted attempts as diagnostic/history evidence;
4. expose actions from fresh contract state, never solely from a stored `submitted`, `unknown`, or `dropped` attempt;
5. never automatically rebroadcast the persisted hash's action.

Account, chain, deployment, route, or auction-context changes invalidate prepared in-memory operations and late asynchronous results. They do not delete valid local history.

Bidder transaction history never blocks an action that fresh contract state says is available. Recovery likewise does not create live recovery rows from local history alone; fresh recovery items create the rows.

Recovery retry safety is stricter than display actionability:

- `submitted`, `unknown`, and `dropped`: unresolved, not automatically retryable;
- `confirmed`: not retryable as a transaction attempt; reconcile current recovery state instead;
- `reverted`: may be retried only through a newly prepared action against fresh claimable state;
- unsafe `replaced` with no successor: may be retried only against fresh claimable state;
- safe-repriced original with `replacementAttemptId`: never separately retryable.

## End-to-end action traces

Every write flow follows the same skeleton: fresh-read the active wallet/chain/deployment, wiring and action-specific eligibility → prepare exact reveal/request material → (if an exact bond approval is needed) simulate/estimate/submit it, wait for its receipt, then re-read stage/wiring/allowance/eligibility → simulate/estimate/submit the protocol write → immediately persist a `submitted` attempt for the returned hash → run the shared confirmation/replacement/nonce-gap lifecycle → reconcile fresh contract state/logs → show business success only when that reconciliation supports it.

Per-flow deltas from that skeleton:

- **Commit / recommit:** construct or reuse immutable reveal material and persist/read it back before any approval or commit write (the critical bid-persistence rule); reconcile fresh commitment/bond state.
- **Cancellation:** no approval leg; fresh-read the live commitment and cancellation eligibility, then reconcile fresh commitment/bond state and receipt evidence before showing the outcome.
- **Reveal:** load and validate canonical local reveal material first; reconcile fresh revealed/escrow state and receipt evidence.
- **Recovery:** build the item from fresh contract reads/log evidence and re-verify identity/economics are still current before submitting; persist the expected returned/burned amounts on the attempt; rebuild fresh recovery state and verify exact receipt/event evidence, but keep transaction state `confirmed` even when post-confirmation recovery reconciliation is unavailable or mismatched, with reconciliation text stored separately.

## Confirmation is not economic reconciliation

The application intentionally separates:

```text
transaction execution state != auction/recovery business state
```

A `confirmed` attempt says that the EVM transaction did not revert at the required confirmation depth. The relevant flow then asks the contract again whether the expected commitment, cancellation, reveal, lock, refund, or recovery state exists.

For bidder commit/cancel/reveal attempts:

- a confirmed contract mismatch can be stored as `reconciliationErrorKind = contract-mismatch` while transaction state stays `confirmed`;
- a transient post-confirmation read failure does not rewrite the transaction into `unknown` and is not retained as authoritative transaction-state error metadata.

For recovery attempts, current code retains post-confirmation reconciliation error text while keeping `state = confirmed`.

## UI and error-message principles

Transaction messaging must preserve what is actually known:

- Never call a provider submission error a revert unless there is a reverted receipt.
- Never call `submitted` a success. A hash is not a receipt.
- Never call `confirmed` an auction/recovery success until the flow-specific targeted reconciliation supports that domain claim.
- Present `dropped` and `unknown` as unresolved network outcomes. Do not say the transaction definitely never mined.
- For a persistent nonce gap, include both the signed transaction nonce and endpoint chain nonce, explain that the transaction can still mine if the gap is filled, and give local-reset guidance only for the local-development case.
- For duplicate/reused-nonce submission rejection, say that the new call did not prove a new broadcast; do not infer the fate of an earlier same-nonce transaction.
- For safe repricing, surface the replacement hash as the current tracked hash.
- For wallet cancellation/different replacement, say that the intended action is no longer proven by the waited hash and require fresh state before another action.
- On post-broadcast persistence failure, preserve the returned hash in the error because the transaction may already be live.
- Diagnostics and local attempt history may explain an incident but must not override current contract state.

## Diagnostics boundary

Local diagnostics are advisory. A diagnostics failure never changes transaction state and never blocks a transaction or receipt operation.

Bidder transaction attempt creation and state updates emit sanitized transaction diagnostics containing attempt kind, state, and public transaction hash. Diagnostics must never contain signatures, reveal material, private receipt storage keys, calldata, or wallet addresses by default.

Local diagnostics are support evidence only. They cannot override browser attempt storage, transaction receipts, or current contract state.

## Contributor checklist for a new write action

Before adding or changing any bidder/recovery write flow:

- [ ] Fresh-read the active wallet, chain, deployment, wiring, and action-specific eligibility before preparing the write.
- [ ] Simulate and estimate the exact request that will be submitted; do not mutate the request between simulation/estimate/submission.
- [ ] Persist/read-back any critical pre-broadcast secret material required by the action before the first chain write.
- [ ] Use a single wallet submission attempt; do not add automatic write retries.
- [ ] Do not create a persisted transaction attempt until a transaction hash exists.
- [ ] Persist `submitted` immediately after a protocol-write hash is returned, and surface post-broadcast persistence failure with that hash.
- [ ] Route receipt waiting through the shared confirmation/replacement/nonce-gap policy rather than inventing action-specific semantics.
- [ ] Follow only safe `repriced` replacement automatically; stop on wallet cancellation or a different replacement.
- [ ] Respect the runtime profile's confirmation depth.
- [ ] Keep `dropped`/`unknown` unresolved; never convert them to success or safe retry solely from local history.
- [ ] After receipt confirmation, perform the minimum targeted contract/log reconciliation needed for the user-visible domain claim.
- [ ] Treat account/chain/deployment/context changes as invalidating prepared operations and late results.
- [ ] On reload, reconstruct from fresh chain state plus local attempts; do not rebroadcast writes.
- [ ] Keep mutable attempt history out of portable reveal-material backups.
- [ ] Emit only sanitized diagnostics; no signatures, reveal material, calldata, storage keys, or wallet addresses by default.
- [ ] Add the smallest runnable test covering any new non-trivial lifecycle branch, especially replacement, persistence failure, or unresolved waits.

## Current implementation mismatches and follow-up scope

The following are documented gaps in `main@2454c54d39e8291675188cb1acbc8111b419a267`, intentionally **not** changed by issue #139. Each names its evidence, impact and follow-up.

### 1. Approval attempts are modeled but not persisted

`TransactionAttemptKind` includes `approval`, but commit/reveal approval paths call `waitForMinedTransaction` directly and track the approval hash only in the active operation; commit tests confirm the stored attempt list holds only the commit attempt after a flow that also approved. Impact: approval confirmation/repricing state is lost on reload and is absent from bidder-attempt diagnostics. Follow-up: persist approval attempts through the shared adapter, or narrow the data-model promise so `approval` is explicitly ephemeral — do not keep the half-modeled state.

### 2. Page reload reconstructs state but does not resume confirmation polling

Attempt hashes and unresolved states survive in storage and are reloaded as diagnostic history alongside fresh contract reads, but no controller restarts `waitForTransactionAttempt`/`waitForRecoveryAttempt` for a persisted unresolved hash. Impact: a transaction submitted just before reload can stay `submitted`/`unknown`/`dropped` forever in local history even if it later confirms; fresh contract state keeps the product safe but attempt history can go stale. Follow-up: add explicit hash reconciliation/resume on reload without rebroadcasting.

### 3. `dropped` is provider-text classification, not evidence-based finality

`waitFailureState` returns `dropped` whenever the lowercased error text contains `dropped`; all other failures are `unknown`. Impact: the persisted word `dropped` sounds stronger than the evidence and varies by provider wording. Follow-up: rename/redefine the state or reconcile it from explicit chain evidence; until then UI/docs treat `dropped` as unresolved network-resolution status, never proof of permanent disappearance.

### 4. Recovery transaction transitions are not written to local diagnostics

Bidder `createTransactionAttempt`/`updateTransactionAttempt` call `emitDiagnostic` on every transition; `recovery-attempt.ts` persists the same six-state lifecycle with no diagnostics hook. Impact: asymmetric support coverage for two flows using the same confirmation engine. Follow-up: journal sanitized recovery state/hash transitions through the existing diagnostics boundary; do not add a second logging system.

### 5. Post-confirmation reconciliation metadata is asymmetric

Bidder `persistTransactionReconciliationError` discards transient read failures and persists only explicit contract mismatches; recovery `persistRecoveryReconciliationError` stores reconciliation text without the bidder-style error-kind distinction. Impact: two confirmed attempts with the same post-confirmation RPC problem retain different local metadata. Follow-up: define one shared rule for transaction-state versus business-reconciliation metadata and adapt both stores without changing contract authority.

### 6. Unsafe replacement correlation is unstructured

Safe repricing creates a successor attempt with structured `replacementAttemptId` lineage; cancellation/different replacement marks the original `replaced` without a successor (the replacement is untrusted) and the replacement reason/hash survive only in error text. Impact: the safety decision is correct, but support/reload code must parse prose to correlate the wallet replacement hash and reason. Follow-up: add typed replacement reason/hash metadata without treating the replacement as the intended attempt.

### 7. Failure-path adapter updates are persisted but their returned value is discarded

On an ordinary confirmation failure, `waitForTransactionConfirmation` calls `input.adapter.update(current, ...)` then rethrows without assigning or returning the updated attempt. The adapters persist inside `update`, so storage receives `dropped`/`unknown`, but the caller receives only the thrown error. Impact: correct storage behavior, but asymmetric success/failure data flow that relies on adapter side effects. Follow-up: return/throw a structured result containing the updated attempt if callers need typed failure outcomes; not changed within this documentation audit.

## Non-goals for issue #139

This audit does not:

- change `transaction-confirmation.ts`;
- change bidder/recovery transaction helpers or controllers;
- change receipt or recovery storage schemas;
- change tests;
- add automatic wallet-write retries;
- make local attempt history authoritative;
- export mutable attempt history in receipt backups;
- add production nonce-filling behavior;
- edit `docs/README.md`, which is owned by issue #136.

Those changes, where justified by the mismatch list above, belong in separately scoped implementation work.
