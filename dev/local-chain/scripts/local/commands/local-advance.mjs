import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createTestClient, http } from 'viem';
import {
  CHAIN_ID,
  DEPLOYMENT_PATH,
  LOCAL_CONFIG_ROOT,
  operatorAccount,
  RPC_URL,
  SCENARIO_PATH,
} from '../infrastructure/constants.mjs';
import { readJson } from '../infrastructure/config.mjs';
import { requireAdvanceTarget, requireLocalChainId, requireScenarioSummary } from '../controls/advance-targets.mjs';
import { assertContractRevert } from '../infrastructure/revert.mjs';

const target = process.argv[2];
if (!existsSync(SCENARIO_PATH)) requireScenarioSummary(null);

const [deployment, scenario] = await Promise.all([readJson(DEPLOYMENT_PATH), readJson(SCENARIO_PATH)]);
requireScenarioSummary(scenario);
requireAdvanceTarget(scenario.name, target);

const auctionAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexAuction.json'));
const escrowAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/EscrowAdapter.json'));
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const testClient = createTestClient({ mode: 'anvil', transport: http(RPC_URL) });
requireLocalChainId(await publicClient.getChainId(), CHAIN_ID);

const worldwideDay = scenario.worldwideDay;
const bidder = scenario.bidder;

const readAuction = () =>
  publicClient.readContract({
    address: scenario.auction ?? deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [worldwideDay],
  });
const readStage = async () =>
  Number(
    await publicClient.readContract({
      address: scenario.auction ?? deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'getAuctionStage',
      args: [worldwideDay],
    }),
  );
const readBond = () =>
  publicClient.readContract({
    address: scenario.escrowAdapter ?? deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getCommitBond',
    args: [worldwideDay, bidder],
  });
const readLock = () =>
  publicClient.readContract({
    address: scenario.escrowAdapter ?? deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getBidLock',
    args: [worldwideDay, bidder],
  });
const readEscrowState = () =>
  publicClient.readContract({
    address: scenario.escrowAdapter ?? deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'auctionEscrowState',
    args: [worldwideDay],
  });
const readConstant = (address, abi, functionName) =>
  publicClient.readContract({
    address,
    abi,
    functionName,
  });

const mineAt = async (timestamp) => {
  const current = Number((await publicClient.getBlock()).timestamp);
  if (current > timestamp) {
    throw new Error(`Cannot move local time backwards from ${current} to ${timestamp}. Reseed the scenario first.`);
  }
  if (current < timestamp) {
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
    await testClient.mine({ blocks: 1 });
  }
};

const simulateAuctionBondClaim = () =>
  publicClient.simulateContract({
    account: operatorAccount,
    address: scenario.auction ?? deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'claimCommitBond',
    args: [worldwideDay, bidder],
  });
const simulateAbandonedBondClaim = () =>
  publicClient.simulateContract({
    account: operatorAccount,
    address: scenario.escrowAdapter ?? deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'claimAbandonedCommitBond',
    args: [worldwideDay, bidder],
  });
const simulateRefundClaim = () =>
  publicClient.simulateContract({
    account: operatorAccount,
    address: scenario.escrowAdapter ?? deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'claimRefund',
    args: [worldwideDay, bidder],
  });

let timestamp;
let verify;

if (
  target.startsWith('commit-') ||
  target === 'reveal' ||
  target.startsWith('reveal-') ||
  target === 'issuance' ||
  target === 'issuance-end'
) {
  const auction = await readAuction();
  const schedule = auction.schedule;
  const stageTargets = {
    'commit-before-end': [Number(schedule.commitEnd) - 1, 0],
    'commit-end': [Number(schedule.commitEnd), 1],
    reveal: [Number(schedule.commitEnd), 1],
    'reveal-before-end': [Number(schedule.revealEnd) - 1, 1],
    'reveal-end': [Number(schedule.revealEnd), 2],
    issuance: [Number(schedule.revealEnd), 2],
    'issuance-end': [Number(schedule.issuanceEnd), 2],
  };
  [timestamp, verify] = stageTargets[target];
  await mineAt(timestamp);
  const actual = await readStage();
  if (actual !== verify) throw new Error(`${target}: expected auction stage ${verify}, received ${actual}.`);
} else if (target.startsWith('unrevealed-bond-')) {
  const auction = await readAuction();
  const delay = Number(
    await readConstant(scenario.auction ?? deployment.intexAuction, auctionAbi, 'UNREVEALED_BOND_LOCK_PERIOD'),
  );
  const deadline = Number(auction.schedule.revealEnd) + delay;
  timestamp = target.endsWith('before-claimable') ? deadline - 1 : deadline;
  await mineAt(timestamp);
  if (timestamp < deadline) {
    await assertContractRevert(simulateAuctionBondClaim, 'CommitBondNotYetClaimable', [deadline, timestamp]);
  } else {
    await simulateAuctionBondClaim();
  }
} else if (target.startsWith('abandoned-bond-')) {
  const bond = await readBond();
  if (bond.amount === 0n) throw new Error('The seeded scenario has no live commit bond.');
  const delay = Number(
    await readConstant(scenario.escrowAdapter ?? deployment.escrowAdapter, escrowAbi, 'COMMIT_BOND_ABANDON_DELAY'),
  );
  const deadline = Number(bond.lockedAt) + delay;
  timestamp = target.endsWith('before-claimable') ? deadline - 1 : deadline;
  await mineAt(timestamp);
  if (timestamp < deadline) {
    await assertContractRevert(simulateAbandonedBondClaim, 'CommitBondNotYetAbandoned', [deadline, timestamp]);
  } else {
    await simulateAbandonedBondClaim();
  }
} else {
  const [lock, state] = await Promise.all([readLock(), readEscrowState()]);
  if (Number(lock.status) !== 1) throw new Error('The seeded scenario has no active bidder lock.');

  let deadline;
  let beforeError = 'RefundNotYetClaimable';
  let beforeArgs;
  if (target.startsWith('unfinalized-refund-')) {
    const delay = Number(
      await readConstant(scenario.escrowAdapter ?? deployment.escrowAdapter, escrowAbi, 'UNFINALIZED_REFUND_DELAY'),
    );
    deadline = Number(lock.lockedAt) + delay;
  } else if (target.startsWith('failed-split-')) {
    const delay = Number(
      await readConstant(scenario.escrowAdapter ?? deployment.escrowAdapter, escrowAbi, 'POST_FINALIZE_REFUND_DELAY'),
    );
    deadline = Number(state[2]) + delay;
  } else {
    const delay = Number(
      await readConstant(scenario.escrowAdapter ?? deployment.escrowAdapter, escrowAbi, 'NO_SPLIT_REFUND_DELAY'),
    );
    deadline = Number(state[2]) + delay;
    beforeError = 'SplitNotRecorded';
    beforeArgs = [worldwideDay, bidder];
  }

  timestamp = target.endsWith('before-claimable') ? deadline - 1 : deadline;
  await mineAt(timestamp);
  if (timestamp < deadline) {
    await assertContractRevert(simulateRefundClaim, beforeError, beforeArgs ?? [deadline, timestamp]);
  } else {
    await simulateRefundClaim();
  }
}

console.log(`Advanced ${scenario.name} to ${target} at ${timestamp}.`);
