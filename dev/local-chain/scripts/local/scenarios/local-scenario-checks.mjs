import { resolve } from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import {
  DEPLOYMENT_PATH,
  ROOT,
  RPC_URL,
  SCENARIO_PATH,
  bidderAccount,
  backgroundBidderAccount,
} from '../infrastructure/constants.mjs';
import { readJson } from '../infrastructure/config.mjs';
import { run } from '../infrastructure/process.mjs';

const names = [
  'unrevealed-bond-waiting',
  'unrevealed-bond-claimable',
  'abandoned-commit-bond-waiting',
  'abandoned-commit-bond-claimable',
  'unfinalized-escrow-waiting',
  'unfinalized-escrow-claimable',
  'finalized-failed-split',
  'finalized-without-split',
  'finalization-no-op',
];
const claimable = new Set([
  'unrevealed-bond-claimable',
  'abandoned-commit-bond-claimable',
  'unfinalized-escrow-claimable',
]);
const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const deployment = await readJson(DEPLOYMENT_PATH);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-scenario.mjs'), 'commit-open'], {
  cwd: ROOT,
});
const cleanScenario = await readJson(SCENARIO_PATH);
assert(
  cleanScenario.schedule.commitWindowSeconds === 86_400,
  'Commit-open fixture must expose the reviewed 24-hour commit window.',
);
assert(
  cleanScenario.schedule.intexCallPeriodSeconds === 7 * 86_400,
  'Commit-open fixture must expose the expected seven-day Called deadline.',
);
assert(
  cleanScenario.previousDemand.length === 7,
  'Commit-open fixture must expose seven previous demand observations.',
);
assert(
  cleanScenario.chart.recentDays >= 31,
  'Commit-open fixture must expose at least one month of recent COEN/USD history.',
);
const expectedBalance = 200_000_000n * 10n ** 18n;
const [manualBalance, backgroundBalance] = await Promise.all([
  publicClient.readContract({
    address: deployment.wcoen,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [bidderAccount.address],
  }),
  publicClient.readContract({
    address: deployment.wcoen,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [backgroundBidderAccount.address],
  }),
]);
assert(
  manualBalance === expectedBalance && backgroundBalance === expectedBalance,
  'Clean snapshot did not restore deterministic bidder balances.',
);
const seededAt = cleanScenario.seededAt;
run(
  process.execPath,
  [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-advance.mjs'), 'commit-before-end'],
  { cwd: ROOT },
);
run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-advance.mjs'), 'commit-end'], {
  cwd: ROOT,
});
run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-scenario.mjs'), 'reveal-open'], {
  cwd: ROOT,
});
run(
  process.execPath,
  [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-advance.mjs'), 'reveal-before-end'],
  { cwd: ROOT },
);
run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-advance.mjs'), 'reveal-end'], {
  cwd: ROOT,
});

const recoveryAdvanceTargets = new Map([
  ['unrevealed-bond-waiting', 'unrevealed-bond-claimable'],
  ['abandoned-commit-bond-waiting', 'abandoned-bond-claimable'],
]);

for (const name of names) {
  run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-scenario.mjs'), name], {
    cwd: ROOT,
  });
  run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/infrastructure/local-smoke.mjs')], { cwd: ROOT });
  const scenario = await readJson(SCENARIO_PATH);

  assert(scenario.name === name, `${name}: scenario metadata name mismatch.`);
  assert(scenario.auction.toLowerCase() === deployment.intexAuction.toLowerCase(), `${name}: auction address drifted.`);
  assert(
    scenario.escrowAdapter.toLowerCase() === deployment.escrowAdapter.toLowerCase(),
    `${name}: escrow address drifted.`,
  );
  assert(scenario.paymentToken.toLowerCase() === deployment.wcoen.toLowerCase(), `${name}: payment token drifted.`);
  assert(
    scenario.deterministicAccounts.bidder.toLowerCase() === bidderAccount.address.toLowerCase(),
    `${name}: deterministic caller account drifted.`,
  );
  assert(
    scenario.deterministicAccounts.backgroundBidder.toLowerCase() === backgroundBidderAccount.address.toLowerCase(),
    `${name}: deterministic bidder account drifted.`,
  );
  assert(
    scenario.bidder.toLowerCase() !== scenario.caller.toLowerCase(),
    `${name}: permissionless caller equals bidder.`,
  );
  assert(scenario.seededAt === seededAt, `${name}: clean snapshot did not restore the baseline timestamp.`);

  if (claimable.has(name)) {
    assert(scenario.assertions.bidderPaidNotCaller === true, `${name}: permissionless payout assertion missing.`);
  }
  if (name.startsWith('abandoned-commit-bond-')) {
    assert(
      scenario.wiringEpoch.createdAuction.toLowerCase() !== scenario.wiringEpoch.currentAuction.toLowerCase(),
      `${name}: old wiring epoch was not retained.`,
    );
    assert(
      scenario.currentEscrowAuction.toLowerCase() === scenario.wiringEpoch.currentAuction.toLowerCase(),
      `${name}: current escrow wiring metadata mismatch.`,
    );
  }
  const advanceTarget = recoveryAdvanceTargets.get(name);
  if (advanceTarget) {
    run(process.execPath, [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-advance.mjs'), advanceTarget], {
      cwd: ROOT,
    });
  }
}

console.log(`Verified ${names.length} deterministic recovery scenarios.`);
