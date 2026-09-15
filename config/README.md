# Runtime configuration

This folder is the single editable source for deployment-specific and operational product runtime values.

```text
config/
  chains.json
  content-security-policy.json
  deployments.json
  timing.json
  walletconnect.json
  abi/
    IMetadosis.json
    IDesis.json
    OriginRouter.json
    IOracle.json
    IIntex.json
    IntexAuction.json
    EscrowAdapter.json
    TargetRouter.json
    TheCompact.json
    ERC20.json
    IntexNFT1155.json
```

The TypeScript code that loads and validates these files belongs under `src/runtime-config/`. Do not create a duplicate `src/config/` value store or another ABI directory under `src/`.

## Starter status

The committed values are safe placeholders, not a production deployment:

- the designated Outbe origin profile and the BNB mainnet venue profile are disabled;
- the unknown Outbe chain ID, native-currency metadata, explorer URL and deployment block remain `null`;
- the Metadosis, Desis, OriginRouter, Oracle and canonical Intex addresses remain `null`;
- the reviewed COEN pair remains unset;
- RPC URLs use the reserved `.invalid` domain;
- venue deployment addresses, the reviewed live `IntexAuction` implementation address, and the deployment block are `null`;
- both deployment records identify the reviewed source baseline `outbe/outbe-chain@f5477b56c9a4192755354a3f2577603dffe5b3a6`; this is source provenance, not evidence of a live deployment;
- WalletConnect is disabled and has no project ID.

Replace the relevant values and set the chain and deployment entries to `enabled: true` only when the configuration is complete.

## Rules

## Official release artifact

The official handoff is the prebuilt static archive described by the root `README.md`, not the source checkout. It contains this folder's runtime JSON and ABI files at `/config/**`, but it does not contain Node, Vite, `scripts/server/serve.mjs`, local diagnostics, Anvil, `/dev`, or development tooling.

The operator hosts `dist/index.html` and `dist/assets/**`, exposes these JSON/ABI files at `/config/**` with no long-lived caching, configures SPA fallback, correct MIME types and the security headers defined by `content-security-policy.json`. The host must expand `@configured-rpc-origins` from enabled `chains.json` URLs; it must not use a wildcard CSP. Edit RPC URLs in `chains.json`, update that same CSP expansion, and reload/restart the chosen host—no browser rebuild is required.

The archive's bundled `static-host.mjs` already applies the required mapping and headers, and needs only Node 24; set `ITX_APP_PORT` to serve a port other than `4173`. Any other static host must apply the same mapping, because the application is built for an origin root and requests its runtime configuration from `/config/*.json` at startup:

