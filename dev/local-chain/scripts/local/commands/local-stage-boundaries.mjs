import { resolve } from 'node:path';
import { createPublicClient, createTestClient, http } from 'viem';
import { DEPLOYMENT_PATH, LOCAL_CONFIG_ROOT, RPC_URL, SCENARIO_PATH } from '../infrastructure/constants.mjs';
import { readJson } from '../infrastructure/config.mjs';

const deployment = await readJson(DEPLOYMENT_PATH);
const scenario = await readJson(SCENARIO_PATH);
if (scenario.name !== 'commit-open') {
  throw new Error('Run npm run local:seed -- commit-open before boundary verification.');
}

const auctionAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexAuction.json'));
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const testClient = createTestClient({ mode: 'anvil', transport: http(RPC_URL) });

const readStage = async () =>
  Number(
    await publicClient.readContract({
      address: deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'getAuctionStage',
      args: [scenario.worldwideDay],
    }),
  );

const check = async (timestamp, expectedStage, label) => {
  await testClient.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  await testClient.mine({ blocks: 1 });
  const actualStage = await readStage();
  if (actualStage !== expectedStage) {
    throw new Error(`${label}: expected stage ${expectedStage}, received ${actualStage}.`);
  }
};

await check(scenario.schedule.commitEnd - 1, 0, 'immediately before commitEnd');
await check(scenario.schedule.commitEnd, 1, 'exactly at commitEnd');
await check(scenario.schedule.commitEnd + 1, 1, 'immediately after commitEnd');
await check(scenario.schedule.revealEnd - 1, 1, 'immediately before revealEnd');
await check(scenario.schedule.revealEnd, 2, 'exactly at revealEnd');
await check(scenario.schedule.revealEnd + 1, 2, 'immediately after revealEnd');

console.log(`Verified contract stages at commitEnd and revealEnd boundaries for ${scenario.worldwideDay}.`);
