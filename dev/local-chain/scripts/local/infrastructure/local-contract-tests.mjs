import { resolve } from 'node:path';
import { FOUNDRY_CONFIG_PATH, FOUNDRY_VERSION, OUTBE_INTEX_ROOT, ROOT } from './constants.mjs';
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
// forge runs with the repo root as project root (via --root/FOUNDRY_CONFIG) so upstream submodule
// sources resolve as in-project paths; see the foundry.toml header. Match paths are therefore
// repo-root-relative.
const forgeEnv = { ...process.env, FOUNDRY_CONFIG: FOUNDRY_CONFIG_PATH };
for (const testPath of [
  'dev/local-chain/blockchain/test/foundry/deploy/LocalDeployment.t.sol',
  'dev/local-chain/blockchain/test/foundry/deploy/LocalProtocolControllerV2.t.sol',
  'dev/local-chain/blockchain/test/foundry/cross-chain/LocalLoopback.t.sol',
]) {
  run(forge, ['test', '--root', ROOT, '--match-path', testPath, '-vv'], { cwd: ROOT, env: forgeEnv });
}
