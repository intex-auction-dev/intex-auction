import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { MNEMONIC, ROOT } from '../local/infrastructure/constants.mjs';

const tester = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
const env = {
  ...process.env,
  ITX_TESTER_WALLET_ADDRESS: tester.address,
  ITX_LOCAL_RPC_PORT: process.env.ITX_LOCAL_RPC_PORT ?? '18546',
};
const run = (path, args = []) => {
  const result = spawnSync(process.execPath, [resolve(ROOT, path), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path} failed with exit code ${result.status}.`);
};

try {
  run('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['reset']);
  run('dev/local-chain/scripts/runners/local-control-check.mjs');
} finally {
  try {
    run('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['down']);
  } catch {
    /* Preserve the original failure. */
  }
}
