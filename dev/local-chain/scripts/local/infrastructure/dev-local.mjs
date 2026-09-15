import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, DEPLOYMENT_PATH, SCENARIO_PATH } from './constants.mjs';
import { run } from './process.mjs';

if (!existsSync(DEPLOYMENT_PATH)) {
  throw new Error('Local deployment is missing. Run npm run local:anvil first.');
}
if (!existsSync(SCENARIO_PATH)) {
  run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-scenario.mjs'), 'commit-open'], {
    cwd: ROOT,
  });
}
run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/infrastructure/local-smoke.mjs')], { cwd: ROOT });
const viteBin = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ITX_RUNTIME_CONFIG_DIR: resolve(ROOT, '.local/config'),
    ITX_LOCAL_DEV: '1',
  },
  stdio: 'inherit',
  shell: false,
});
console.log(`Auction: http://127.0.0.1:5173/auction/${JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')).worldwideDay}`);
console.log('Dev controls: http://127.0.0.1:5173/dev');
const parentPid = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== parentPid) child.kill('SIGTERM');
}, 500);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  clearInterval(parentWatch);
  if (signal && process.platform !== 'win32') process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
