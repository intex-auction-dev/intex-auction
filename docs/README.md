# Production Architecture Index

**Status:** Authoritative document map  
**Updated:** 2026-08-24

## Read order

Before planning or implementing production functionality, read:

1. `AGENTS.md` — product scope, confirmed production constraints and the domain rules that govern customer-facing work;
2. `current-production-contract-profile.md` — current transaction profile, exact EIP-712 semantics, historical-profile boundaries and profile-specific source precedence;
3. `auction-app-system-architecture.md` — accepted system views and architectural rationale.

The accepted product and architecture decisions are recorded in `AGENTS.md` and the documents listed above; `current-production-contract-profile.md` is authoritative for signing and profile semantics. Per-surface protocol behavior is read from the pinned contracts and their tests under `blockchain/outbe-chain/`, which win over any prose.

## Precedence

When documents conflict:

1. current pinned/deployed contract implementation and focused contract tests win for on-chain behavior;
2. current runtime profile validation plus transaction/receipt code determine which reviewed contract profile the application is willing to use, but may not redefine contract semantics;
3. `current-production-contract-profile.md` and `AGENTS.md` are the current maintainer-facing profile/read-order summary and must be reconciled to items 1-2 when those sources change;
4. `AGENTS.md` and newer accepted architecture decisions govern their scoped product/architecture decisions; a newer scoped amendment supersedes older decision, phase or open-question wording;
5. product and system documents remain authoritative where no later accepted decision changes them.

For current commit/reveal signing, adapter selection or receipt cryptographic identity, use `current-production-contract-profile.md` verified against the pinned contract implementation/tests and current transaction code, not an older document labelled “current.” Do not infer answers from stale prose; update the relevant decision document when a real unresolved question appears.

## Normalization resolutions

The following earlier inconsistencies are resolved:

- The modular static frontend monolith and the system architecture document are accepted for the first release; multi-tab coordination, advanced reorg infrastructure, Docker, a hosted indexer and generalized workflow frameworks do not block it.
- Repository-level `config/` is the only product runtime-value source; `src/runtime-config/` holds loaders/validation/types (no second `src/config/` store) and `localStorage` stores no RPC overrides. The product has no browser editor for RPC, deployment or WalletConnect configuration. ABIs are plain reviewed JSON under `config/abi/`.
- The supported production origin is fixed at `http://127.0.0.1:4173`. Browser support is the latest two major desktop releases, at release time, of Chrome, Edge, Firefox and Safari.
- Contract timestamps are canonical Unix seconds. WorldwideDay keys are `YYYYMMDD` values from the protocol's UTC+14 calendar; Oracle UTC accounting-day keys are a separate domain despite sharing the same integer shape.
- Canonical WorldwideDay existence, lifecycle and Green/Red state are always read from the configured Outbe origin, regardless of the selected or wallet-connected venue. Cleaned origin history is never collapsed into `not found`.
- The active venue contributes only its local auction-delivery, exact schedule, stage, bids, escrow, result and issuance overlay, joined to origin state by `worldwideDay`. Before venue delivery, the exact auction date/schedule remains pending rather than derived from a fixed offset.
- The reviewed `bidRate` is a percentage of the escrow basis (`promisLoadMinor`), not a proven percentage of strike. The UI shows the exact wCOEN lock amount and treats Entry/Floor/Call as separate reference values.
- The first-release COEN/VWAP chart uses one reviewed Outbe Oracle adapter and one configured pair; it introduces no generic market-data or oracle framework.
- Confirmed bid receipts distinguish the cryptographic commit hash from transaction hashes and visibly report backup state and receipt sensitivity.
- The local Anvil harness generates `.local/config/` only for `local:web`; it does not create a second production configuration model. The one-chain loopback harness may satisfy both origin and venue roles, but production domain and adapter boundaries keep those contexts separate. The local contract environment is required before transaction-capable application phases.
- Release hardening has no visual-prototype cutover gate: the visual prototype, its independent build and its deployment path are removed. Functional completeness or one representative screenshot still does not establish that a customer-facing requirement is met.

## Implementation readiness

The architecture is ready for continued implementation. Phase 11 remains open until release hardening is complete.

Unknown production RPCs, addresses and deployment blocks remain configuration-population tasks. Development and required CI use the accepted local Anvil environment until verified production deployment profiles are available.
