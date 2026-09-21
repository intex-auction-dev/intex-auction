# Current Production Contract Profile

**Status:** Authoritative current contract-profile and signing reference  
**Audited:** 2026-08-25  
**Application baseline:** `e2ee30f57207d21679e1f78fe2d00ef4d4205b64`  
**Pinned Outbe contract baseline:** `f5477b56c9a4192755354a3f2577603dffe5b3a6`

## Purpose

Read this document before any profile-specific contract, receipt, or transaction documentation.

It answers one narrow question: **which contract profile may the bidder application use to prepare new transactions, and which source wins when older documents disagree?** It does not replace the wider protocol authority model in `AGENTS.md` and the pinned contracts under `blockchain/outbe-chain/`.

## Current transaction profile

The only venue adapter profile accepted by the current runtime configuration is:

```text
multi-issuance-usd-reference
```

`src/runtime-config/runtime-config.ts` accepts that value as the only `VenueAdapterProfile`. `src/receipts/reveal-material.ts` uses the same value as `REVIEWED_ADAPTER_PROFILE`, and the commit path persists that profile with new reveal material.

The committed production venue record is:

```text
bnb-mainnet-venue-deployment
```

It selects `multi-issuance-usd-reference`, but `config/deployments.json` intentionally keeps the record disabled with no production deployment block, proxy address, or reviewed live implementation address. The record does identify the reviewed source provenance `outbe/outbe-chain@f5477b56c9a4192755354a3f2577603dffe5b3a6`; that provenance is not evidence that any particular contract is deployed. Therefore, at the audited repository baseline, **the repository defines current transaction semantics but does not contain an enabled transaction-capable production deployment**. Do not infer a live production proxy address or implementation from this document.

A deployment becomes write-capable only after the runtime loader validates the complete enabled origin and venue configuration. For external profiles, that includes explorer metadata, exact reviewed ABI mapping, exact reviewed source provenance, and—on a venue—the reviewed live `IntexAuction` implementation address. Selecting the adapter-profile string alone is not transaction authority.

## Exact EIP-712 reveal identity

New commits use the pinned upstream `IntexAuction` version-1 EIP-712 domain:

```text
name:              IntexAuction
version:           1
chainId:           active venue chain ID
verifyingContract: active IntexAuction proxy
```

The exact signed primary type, including field order, is:

```text
RevealBid(
  uint32 worldwideDay,
  address bidder,
  uint16 quantity,
  uint32 bidRate,
  uint16 issuanceCurrency,
  uint16 referenceCurrency
)
```

The sealed commitment is:

```text
commitHash = keccak256(signature)
```

`revealBid` separately receives:

```text
uint32 worldwideDay
uint16 quantity
uint32 bidRate
uint16 issuanceCurrency
uint16 referenceCurrency
uint64 chainId
bytes signature
```

The contract rejects a supplied `chainId` that differs from `block.chainid`. It then reconstructs the version-1 EIP-712 digest using `msg.sender` as `bidder`, recovers the signer, and requires both the recovered signer and `keccak256(signature)` to match the live commitment.

This is implemented consistently by the pinned upstream contract and signature tests, the committed ABI, reveal-material validator, and current commit/reveal transaction code. The contract and focused signature tests are the authority for the on-chain digest. The application code must match them; a disagreement is a defect or an incompatible deployment, not a new profile definition.

For an external enabled venue, startup also proves that the configured proxy's ERC-1967 implementation equals the reviewed implementation address, that implementation has bytecode, and `eip712Domain()` returns exactly `IntexAuction`, version `1`, the active chain ID, and the configured proxy as `verifyingContract`. Those checks run before the existing TargetRouter/IntexAuction/EscrowAdapter/payment-token/NFT wiring checks can establish venue compatibility. A mismatch fails closed.

### Primary source links