| Request path | Served from | Headers |
| --- | --- | --- |
| `/config/*.json` | `config/*.json` | `application/json; charset=utf-8`, `Cache-Control: no-store` |
| `/assets/*` | `dist/assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| everything else | `dist/index.html` | `Cache-Control: no-store` |

A host rooted at `dist/` alone cannot serve the application: every `/config/*.json` request fails and startup stops. Alongside the CSP, send `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. If WalletConnect is enabled, the host origin must match the configured metadata URL exactly.

`FILES.sha256` inside the unpacked directory covers every packaged file, and `RELEASE.json` records the exact commit, tag, pinned toolchain and runtime-configuration schema versions the archive was built from. The archive records only pinned toolchain facts, so rebuilding the tagged commit reproduces every packaged file on any Node 24 with the pinned npm. Compare the published `FILES.sha256` with the one a rebuild produces:

```sh
git checkout <tag> && git submodule update --init --recursive
npm ci && npm run release:package
shasum -a 256 .release/intex-auction-<version>/FILES.sha256
```

The compressed archive's own hash in `SHA256SUMS` additionally depends on the zlib bundled with the exact Node patch version that produced it, which the release workflow run summary records; two builds on the same Node patch produce identical archives.

The generic WalletConnect profile is intentionally disabled with no project ID. Before enabling it, the operator supplies a project ID, metadata URL exactly matching the deployed origin, optional same-origin icons, and matching WalletConnect Cloud allowlist/origin configuration; then restarts/reloads. Injected-wallet operation remains available when WalletConnect is disabled.

- Do not duplicate these values as constants inside application components or feature modules.
- `originChainProfileId` designates the single canonical Outbe origin profile. Its `roles` must include `origin`.
- A release-capable origin deployment provides separate Metadosis, Desis, OriginRouter, Oracle and canonical Intex address/ABI entries plus one reviewed COEN pair. Equal addresses are allowed only when a reviewed deployment, such as the local controller, implements more than one authority.
- `defaultDisconnectedVenueChainId` designates the disconnected read-only venue; its enabled profile must include the `venue` role.
- A chain profile may contain both roles only for a reviewed topology such as the local one-Anvil loopback. Domain and adapter responsibilities remain separate.
- An incomplete disabled profile may retain `null` values. Any enabled profile must be complete and internally consistent.
- An enabled external chain must have explorer metadata; loopback-only local Anvil profiles are exempt. A profile that sets `developmentChain: true` and reaches the chain only through loopback URLs or the application's own origin is also exempt, which is what a reverse-proxied development host generates. The flag never exempts a third-party RPC origin.
- Every enabled deployment must use the exact reviewed ABI filename mapping. An enabled external deployment must also identify the exact reviewed source baseline `outbe/outbe-chain@f5477b56c9a4192755354a3f2577603dffe5b3a6`.
- An enabled external venue must provide the reviewed live `IntexAuction` implementation address in addition to the proxy address. Startup checks the ERC-1967 implementation slot, implementation bytecode, and the proxy EIP-712 domain (`IntexAuction`, version `1`, active chain ID, configured proxy) before the venue is usable.
- Enabling any venue read path requires exactly one complete enabled origin profile and one matching origin deployment.
- Load and validate the JSON files once at application startup.
- Configuration changes require restarting the application and reloading the browser.
- `content-security-policy.json` is the single production CSP definition. `@configured-rpc-origins` in `connect-src` expands at server startup to the origins of enabled `chains.json` RPC URLs; keep that token rather than duplicating RPC hosts in the policy.
- ABI files are ordinary JSON files containing the ABI array. They carry no source-commit pin, fingerprint registry or generated metadata requirement.
- `npm run check:contract-profile` verifies the required selectors/events against the reviewed embedded source and rejects obsolete NFT expiry entries.
- The filenames referenced by `deployments.json` are the ABI files used by the application.
- Keep deployment profiles disabled while any required chain ID, address, block, metadata or ABI file is missing.
- Contract schedules use Unix timestamps in UTC seconds. WorldwideDay keys use the protocol's UTC+14 calendar, while Oracle UTC accounting-day keys remain a separate domain. Local time may be displayed as secondary information.
- Keep the loader direct and small. Add abstractions only when a second real product configuration source or format exists.
- Do not store RPC overrides in browser storage or add an in-application deployment editor.
- `timing.json` carries the reviewed origin auction timing expectations used by the product copy (currently the Desis bid fan-in deadline). It must match the reviewed origin constants; changing it requires restarting the application and reloading the browser.

The numeric defaults in `chains.json` are initial implementation choices and may be edited later without changing application code.

## Local Anvil development

A development-only Anvil environment deploys the real bidder-facing Solidity stack before production addresses exist.

The local orchestration scripts generate:

```text
.local/
  deployment.json
  config/
    chains.json
    deployments.json
    walletconnect.json
    timing.json
    content-security-policy.json
```

`.local/` is gitignored. `npm run local:web` serves the generated files at the same `/config` URLs used by the normal runtime loader. This keeps application code and ABI selection identical while allowing the local chain addresses to be regenerated after reset. `ITX_RUNTIME_CONFIG_DIR` selects the same directory for the compiled server in `scripts/server/serve.mjs`.

The local chain binds to `127.0.0.1`. `ITX_LOCAL_RPC_HOST=0.0.0.0` binds it to every interface so another device on the local network can reach it, which is required only for mobile WalletConnect testing and also enables the generated `walletConnectRpcUrl`. Use it deliberately; on a networked host it exposes the development chain to anything that can reach that interface.

The generated overlay contains separate logical origin and venue deployment profiles even though both use chain ID `31337`. It is not a second product configuration model:

- normal `npm start` uses the committed files in this directory;
- local development uses `.local/config/` only through the local development server;
- production builds do not include local keys, faucet settings or protocol-controller addresses;
- the local controller occupies the Metadosis, Desis, Oracle and canonical Intex profile entries while the real OriginRouter remains independently addressed;
- the real auction, escrow, target router and NFT contracts remain the venue profile;
- the same reviewed ABI files under `config/abi/` are used against Anvil;
- local startup fails when the generated chain ID, bytecode or wiring does not match the running node; the generated development profiles do not claim external production provenance or a reviewed production proxy implementation.

The generated profiles set `developmentChain: true`, so validation exempts them from explorer, reviewed-source and reviewed-implementation requirements only while their RPC endpoints stay on local development endpoints.

## Safe production boot

The production application loads these JSON files once at startup. The supported source toolchain is Node 24 with npm 11.6.2. The committed disabled profiles are expected to render a **Deployment not configured** state and must not contact any configured RPC URL.

```text
npm ci
npm start
```

The supported application origin is `http://127.0.0.1:4173`. The command fails rather than selecting another port when that origin is occupied. Configuration changes require stopping the process, editing the JSON files, restarting, and reloading the browser.

## WalletConnect setup

WalletConnect is configured only in `config/walletconnect.json`; do not add a settings editor or an application constant. Obtain the project ID from WalletConnect Cloud and place it in the runtime JSON as `projectId`. It is an identifier, not a signing secret, but keep it in the documented runtime configuration rather than hard-coding it or committing a deployment-specific project ID.

Set `enabled: true` only when the project ID and complete metadata are present. The metadata `url` must be exactly the origin the application was loaded from, which is `http://127.0.0.1:4173` for the supported production workflow and the published origin for a development host. Configure the same origin as the allowed origin in WalletConnect Cloud. Optional metadata icons must be absolute URLs on that same origin; the supported default is `icons: []`, which should be retained when no local icon is needed.

Runtime configuration is loaded once at startup. After editing `config/walletconnect.json`, stop and restart the application, then reload the browser. An invalid, missing, unreadable, non-OK, or malformed WalletConnect document makes only WalletConnect unusable; valid read-only chain/deployment profiles, ABI loading, browsing, and injected-wallet discovery remain available.

The QR modal is provided by the pinned `@walletconnect/ethereum-provider@2.23.10` package with `showQrModal: true`. This release does not add a custom QR surface, `display_uri` logging, a QR dependency, or Reown AppKit. Connection URIs and session details are never logged.
