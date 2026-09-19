import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { getAddress } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const rpcPortText = process.env.ITX_LOCAL_RPC_PORT ?? '8545';
if (!/^\d+$/.test(rpcPortText)) {
  throw new Error('ITX_LOCAL_RPC_PORT must be an integer between 1024 and 65535.');
}
export const RPC_PORT = Number(rpcPortText);
if (RPC_PORT < 1024 || RPC_PORT > 65_535) {
  throw new Error('ITX_LOCAL_RPC_PORT must be an integer between 1024 and 65535.');
}

const rpcHostText = process.env.ITX_LOCAL_RPC_HOST ?? '127.0.0.1';
if (rpcHostText !== '127.0.0.1' && rpcHostText !== '0.0.0.0') {
  throw new Error('ITX_LOCAL_RPC_HOST must be 127.0.0.1 or 0.0.0.0.');
}
export const RPC_HOST = rpcHostText;

export const ROOT = resolve(here, '../../../../..');
export const CONTRACT_ROOT = resolve(ROOT, 'dev/local-chain/blockchain');
export const FOUNDRY_CONFIG_PATH = resolve(CONTRACT_ROOT, 'foundry.toml');
export const OUTBE_INTEX_ROOT = resolve(ROOT, 'blockchain/outbe-chain/contracts/intex');
export const LOCAL_ROOT = resolve(ROOT, '.local');
export const LOCAL_CONFIG_ROOT = resolve(LOCAL_ROOT, 'config');
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// The local dev web server (dev-local.mjs) serves the app at this fixed origin. WalletConnect
// metadata.url must match the browser origin exactly, so the generated local config uses this,
// not the committed npm start origin (127.0.0.1:4173).
export const DEV_APP_ORIGIN = 'http://127.0.0.1:5173';

const _detectLanIp = () => {
  if (process.env.ITX_LOCAL_LAN_IP) return process.env.ITX_LOCAL_LAN_IP;
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
};
export const LAN_IP = RPC_HOST === '0.0.0.0' ? _detectLanIp() : null;
export const LAN_RPC_URL = LAN_IP ? `http://${LAN_IP}:${RPC_PORT}` : null;

export const CHAIN_ID = 31337;
// WorldwideDay boundaries use UTC+14; genesis starts inside today's protocol day.
const _computeGenesis = () => {
  const now = Math.floor(Date.now() / 1000);
  const utc14Now = now + 14 * 3600;
  const todayUtc14Start = Math.floor(utc14Now / 86_400) * 86_400 - 14 * 3600;
  return todayUtc14Start;
};
export const GENESIS_TIMESTAMP = _computeGenesis();

const _computeWorldwideDay = () => {
  const utc14Epoch = GENESIS_TIMESTAMP + 14 * 3600;
  const d = new Date(utc14Epoch * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
};
export const WORLDWIDE_DAY = _computeWorldwideDay();

const _computeYesterdayDay = () => {
  const utc14Epoch = GENESIS_TIMESTAMP + 14 * 3600;
  const d = new Date(utc14Epoch * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
};
export const YESTERDAY_WORLDWIDE_DAY = _computeYesterdayDay();
export const FOUNDRY_VERSION = '1.7.1';
export const MNEMONIC = 'test test test test test test test test test test test junk';
export const OPERATOR_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// The manual tester wallet a developer connects with to exercise the app by hand. Set
// ITX_TESTER_WALLET_ADDRESS to use your own wallet; when unset it falls back to a neutral,
// publicly known Anvil account (mnemonic index 3) so the zero-config local workflow still runs.
// It is deliberately not a personal address and must not be used to configure a production profile.
const DEFAULT_TESTER_WALLET_ADDRESS = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
const configuredTesterWallet = process.env.ITX_TESTER_WALLET_ADDRESS?.trim();
export const TESTER_WALLET_ADDRESS = getAddress(
  configuredTesterWallet ? configuredTesterWallet : DEFAULT_TESTER_WALLET_ADDRESS,
);
export const TESTER_NATIVE_BALANCE = 100_000n * 10n ** 18n;
export const operatorAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
export const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
export const backgroundBidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
export const DEPLOYMENT_PATH = resolve(LOCAL_ROOT, 'deployment.json');
export const RAW_DEPLOYMENT_PATH = resolve(LOCAL_ROOT, 'deployment.raw.json');
export const ANVIL_STATE_PATH = resolve(LOCAL_ROOT, 'anvil.json');
export const ANVIL_LOG_PATH = resolve(LOCAL_ROOT, 'anvil.log');
export const SCENARIO_PATH = resolve(LOCAL_ROOT, 'scenario.json');
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export const NATIVE_UNITS_PER_PROTOCOL_UNIT = 1_000_000_000_000n;
export const BID_RATE_SCALE = 1_000_000n;

export const escrowLockNative = (quantity, promisLoadMinor, bidRate) =>
  ((BigInt(quantity) * BigInt(promisLoadMinor) * BigInt(bidRate)) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
