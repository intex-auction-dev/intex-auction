import { resolve } from 'node:path';
import { CONTRACT_ROOT, FOUNDRY_VERSION, OUTBE_INTEX_ROOT, ROOT } from './constants.mjs';
import { findExecutable, run } from './process.mjs';

const forge = await findExecutable('forge');
const version = run(forge, ['--version'], { capture: true });
if (!version.includes(`Version: ${FOUNDRY_VERSION}`)) {
  throw new Error(`Foundry ${FOUNDRY_VERSION} is required.`);
}
const yarnCli = resolve(ROOT, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js');
run(process.execPath, [yarnCli, 'install', '--immutable'], { cwd: OUTBE_INTEX_ROOT });

// Required app CI runs only the application-owned local profile and loopback harness tests;
// run the upstream protocol suite when updating the contract snapshot.
for (const testPath of [
  'test/foundry/deploy/LocalDeployment.t.sol',
  'test/foundry/deploy/LocalProtocolControllerV2.t.sol',
  'test/foundry/cross-chain/LocalLoopback.t.sol',
]) {
  run(forge, ['test', '--match-path', testPath, '-vv'], { cwd: CONTRACT_ROOT });
}
