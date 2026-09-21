import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ANVIL_LOG_PATH,
  ANVIL_STATE_PATH,
  backgroundBidderAccount,
  bidderAccount,
  CHAIN_ID,
  DEPLOYMENT_PATH,
  FOUNDRY_CONFIG_PATH,
  FOUNDRY_VERSION,
  GENESIS_TIMESTAMP,
  LOCAL_ROOT,
  MNEMONIC,
  OPERATOR_PRIVATE_KEY,
  OUTBE_INTEX_ROOT,
  TESTER_NATIVE_BALANCE,
  TESTER_WALLET_ADDRESS,
  YESTERDAY_WORLDWIDE_DAY,
  operatorAccount,
  RAW_DEPLOYMENT_PATH,
  ROOT,
  RPC_HOST,
  RPC_PORT,
  RPC_URL,
} from './constants.mjs';
import { generateLocalConfig, readJson, writeJson } from './config.mjs';
import { findExecutable, run, spawnDetached } from './process.mjs';
import { isExpectedAnvil, isPortOpen, rpc, waitForRpc } from './rpc.mjs';

const action = process.argv[2];
if (!['up', 'down', 'reset', 'status'].includes(action)) {
  throw new Error('Usage: node dev/local-chain/scripts/local/infrastructure/local-env.mjs <up|down|reset|status>');
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readState = async () => {
  if (!existsSync(ANVIL_STATE_PATH)) return null;
  return readJson(ANVIL_STATE_PATH);
};

const stop = async () => {
  const state = await readState();
  if (!state) {
    console.log('Local Anvil is not recorded as running.');
    return;
  }
  if (state.oracleWalkPid && processAlive(state.oracleWalkPid)) {
    process.kill(state.oracleWalkPid, 'SIGTERM');
  }
  if (processAlive(state.pid) && (await isExpectedAnvil())) {
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 40 && processAlive(state.pid); i++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    if (processAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
  }
  await rm(ANVIL_STATE_PATH, { force: true });
  console.log('Local Anvil stopped.');
};

const ensureContractDependencies = () => {
  const openZeppelin = resolve(OUTBE_INTEX_ROOT, 'node_modules/@openzeppelin/contracts/package.json');
  const forgeStd = resolve(OUTBE_INTEX_ROOT, 'node_modules/forge-std/package.json');
  if (existsSync(openZeppelin) && existsSync(forgeStd)) return;
  const yarnCli = resolve(ROOT, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js');
  if (!existsSync(yarnCli)) {
    throw new Error('Root dependencies are missing. Run npm ci before local:anvil.');
  }
  run(process.execPath, [yarnCli, 'install', '--immutable'], { cwd: OUTBE_INTEX_ROOT });
};

const verifyFoundry = async (forge, anvil) => {
  const forgeVersion = run(forge, ['--version'], { capture: true });
  const anvilVersion = run(anvil, ['--version'], { capture: true });
  if (!forgeVersion.includes(`Version: ${FOUNDRY_VERSION}`) || !anvilVersion.includes(`Version: ${FOUNDRY_VERSION}`)) {
    throw new Error(`Foundry ${FOUNDRY_VERSION} is required. Found:\n${forgeVersion}\n${anvilVersion}`);
  }
};

const start = async () => {
  await mkdir(LOCAL_ROOT, { recursive: true });
  const existingState = await readState();
  if (existingState && processAlive(existingState.pid) && (await isExpectedAnvil())) {
    if (!existsSync(DEPLOYMENT_PATH)) {
      throw new Error('Anvil is running but deployment metadata is missing. Run npm run local:reset.');
    }
    run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/infrastructure/local-smoke.mjs')], {
      cwd: ROOT,
    });
    console.log('Local environment is already running.');
    return;
  }
  if (await isPortOpen()) {
    const detail = (await isExpectedAnvil()) ? 'an unrecorded Anvil process' : 'another process';
    throw new Error(`Port ${RPC_PORT} is already occupied by ${detail}. Stop it before local:anvil.`);
  }

  const forge = await findExecutable('forge');
  const anvil = await findExecutable('anvil');
  await verifyFoundry(forge, anvil);
  ensureContractDependencies();

  const logFd = openSync(ANVIL_LOG_PATH, 'a');
  // Forge broadcasts deployments in parallel; a 100M local block avoids Anvil's 30M pending-transaction stall.
  const child = spawnDetached(
    anvil,
    [
      '--host',
      RPC_HOST,
      '--port',
      String(RPC_PORT),
      '--chain-id',
      String(CHAIN_ID),
      '--gas-limit',
      '100000000',
      '--mnemonic',
      MNEMONIC,
      '--accounts',
      '10',
      '--balance',
      '100000',
      '--timestamp',
      String(GENESIS_TIMESTAMP),
      '--disable-code-size-limit',
    ],
    { cwd: ROOT, stdout: logFd, stderr: logFd },
  );
  closeSync(logFd);

  await writeJson(ANVIL_STATE_PATH, {
    pid: child.pid,
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    startedAt: new Date().toISOString(),
    operator: operatorAccount.address,
    bidder: bidderAccount.address,
    backgroundBidder: backgroundBidderAccount.address,
    foundryVersion: FOUNDRY_VERSION,
  });

  try {
    await waitForRpc();
    await rm(RAW_DEPLOYMENT_PATH, { force: true });
    run(
      forge,
      [
        'script',
        'dev/local-chain/blockchain/deploy/local/DeployLocal.s.sol:DeployLocal',
        '--root',
        ROOT,
        '--rpc-url',
        RPC_URL,
        '--broadcast',
        '--slow',
        '--non-interactive',
        '-vv',
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          FOUNDRY_CONFIG: FOUNDRY_CONFIG_PATH,
          LOCAL_OPERATOR_PRIVATE_KEY: OPERATOR_PRIVATE_KEY,
          LOCAL_BIDDER_ADDRESS: bidderAccount.address,
          LOCAL_BACKGROUND_BIDDER_ADDRESS: backgroundBidderAccount.address,
          LOCAL_TESTER_WALLET_ADDRESS: TESTER_WALLET_ADDRESS,
          LOCAL_DEPLOYMENT_PATH: RAW_DEPLOYMENT_PATH,
          LOCAL_YESTERDAY_WORLDWIDE_DAY: String(YESTERDAY_WORLDWIDE_DAY),
        },
      },
    );
    const raw = await readJson(RAW_DEPLOYMENT_PATH);
    const deployment = {
      ...raw,
      chainId: Number(raw.chainId),
      deploymentBlock: Number(raw.deploymentBlock),
      rpcUrl: RPC_URL,
      logicalProfiles: {
        origin: 'local-outbe-origin',
        venue: 'local-auction-venue',
      },
    };
    await writeJson(DEPLOYMENT_PATH, deployment);
    await generateLocalConfig(deployment);
    await rpc('anvil_setBalance', [TESTER_WALLET_ADDRESS, `0x${TESTER_NATIVE_BALANCE.toString(16)}`]);
    run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/infrastructure/local-smoke.mjs')], {
      cwd: ROOT,
    });
    const state = await readState();
    state.baselineSnapshotId = await rpc('evm_snapshot');
    await writeJson(ANVIL_STATE_PATH, state);
    console.log('Local environment is ready.');
  } catch (error) {
    if (processAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
    await rm(ANVIL_STATE_PATH, { force: true });
    throw error;
  }
};

const reset = async () => {
  const previous = existsSync(DEPLOYMENT_PATH) ? await readJson(DEPLOYMENT_PATH) : null;
  await stop();
  await rm(LOCAL_ROOT, { recursive: true, force: true });
  await start();
  if (previous) {
    const next = await readJson(DEPLOYMENT_PATH);
    const keys = [
      'bridge',
      'controller',
      'wcoen',
      'tokenBridge',
      'theCompact',
      'intexNFT1155',
      'legacyIntexAuction',
      'intexAuction',
      'escrowAdapter',
      'originRouter',
      'targetRouter',
      'intexNFT1155Bridge',
    ];
    for (const key of keys) {
      if (previous[key].toLowerCase() !== next[key].toLowerCase()) {
        throw new Error(`Reset changed deterministic address ${key}.`);
      }
    }
    console.log('Deterministic deployment addresses reproduced after reset.');
  }
};

const status = async () => {
  const state = await readState();
  const running = Boolean(state && processAlive(state.pid) && (await isExpectedAnvil()));
  console.log(JSON.stringify({ running, state }, null, 2));
  if (!running) process.exitCode = 1;
};

if (action === 'up') await start();
if (action === 'down') await stop();
if (action === 'reset') await reset();
if (action === 'status') await status();
