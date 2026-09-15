import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(
  process.execPath,
  [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.anvil.config.ts',
    'tests/e2e/anvil/phase10-completion-anvil.test.mts',
  ],
  { cwd: process.cwd(), env: { ...process.env, ITX_PHASE10_LOCAL: '1' }, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
