import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const run = (script, args = []) => {
  const result = spawnSync(process.execPath, [resolve(script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// One deterministic reset owns this lifecycle until local scenarios support independent snapshots.
run('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['reset']);
run('dev/local-chain/scripts/local/commands/local-scenario.mjs', ['commit-open']);
run('tests/e2e/anvil/phase12-multi-currency-anvil.mjs');
