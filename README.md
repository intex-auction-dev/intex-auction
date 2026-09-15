# Intex Auction

Intex Auction is a bidder application for the Intex auction flow. It runs entirely in your browser: you browse auction data, and once a deployment is configured you can connect a wallet and place bids.

This page covers how to start it, how to configure it, and what to do when something looks wrong.

## Before you start

- **Node 24** and **npm 11.6.2**.
- A current desktop version of **Chrome, Edge, Firefox or Safari** (the latest two major releases are supported).
- A browser window of at least **600 × 720** pixels. The application is desktop-only.

## Start the application

From the repository root:

```sh
npm ci
npm start
```

Then open **[http://127.0.0.1:4173](http://127.0.0.1:4173)**.

Press `Ctrl-C` in the terminal to stop it.

Two things to know:

- `npm start` rebuilds the application every time, so the first start takes longer than later ones.
- It only ever serves `http://127.0.0.1:4173`. If that address is busy it stops with an error instead of quietly moving to another port. To use a different port, set the `ITX_APP_PORT` environment variable.

## Start from a released archive

If you were given a release archive instead of the source code, you do not need npm. Check the download, unpack it, and run it with Node:

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf intex-auction-<version>.tar.gz
cd intex-auction-<version>
node static-host.mjs
```

Open the same address, **[http://127.0.0.1:4173](http://127.0.0.1:4173)**. On Windows PowerShell, compare the output of `Get-FileHash intex-auction-<version>.tar.gz -Algorithm SHA256` against the matching line in `SHA256SUMS`.

Run the command from inside the unpacked folder, because it needs the `dist` and `config` folders that sit next to it. `ITX_APP_PORT` works here too.

To host the application on a server rather than your own machine, see [Runtime configuration](config/README.md), which lists the paths, headers and security policy a host must provide.

## What you see the first time

A message saying **"Deployment not configured"**. This is expected and is not a fault.

The application ships with example settings that are switched off on purpose, so a fresh copy contacts no network at all. It stays this way until you fill in real values.

Below the message is a small status panel summarising your configuration. It appears whenever the configuration is not yet complete, so you can use it to check your progress as you edit the settings.

**You will know the application is fully configured when these messages disappear and the auction calendar appears instead.** You can then open an auction from the calendar.

## Configure the application

All settings live in plain JSON files in the `config` folder. They are read **once, at startup**.

Whenever you change one:

1. Stop the application (`Ctrl-C`).
2. Edit the file.
3. Start it again and **reload the browser page**.

| File | What it holds |
| --- | --- |
| `config/chains.json` | The networks to use, and their RPC addresses in order of preference |
| `config/deployments.json` | The contract addresses on each network |
| `config/timing.json` | One auction timing value used to estimate when results are expected |
| `config/walletconnect.json` | Your WalletConnect project ID and details |
| `config/content-security-policy.json` | Security headers for the host |
| `config/abi/` | Technical descriptions of the contracts, which the application needs in order to talk to them |

An *RPC address* is simply the network endpoint the application talks to in order to read the blockchain. You can list several per network; the application uses the first one that responds and only moves on if it stops working.

Two rules matter:

- Only set an entry to `"enabled": true` once **every** value it needs is filled in. An incomplete entry that is switched on is rejected, and the application tells you which field is wrong.
- Settings are never edited inside the application, and network addresses are never stored in your browser. These files are the only source.

[config/README.md](config/README.md) explains every field in detail.

### WalletConnect

Wallet browser extensions work on their own and never need WalletConnect. WalletConnect is only for connecting a phone wallet or a wallet on another device.

It is controlled entirely by `config/walletconnect.json`. While the application is not yet fully configured, the status panel on the start page shows a **WalletConnect** row:

- `Configured` — it is on and its settings are usable.
- `Disabled` — it is off, **or** it is on but something in its settings is wrong. If you switched it on and still see `Disabled`, recheck the fields below.

To switch it on, set `"enabled": true` and add a project ID from WalletConnect Cloud. To switch it off, set `"enabled": false`.

Whichever you choose, one setting matters most: `metadata.url` must be **exactly** the address you open the application at, normally `http://127.0.0.1:4173`. Allow that same address in your WalletConnect Cloud project too. If they do not match character for character, connecting will fail.

## If something goes wrong

Find the message you see on screen.

### "Deployment not configured"

Expected on a fresh copy. Fill in `config/chains.json` and `config/deployments.json`, switch those entries on, then restart. See [Configure the application](#configure-the-application).

### "Configuration requires attention"

One of your settings is incomplete or inconsistent. A **"Configuration issues"** list appears below, naming each problem. Fix the named fields, restart, and reload the page.

### "Application could not be loaded"

Startup stopped. The text underneath tells you which of these it is:

- *"Unable to load /config/chains.json"* or *"Unable to parse … as JSON"* — a settings file is missing, or its JSON is invalid. Check the file for a stray comma or bracket, and check you started the application from a folder that contains the `config` folder.
- *"No configured RPC endpoint is healthy…"* — none of the addresses listed for that network could be used: either they did not respond, or one answered for a different network than the entry claims. Check them in `config/chains.json`, and check your internet connection. If they are correct, the provider may be temporarily down; wait and retry, or add another address to the list.
- A message about a *mismatch* — the addresses in `config/deployments.json` do not point at the contracts the application expects on that network. Recheck them, and if they were given to you, ask whoever provided your deployment for the correct values for this network.

### "Cannot start Intex Auction: http://127.0.0.1:4173 is already in use."

Something else is using that address, often an earlier copy of this application still running. Stop it, or set `ITX_APP_PORT` to a free port.

### "Production build not found" or "Run this from the directory that contains dist/ and config/"

You are running the server from the wrong folder. Move into the unpacked release folder, or run `npm run build` first in a source checkout.

### "This browser is missing required capabilities"

Your browser is too old. The message lists what is missing. Update it, or use a current Chrome, Edge, Firefox or Safari.

### "A larger viewport is required"

The window is smaller than 600 × 720 pixels. Make it bigger, or zoom out.

### "Selected network is not supported"

Your wallet is on a network this application does not serve. This message replaces the page and offers a **"Switch to …"** button for each supported network; use one, or change networks in your wallet. Bid receipts already saved in your browser are kept when you switch networks or accounts.

### "No injected wallet was detected."

No wallet extension was found in this browser, and WalletConnect was not available either. Install a wallet extension, or check the [WalletConnect](#walletconnect) settings.

### A change to a settings file made no difference

Settings are only read at startup. Stop the application, start it again, and reload the browser page.

## More documentation

- [Runtime configuration](config/README.md) — every setting field, and what a host must provide.
- [Transaction lifecycle](docs/transaction-lifecycle.md) — how bidding, results and recovery behave.
- [Current contract profile](docs/current-production-contract-profile.md) — the signing and contract behaviour in use.
- [Documentation map](docs/README.md) — the full set of technical documents.
