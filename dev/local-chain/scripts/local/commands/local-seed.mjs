import { spawnSync } from 'node:child_process';
import { ROOT } from '../infrastructure/constants.mjs';

const args = process.argv.slice(2);
const scenario = spawnSync(process.execPath, ['dev/local-chain/scripts/local/commands/local-scenario.mjs', ...args], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (scenario.error) throw scenario.error;
if (scenario.status !== 0) process.exit(scenario.status ?? 1);
if (args[0] === '--list') process.exit(0);