- [runtime adapter-profile validation](../src/runtime-config/runtime-config.ts)
- [committed deployment profile values](../config/deployments.json)
- [current `IntexAuction` ABI](../config/abi/IntexAuction.json)
- [current reveal-material schema and EIP-712 builder](../src/receipts/reveal-material.ts)
- [commit transaction preparation](../src/bidding/commit-transaction.ts)
- [cancel/reveal transaction preparation](../src/bidding/cancel-reveal-transaction.ts)
- [venue read/write adapter](../src/protocol/venue-adapter.ts) — responsibility-based module name; it does not select a runtime profile
- [pinned upstream `IntexAuction.sol`](https://github.com/outbe/outbe-chain/blob/f5477b56c9a4192755354a3f2577603dffe5b3a6/contracts/intex/src/target/IntexAuction.sol)
- [pinned upstream signature tests](https://github.com/outbe/outbe-chain/blob/f5477b56c9a4192755354a3f2577603dffe5b3a6/contracts/intex/test/foundry/IntexAuction.signature.t.sol)
- [pinned current Desis Rust auction-profile schema](../blockchain/outbe-chain/crates/core/desis/src/schema.rs)

## Currency authority in the current profile

The current profile does not use the historical `IntexAuctionV2` design. The pinned `IntexAuction` stores **reference-currency** price rows in `AuctionParams.prices` and signs both `issuanceCurrency` and `referenceCurrency` in the version-1 reveal value.

The current authority split is:

- `issuanceCurrency` is a bidder-declared signed label constrained by the pinned contract to the inclusive range `1..999`;
- `issuanceCurrency` is **not** required to occur in `AuctionParams.prices`; the application enforces the same `1..999` invariant before typed-data signing, reveal-material persistence, approval or commit/recommit submission;
- `referenceCurrency` must occur in the current auction's `AuctionParams.prices`; those rows are the contract authority for the current reference Entry/Floor/Call evidence;
- `AuctionParams.prices` is **not** an issuance-currency allowlist and its rows must not be projected into issuance-specific entry prices, strike amounts or Oracle-pair authority;
- the current adapter prefers USD ISO `840` as the reference row when it is present, otherwise it falls back to the first priced row for compatibility; an enabled deployment advertised as the USD-reference profile must therefore be reviewed to contain the intended USD pricing evidence rather than relying on that fallback;
- changing either signed currency changes the EIP-712 digest and therefore the signature and `commitHash`;
- local ISO metadata is display metadata only and cannot authorize or price a transaction currency.

The contract's `uint16` EIP-712 field width does not widen the valid upstream issuance range. A value such as `1000` is encodable as `uint16` but unrevealable by the pinned `IntexAuction`, so the application must reject it before creating canonical reveal material.

### Rust profile version is not the EIP-712 version

The historical Rust Desis labels `AUCTION_PROFILE_V1` and `AUCTION_PROFILE_V2`, discussed in the `fc739b3` review baseline, are not EIP-712 domain versions or frontend adapter-profile identifiers. Current Desis source at the pinned submodule commit must not be used as evidence for historical receipt profiles. In the current end-to-end profile, the venue `IntexAuction` reveal domain remains `version = "1"` and the frontend selector remains `multi-issuance-usd-reference`.

Do not infer `IntexAuctionV2` or EIP-712 version 2 from the Rust `AUCTION_PROFILE_V2` constant.

## Historical profiles

The following profiles are **not valid for preparing new transactions** in the current application:

| Profile | Historical signing shape | Current scope |
| --- | --- | --- |
| `fc739b3` | EIP-712 `IntexAuction` v1; four fields: `worldwideDay`, `bidder`, `quantity`, `bidRate` | Historical review/receipt interpretation only. It is not accepted by the current runtime profile selector and must not be used for a new commit. |
| `multi-issuance-usd-reference-v2` | EIP-712 `IntexAuction` v2; five fields: `worldwideDay`, `bidder`, `issuanceCurrency`, `quantity`, `bidRate` | Historical/design profile for a separate `IntexAuctionV2` deployment. It is not the current runtime transaction profile. |

Historical receipts must retain the profile and domain under which they were created. They must never be silently upgraded or re-signed under the current profile. A historical profile may be used only by an explicit historical validation/read-only compatibility path; this document does **not** claim that the current importer accepts every older receipt schema.

### Profile-specific prose that is historical

The following material must not be used to construct current typed data or select the current transaction adapter:

- older four-field `fc739b3` and version-2/five-field `IntexAuctionV2` material is historical only and must not prepare current transactions;
- `docs/auction-contracts-interaction-guide.md` — its `IntexAuctionV2`, domain-version-2, and five-field signing examples are superseded for current transaction preparation.

Where those documents remain useful for their other topics, only their profile-specific examples are historical unless a later scoped decision says otherwise.

## Protocol scales and gates at the pinned commit

Reviewed against `blockchain/outbe-chain` at `d7c78459`. `config/abi/abi-pin.json` records that
commit and `scripts/build/check-contract-profile.mjs` fails if the submodule advances past it, so a
future bump forces this section to be revalidated.

- **`promisLoadMinor` and the entry/floor/call prices are all `1e6`.** `IIntexNFT1155.SeriesData`
  documents `promisLoadMinor` as PROMIS-units per Intex unit (1e6) and the three prices as ISO
  stable-units (1e6); `contracts/precompiles/src/IIntex.sol` and `crates/core/intex/src/schema.rs`
  agree. The app's `PRICE_SCALE` and `PROMIS_DECIMALS` follow this, not an older `1e9`/18 pair.
- **The escrow lock is native-18, and the operation order is load-bearing.** `IntexAuction.sol`
  computes `quantity * promisLoadMinor * bidRate / SCALE_1E6 * NATIVE_UNITS_PER_PROTOCOL_UNIT` with
  the factor at `1e12`, truncating *before* the multiply. `(x / 1e6) * 1e12` differs from
  `(x * 1e12) / 1e6` whenever `x % 1e6 != 0`, so reordering silently desyncs the approval from the
  chain and from `Desis.rate_lock`. Pinned upstream by `test/foundry/cross-chain/LockAmountParity.t.sol`.
  On uint128 overflow the BNB target reverts `BidAmountOverflow` while Outbe saturates; the app
  simulates against the target and therefore rejects.
- **`commitBid` is whitelist-gated; nothing else is.** `requireWhitelisted(_s().whitelist, msg.sender)`
  guards only `commitBid`. A zero registry leaves the gate open by design. `IIntexAuction.whitelist()`
  and `IWhitelist.isWhitelisted(address)` make a pre-signature eligibility check possible, so an
  ineligible wallet is refused before it signs reveal material. Reveal, cancel and the claim paths
  are ungated, so an already-committed bidder can always still reveal and recover.
- **There is no separate no-split refund delay.** `EscrowAdapter` exposes only
  `UNFINALIZED_REFUND_DELAY` (72h), `POST_FINALIZE_REFUND_DELAY` (72h) and
  `COMMIT_BOND_ABANDON_DELAY` (30 days). `claimRefund` gates the finalized no-split case on
  `finalizedAt + POST_FINALIZE_REFUND_DELAY`, returning the full principal with no burn — the same
  gate as the split case, which burns `lockedAmount - failedRefund`.
- **`IntexState.Expired` is derived on read, never stored.** `IntexNFT1155._effectiveState` returns
  it once a `Called` series passes `calledAt + callNoticePeriod`, so a lifecycle decoder must accept
  tag 3.
- **An origin `*Sent` event does not prove dispatch.** `OriginRouter` emits it unconditionally at
  every `_sendOrPark` site with `sendId == 0` on the parked path, so park state must be read from
  `MessageParked` logs and recovered through the permissionless `resendParkedMessage(uint256)`.

## Authority and precedence

Use the following precedence when sources disagree.

1. **Pinned contract implementation and contract tests** decide on-chain behavior: EIP-712 domain construction, signed fields and order, `revealBid` arguments, replay protection, state predicates, and revert behavior. A configured live deployment must be proven compatible with the reviewed implementation before writes are enabled.
2. **Current runtime profile validation and transaction/receipt code** decide which reviewed profile the application is willing to use and exactly what the application prepares. They may fail closed more strictly than the contract, but they cannot redefine contract semantics. If they disagree with the pinned contract, fix/revalidate the application or disable writes.
3. **This document and `AGENTS.md`** are the maintainer-facing current profile/read-order summary. They must be updated when the sources in steps 1-2 change; they do not override those sources.
4. **`AGENTS.md` and accepted architecture documents** govern product and architecture decisions within their scope. Later scoped amendments supersede earlier decisions. In particular, the original v2 signing design does not override the current upstream contract profile, and receipt persistence/backup behavior is separate from signing semantics.
5. **Historical review baselines and superseded profile examples**, including the historical four-field examples, remain evidence only for the profile they explicitly reviewed. They do not prepare current transactions.
6. **Interaction guides, test-evidence notes, and older prose** are reference material only when they conflict with the authorities above.

`config/deployments.json` is authoritative for the deployment/profile values the application is configured to load. It is not evidence that an address is live or compatible when the entry is disabled or incomplete.

## Contract authority surfaces

Profile selection does not collapse protocol authorities. The current bidder application still treats WorldwideDay/Metadosis, Desis, OriginRouter, Oracle, Intex, IntexAuction, EscrowAdapter and IntexNFT1155 as independent authority surfaces. The per-surface authority rules are stated in `AGENTS.md` ("Production data rules") and are verified against the pinned contracts and tests under `blockchain/outbe-chain/`; read those after applying the profile precedence above.

## When changing a deployment or profile

Before enabling writes for a new or upgraded deployment:

1. record the application commit and exact pinned/deployed contract implementation being reviewed;
2. inspect the implementation and focused tests that define EIP-712 domain construction, type hash, `commitHash`, and `revealBid` validation;
3. record the live proxy and reviewed implementation addresses, then verify the ERC-1967 implementation slot, implementation bytecode, proxy domain (`name`, `version`, chain ID, verifying contract), and current dependency wiring;
4. verify the runtime adapter-profile identifier, exact reviewed ABI mapping, reviewed source provenance, explorer metadata, deployment block, addresses, and enabled/read/write-capability gates;
5. compare `reveal-material.ts`, commit preparation, reveal preparation, cancellation/recommit recovery, and receipt validation against the contract field widths and order;
6. if signing semantics change, create a new explicit profile/schema and retain old receipts under their original profile rather than reinterpreting them;
7. update this document, the architecture index, and any affected product/architecture decision before enabling the profile;
8. keep the deployment write-disabled until the repository's focused contract/profile checks and required transaction-path verification pass.

## Facts not proven by the repository

At the audited baseline, both committed production profiles are disabled. The source baseline is known, but the live deployment evidence is not. The repository therefore does not prove:

- the Outbe production chain ID, RPC endpoints, explorer, deployment block, or live origin-authority addresses;
- a live BNB production `IntexAuction` proxy address or deployment block;
- the implementation currently behind any external production proxy;
- the live BNB router/escrow/token/NFT wiring required by the bidder;
- that any external production deployment is compatible with the pinned contract commit.

Those facts are tracked by issue #147 and must be populated from authoritative deployment evidence and reviewed before a production profile becomes transaction-capable. Do not fill them from devnet/testnet values, historical prose, or assumptions.
