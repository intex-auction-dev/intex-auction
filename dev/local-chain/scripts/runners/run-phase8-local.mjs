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

// Own a deterministic reset until application transaction suites can share isolated Anvil snapshots.
run('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['reset']);
run('dev/local-chain/scripts/local/commands/local-scenario.mjs', ['commit-open']);

const result = spawnSync(
  process.execPath,
  [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.anvil.config.ts',
    'tests/e2e/anvil/phase8-auction-cycle-anvil.test.mts',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, ITX_PHASE8_LOCAL: '1' },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
