import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  zeroHash,
} from 'viem';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import {
  ANVIL_STATE_PATH,
  backgroundBidderAccount,
  bidderAccount,
  CHAIN_ID,
  DEPLOYMENT_PATH,
  escrowLockNative,
  LOCAL_CONFIG_ROOT,
  MNEMONIC,
  operatorAccount,
  RPC_URL,
  SCENARIO_PATH,
  WORLDWIDE_DAY,
} from '../infrastructure/constants.mjs';
import { readJson, writeJson } from '../infrastructure/config.mjs';
import { rpc } from '../infrastructure/rpc.mjs';
import { boundaryTriplet, requireLocalChainId } from '../controls/advance-targets.mjs';
import { assertContractRevert } from '../infrastructure/revert.mjs';
import { requireScenarioName, scenarioNames } from '../scenarios/scenario-names.mjs';
import { writeScenarioAfterAssertions } from '../scenarios/scenario-runner.mjs';
const WWD_COMPLETED = 6;
const WWD_FAILED = 7;
const DAY_UNKNOWN = 0;
const DAY_GREEN = 1;
const DAY_RED = 2;
const GLOBAL_STARTED = 2;
const GLOBAL_REVEALING = 3;
const GLOBAL_CLEARING = 4;
const GLOBAL_CLEARED = 5;
const GLOBAL_CANCELLED = 6;
const TARGET_COMMIT = 0;
const TARGET_REVEAL = 1;
const TARGET_ISSUANCE = 2;
const TARGET_COMPLETED = 3;
const TARGET_CANCELLED = 4;
const PROMIS_SCALE = 1_000_000n;
const PRICE_SCALE = 1_000_000n;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const PROMIS_LOAD = 100_000n * PROMIS_SCALE;
const MIN_BID_RATE = 50_000;
const BID_RATE = 80_000;
const COMMIT_BOND = 100_000_000n * 10n ** 18n;
const RATE_SCALE = 1_000_000n;
const DAY_SECONDS = 86_400;
const UTC14_OFFSET_SECONDS = 14 * 3_600;
const INTEX_CALL_PERIOD_SECONDS = 7 * DAY_SECONDS;
const ORACLE_RETENTION_DAYS = 365;
const ORACLE_QUOTE = '0xUSD';
const ORACLE_QUOTE_ISO = 840;
const ORACLE_COEN = getAddress('0x0000000000000000000000000000000000000000');
const oracleQuoteToken = (isoCode) =>
  getAddress(
    `0x${keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'uint16' }], ['itx-acn.local.quote', isoCode]),
    ).slice(26)}`,
  );
const ENTRY_PRICE = PRICE_SCALE;
const FLOOR_PRICE = (PRICE_SCALE * 108n) / 100n;
const CALL_PRICE = (PRICE_SCALE * 228n) / 100n;
const ORACLE_HISTORY_DAYS = 90;
// Keep fixture density low; seed baseline history if sub-hour data becomes necessary.
const ORACLE_INTRADAY_POINTS = 5;
const ORACLE_INTRADAY_INTERVAL_SECONDS = 4 * 3_600;
const ORACLE_HISTORY_POINTS = ORACLE_HISTORY_DAYS + ORACLE_INTRADAY_POINTS;
const PREVIOUS_DEMAND_FIXTURES = [
  {
    daysAgo: 7,
    issued: 12,
    demand: 18,
    rate: 720_000,
    bids: [
      { quantity: 5, bidRate: 780_000 },
      { quantity: 4, bidRate: 740_000 },
      { quantity: 3, bidRate: 700_000 },
    ],
  },
  {
    daysAgo: 6,
    issued: 18,
    demand: 27,
    rate: 760_000,
    bids: [
      { quantity: 6, bidRate: 820_000 },
      { quantity: 5, bidRate: 780_000 },
      { quantity: 4, bidRate: 750_000 },
      { quantity: 3, bidRate: 720_000 },
    ],
  },
  {
    daysAgo: 5,
    issued: 9,
    demand: 9,
    rate: 690_000,
    bids: [
      { quantity: 4, bidRate: 730_000 },
      { quantity: 3, bidRate: 700_000 },
      { quantity: 2, bidRate: 680_000 },
    ],
  },
  { daysAgo: 4, red: true },
  {
    daysAgo: 3,
    issued: 24,
    demand: 35,
    rate: 810_000,
    bids: [
      { quantity: 7, bidRate: 870_000 },
      { quantity: 6, bidRate: 840_000 },
      { quantity: 5, bidRate: 810_000 },
      { quantity: 4, bidRate: 790_000 },
      { quantity: 2, bidRate: 760_000 },
    ],
  },
  {
    daysAgo: 2,
    issued: 16,
    demand: 22,
    rate: 740_000,
    bids: [
      { quantity: 6, bidRate: 790_000 },
      { quantity: 5, bidRate: 760_000 },
      { quantity: 3, bidRate: 730_000 },
      { quantity: 2, bidRate: 710_000 },
    ],
  },
  {
    daysAgo: 1,
    issued: 28,
    demand: 41,
    rate: 835_000,
    bids: [
      { quantity: 8, bidRate: 890_000 },
      { quantity: 7, bidRate: 860_000 },
      { quantity: 6, bidRate: 840_000 },
      { quantity: 4, bidRate: 820_000 },
      { quantity: 3, bidRate: 800_000 },
    ],
  },
];

const requested = process.argv[2];
if (requested === '--list') {
  console.log(scenarioNames.join('\n'));
  process.exit(0);
}
requireScenarioName(requested);

const deployment = await readJson(DEPLOYMENT_PATH);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const operatorWallet = createWalletClient({ account: operatorAccount, transport: http(RPC_URL) });
const bidderWallet = createWalletClient({ account: bidderAccount, transport: http(RPC_URL) });
const backgroundBidderWallet = createWalletClient({ account: backgroundBidderAccount, transport: http(RPC_URL) });

const controllerAbi = parseAbi([
  'function setWorldwideDay(uint32 worldwideDay, (uint8 status,uint8 dayType,uint64 formingStart,uint64 formingEnd,uint64 lookbackEnd,uint64 offeringEnd,uint64 scheduledProcessTime,uint256 previousVwap,uint256 currentVwap,bool exists) record)',
  'function getWorldwideDay(uint32 worldwideDay) view returns (uint8 status,uint8 dayType,uint64 formingStart,uint64 formingEnd,uint64 lookbackEnd,uint64 offeringEnd,uint64 scheduledProcessTime,uint256 previousVwap,uint256 currentVwap)',
  'function cleanWorldwideDay(uint32 worldwideDay)',
  'function setOracleFixture(address base,address quote,uint16 isoCode,uint256 rate,uint256 vwap,uint64 timestamp)',
  'function setOracleFailure(bool unavailable)',
  'function getExchangeRate(address base,address quote) view returns (uint256 rate)',
  'function getExchangeRateData(address base,address quote) view returns (uint256 rate,uint64 lastBlock,uint64 lastTimestamp)',
  'function getPriceSnapshotHistory(address base,address quote,uint32 count) view returns (uint64[] timestamps,uint256[] rates,uint256[] volumes)',
  'function getReferenceCurrencies() view returns (uint16[] isoCodes)',
  'function getCoenExchangeRateFor(uint16 isoCode) view returns (uint256 rate)',
  'function startAuction((uint32 worldwideDay,uint32 commitEnd,uint32 revealEnd,uint32 issuanceEnd,uint128 promisLoadMinor,uint32 minIntexBidRate,(uint16 isoCode,uint64 entryPriceMinor,uint64 floorPriceMinor,uint64 callPriceMinor)[] prices,uint32 callNoticePeriod,uint32 callWindow,uint32 callThreshold,uint16 minIntexBidQuantity,uint128 commitBondMinor,uint8 dayState) params)',
  'function startClearing(uint32 worldwideDay)',
  'function postAuctionResult(uint32 dstChainId,uint32 worldwideDay,uint32 issuedIntexCount,uint64 auctionClearingRate,uint32 wonBidsCount)',
  'function postRefundInstructions(uint32 dstChainId,uint32 worldwideDay,uint16 chunkIndex,uint16 totalChunks,address[] bidderAddresses,uint128[] refundedAmounts,uint128[] paidAmounts)',
  'function postIssuanceInstructions(uint32 dstChainId,(bytes14 seriesId,uint32 worldwideDay,uint32 issuedAt,uint32 issuedUnits,uint128 promisLoadMinor,uint64 entryPriceMinor,uint64 floorPriceMinor,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 callWindow,uint32 callThreshold,uint64 callPriceMinor,address[] recipients,uint256[] quantities)[] series)',
  'function setGlobalAuctionStage(uint32 worldwideDay,uint8 stage)',
  'function getAuctionStage(uint32 worldwideDay) view returns (uint8)',
  'function getBidsCount(uint32 worldwideDay) view returns (uint256)',
  'function getChainBidsCount(uint32 worldwideDay,uint32 srcChainId) view returns (uint256)',
  'function isChainDone(uint32 worldwideDay,uint32 srcChainId) view returns (bool)',
  'function isChainSkipped(uint32 worldwideDay,uint32 srcChainId) view returns (bool)',
  'function markChainSkipped(uint32 worldwideDay,uint32 srcChainId)',
  'function recordGlobalClearing(uint32 worldwideDay,uint32 issuedIntexCount,uint32 clearingRate,uint64 totalDemand,uint256 unusedPromis,bool reportUnused)',
  'function setSeries((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits) data)',
  'function seriesExists(bytes14 seriesId) view returns (bool)',
  'function seriesData(bytes14 seriesId) view returns ((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits))',
  'function setWorldwideDayTerminalReceipt(uint32 worldwideDay,(uint8 outcome,uint256 valueRouted,uint256 carryOverBefore,uint256 carryOverAfter,uint8 retirementOutcome,uint64 blockNumber,bool exists) receipt)',
  'function getWorldwideDayTerminalReceipt(uint32 worldwideDay) view returns (uint8 outcome,uint256 valueRouted,uint256 carryOverBefore,uint256 carryOverAfter,uint8 retirementOutcome,uint64 blockNumber)',
]);
const bridgeAbi = parseAbi([
  'function setFee(uint256 fee)',
  'function setAutoDeliver(bool on)',
  'function fee() view returns (uint256)',
  'function autoDeliver() view returns (bool)',
  'function lastPayload() view returns (bytes)',
]);
const originWriteAbi = parseAbi(['function resendParkedMessage(uint256 idx)']);
const originReadAbi = parseAbi([
  'function parkedMessage(uint256 idx) view returns ((uint32 dstChainId,uint64 gasLimit,bool sent,bytes payload))',
  'function targetsOf(uint32 worldwideDay) view returns (uint32[])',
]);
const targetExtraAbi = parseAbi([
  'function bidsRelay(uint32 worldwideDay) view returns (uint16 nextBatch,uint16 totalBatches,bool done)',
  'function nextPendingBidsRelayIdx() view returns (uint256)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);
const compactAbi = parseAbi(['function setForcedWithdrawalShouldFail(bool shouldFail)']);
const auctionAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexAuction.json'));
const escrowAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/EscrowAdapter.json'));
const nftAbi = await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexNFT1155.json'));

const auctionClearedEvent = parseAbiItem(
  'event AuctionCleared(uint32 indexed worldwideDay,uint32 issuedUnits,uint32 clearingRate,uint64 totalDemand)',
);
const auctionClearedEmptyEvent = parseAbiItem(
  'event AuctionClearedEmpty(uint32 indexed worldwideDay,uint64 totalDemand)',
);
const unusedSupplyEvent = parseAbiItem('event UnusedSupplyReported(uint32 indexed worldwideDay,uint256 unusedPromis)');
const chainSkippedEvent = parseAbiItem('event ChainSkipped(uint32 indexed worldwideDay,uint32 indexed srcChainId)');
const sendParkedEvent = parseAbiItem(
  'event MessageParked(uint256 indexed idx,uint32 indexed dstChainId,uint8 msgType)',
);
const pendingSendFlushedEvent = parseAbiItem(
  'event ParkedMessageResent(uint256 indexed idx,uint32 indexed dstChainId,bytes32 sendId)',
);
const auctionResultReceivedEvent = parseAbiItem(
  'event AuctionResultReceived(uint32 indexed srcChainId,uint32 indexed worldwideDay,uint32 issuedUnits,uint64 clearingRate)',
);
const refundReceivedEvent = parseAbiItem(
  'event RefundInstructionsReceived(uint32 indexed srcChainId,uint32 indexed worldwideDay,uint256 instructionsCount)',
);
const bidRevealedEvent = parseAbiItem(
  'event BidRevealed(uint32 indexed worldwideDay,address indexed bidder,uint16 indexed quantity,uint32 bidRate,uint16 issuanceCurrency,uint16 referenceCurrency)',
);
const worldwideDayCleanedUpEvent = parseAbiItem(
  'event WorldwideDayCleanedUp(uint32 indexed worldwideDay,uint8 finalStatus)',
);

const bidderRefundFailedEvent = parseAbiItem(
  'event BidderRefundFailed(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,bytes reason)',
);
const auctionEscrowFinalizedEvent = parseAbiItem(
  'event AuctionEscrowFinalized(bytes32 indexed receiveId,uint32 indexed worldwideDay,uint128 totalRefunded,uint128 totalPaid,uint32 bidsProcessed)',
);
const finalizationNoOpEvent = parseAbiItem('event FinalizationNoOp(uint32 indexed worldwideDay,uint32 bidsProcessed)');
const fundsRefundedEvent = parseAbiItem(
  'event FundsRefunded(bytes32 indexed receiveId,uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
);
const proceedsBurnedEvent = parseAbiItem(
  'event ProceedsBurned(uint32 indexed worldwideDay,address indexed bidder,uint128 amount)',
);
const wiredEvent = parseAbiItem(
  'event Wired(address indexed intexAuctionOld,address indexed intexAuctionNew,address compactOld,address compactNew,address paymentTokenOld,address paymentTokenNew)',
);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const tx = async (wallet, address, abi, functionName, args = [], value) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 100 });
  assert(receipt.status === 'success', `${functionName} transaction reverted.`);
  return receipt;
};

const sameTransactionLogs = async (receipt, address, event, args = undefined) => {
  const logs = await publicClient.getLogs({
    address,
    event,
    args,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  return logs.filter((log) => log.transactionHash === receipt.transactionHash);
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopOracleWalk = async () => {
  const state = await readJson(ANVIL_STATE_PATH);
  if (state.oracleWalkPid && processAlive(state.oracleWalkPid)) {
    process.kill(state.oracleWalkPid, 'SIGTERM');
    for (let i = 0; i < 20 && processAlive(state.oracleWalkPid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
};

const restoreBaseline = async () => {
  const state = await readJson(ANVIL_STATE_PATH);
  if (!state.baselineSnapshotId) {
    throw new Error('Local baseline snapshot is missing. Run npm run local:reset.');
  }
  const reverted = await rpc('evm_revert', [state.baselineSnapshotId]);
  assert(reverted === true, 'Failed to restore the deterministic local baseline.');
  state.baselineSnapshotId = await rpc('evm_snapshot');
  await writeJson(ANVIL_STATE_PATH, state);
};

const mineAt = async (timestamp) => {
  const current = Number((await publicClient.getBlock()).timestamp);
  if (current > timestamp) throw new Error(`Cannot move local time backwards from ${current} to ${timestamp}.`);
  if (current === timestamp) return;
  await rpc('evm_setNextBlockTimestamp', [`0x${timestamp.toString(16)}`]);
  await rpc('evm_mine');
};

const withSnapshot = async (action) => {
  const snapshotId = await rpc('evm_snapshot');
  try {
    return await action();
  } finally {
    assert((await rpc('evm_revert', [snapshotId])) === true, 'Failed to restore boundary-check snapshot.');
  }
};

const assertDeadlineBoundary = async ({ deadline, before, exact, after }) => {
  const timestamps = boundaryTriplet(deadline);
  await withSnapshot(async () => {
    await mineAt(timestamps.before);
    await before(timestamps.before);
  });
  await withSnapshot(async () => {
    await mineAt(timestamps.exact);
    await exact(timestamps.exact);
  });
  await withSnapshot(async () => {
    await mineAt(timestamps.after);
    await after(timestamps.after);
  });
  return timestamps;
};

const readAuctionInfo = () =>
  publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [WORLDWIDE_DAY],
  });

const readCommitBond = (bidder) =>
  publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getCommitBond',
    args: [WORLDWIDE_DAY, bidder],
  });

const readBidLock = (bidder) =>
  publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getBidLock',
    args: [WORLDWIDE_DAY, bidder],
  });

const readEscrowState = () =>
  publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'auctionEscrowState',
    args: [WORLDWIDE_DAY],
  });

const readAuctionStatus = () =>
  publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getAuctionStatus',
    args: [WORLDWIDE_DAY],
  });

const readTokenBalance = (account) =>
  publicClient.readContract({
    address: deployment.wcoen,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });

const readConstant = (address, abi, functionName) =>
  publicClient.readContract({
    address,
    abi,
    functionName,
  });

const simulateAuctionBondClaim = (bidder) =>
  publicClient.simulateContract({
    account: bidderAccount,
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'claimCommitBond',
    args: [WORLDWIDE_DAY, bidder],
  });

const simulateAbandonedBondClaim = (bidder) =>
  publicClient.simulateContract({
    account: bidderAccount,
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'claimAbandonedCommitBond',
    args: [WORLDWIDE_DAY, bidder],
  });

const simulateRefundClaim = (bidder) =>
  publicClient.simulateContract({
    account: bidderAccount,
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'claimRefund',
    args: [WORLDWIDE_DAY, bidder],
  });

const executeBondClaim = async ({ bidder, functionName, expectedAmount }) => {
  const bidderBefore = await readTokenBalance(bidder);
  const callerBefore = await readTokenBalance(bidderAccount.address);
  const receipt = await tx(
    bidderWallet,
    functionName === 'claimCommitBond' ? deployment.intexAuction : deployment.escrowAdapter,
    functionName === 'claimCommitBond' ? auctionAbi : escrowAbi,
    functionName,
    [WORLDWIDE_DAY, bidder],
  );
  const [bidderAfter, callerAfter, bondAfter] = await Promise.all([
    readTokenBalance(bidder),
    readTokenBalance(bidderAccount.address),
    readCommitBond(bidder),
  ]);
  assert(bidderAfter - bidderBefore === expectedAmount, `${functionName} did not pay the exact bond to the bidder.`);
  assert(callerAfter === callerBefore, `${functionName} paid the permissionless caller.`);
  assert(bondAfter.amount === 0n, `${functionName} did not clear the bidder bond.`);
  return receipt;
};

const executeRefundClaim = async ({ bidder, expectedReturned, expectedBurned }) => {
  const burnAddress = await readConstant(deployment.escrowAdapter, escrowAbi, 'BURN_ADDRESS');
  const [bidderBefore, callerBefore, burnBefore] = await Promise.all([
    readTokenBalance(bidder),
    readTokenBalance(bidderAccount.address),
    readTokenBalance(burnAddress),
  ]);
  const receipt = await tx(bidderWallet, deployment.escrowAdapter, escrowAbi, 'claimRefund', [WORLDWIDE_DAY, bidder]);
  const [bidderAfter, callerAfter, burnAfter, lockAfter, statusAfter] = await Promise.all([
    readTokenBalance(bidder),
    readTokenBalance(bidderAccount.address),
    readTokenBalance(burnAddress),
    readBidLock(bidder),
    readAuctionStatus(),
  ]);
  assert(bidderAfter - bidderBefore === expectedReturned, 'claimRefund did not return the exact bidder amount.');
  assert(callerAfter === callerBefore, 'claimRefund paid the permissionless caller.');
  assert(burnAfter - burnBefore === expectedBurned, 'claimRefund did not burn the exact remainder.');
  assert(Number(lockAfter.status) === 2, 'claimRefund did not reconcile the bidder lock to Finalized.');
  assert(statusAfter[2] === 0n, 'claimRefund left bidder principal in aggregate escrow accounting.');

  const refundedLogs = await sameTransactionLogs(receipt, deployment.escrowAdapter, fundsRefundedEvent, {
    worldwideDay: WORLDWIDE_DAY,
    bidder,
  });
  const burnedLogs = await sameTransactionLogs(receipt, deployment.escrowAdapter, proceedsBurnedEvent, {
    worldwideDay: WORLDWIDE_DAY,
    bidder,
  });
  assert(
    refundedLogs.reduce((total, log) => total + log.args.amount, 0n) === expectedReturned,
    'FundsRefunded evidence does not match the returned amount.',
  );
  assert(
    burnedLogs.reduce((total, log) => total + log.args.amount, 0n) === expectedBurned,
    'ProceedsBurned evidence does not match the burned amount.',
  );
  return receipt;
};

const readTargetStage = async (worldwideDay = WORLDWIDE_DAY) =>
  Number(
    await publicClient.readContract({
      address: deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'getAuctionStage',
      args: [worldwideDay],
    }),
  );

const targetAuctionExists = async (worldwideDay = WORLDWIDE_DAY) => {
  try {
    await readTargetStage(worldwideDay);
    return true;
  } catch {
    return false;
  }
};

const readGlobalStage = async (worldwideDay = WORLDWIDE_DAY) =>
  Number(
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getAuctionStage',
      args: [worldwideDay],
    }),
  );

const seedWorldwideDay = async (seededAt, status = WWD_COMPLETED, dayType = DAY_GREEN, worldwideDay = WORLDWIDE_DAY) =>
  tx(operatorWallet, deployment.controller, controllerAbi, 'setWorldwideDay', [
    worldwideDay,
    {
      status,
      dayType,
      formingStart: BigInt(seededAt - 10_800),
      formingEnd: BigInt(seededAt - 7_200),
      lookbackEnd: BigInt(seededAt - 3_600),
      offeringEnd: BigInt(seededAt - 1_800),
      scheduledProcessTime: BigInt(seededAt - 900),
      previousVwap: 990_000_000_000_000_000n,
      currentVwap: 995_000_000_000_000_000n,
      exists: true,
    },
  ]);

// Deterministic pseudo-random local price walk; replace with imported Oracle history when market-calibrated fixtures are required.
const deterministicOracleRate = (pointIndex) => {
  const state = (Math.imul(pointIndex + 1, 1_664_525) + 1_013_904_223) >>> 0;
  const variationBasisPoints = (state % 601) - 300;
  const BASE_RATE = 1_200_000_000_000_000_000n;
  return (BASE_RATE * BigInt(10_000 + variationBasisPoints)) / 10_000n;
};

const seedOracleHistory = async () => {
  const current = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getExchangeRateData',
    args: [ORACLE_COEN, oracleQuoteToken(ORACLE_QUOTE_ISO)],
  });
  const oracleNow = Number(current[2]);
  const recentFixtures = [
    ...Array.from({ length: ORACLE_HISTORY_DAYS }, (_, index) => index * DAY_SECONDS),
    ...Array.from({ length: ORACLE_INTRADAY_POINTS }, (_, index) => (index + 1) * ORACLE_INTRADAY_INTERVAL_SECONDS),
  ]
    .sort((left, right) => right - left)
    .map((secondsAgo, index) => {
      const rate = deterministicOracleRate(index);
      return { timestamp: oracleNow - secondsAgo, rate, vwap: rate };
    });
  const fixtures = [
    {
      timestamp: oracleNow - (ORACLE_RETENTION_DAYS + 1) * DAY_SECONDS,
      rate: 880_000_000_000_000_000n,
      vwap: 875_000_000_000_000_000n,
    },
    {
      timestamp: oracleNow - ORACLE_RETENTION_DAYS * DAY_SECONDS,
      rate: 900_000_000_000_000_000n,
      vwap: 895_000_000_000_000_000n,
    },
    ...recentFixtures,
  ];
  for (const fixture of fixtures) {
    await tx(operatorWallet, deployment.controller, controllerAbi, 'setOracleFixture', [
      ORACLE_COEN,
      oracleQuoteToken(ORACLE_QUOTE_ISO),
      ORACLE_QUOTE_ISO,
      fixture.rate,
      fixture.vwap,
      BigInt(fixture.timestamp),
    ]);
  }

  const history = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getPriceSnapshotHistory',
    args: [ORACLE_COEN, oracleQuoteToken(ORACLE_QUOTE_ISO), ORACLE_HISTORY_POINTS],
  });
  const timestamps = history[0].map(Number);
  const rawRates = history[1];
  const rates = rawRates.map((rate) => rate.toString());
  const expectedTimestamps = recentFixtures.map((fixture) => fixture.timestamp).toReversed();
  assert(
    timestamps.length === expectedTimestamps.length &&
      timestamps.every((timestamp, index) => timestamp === expectedTimestamps[index]),
    `Oracle history is not ${ORACLE_HISTORY_POINTS}-point, newest-first and retention-bounded: got ${timestamps.length} points.`,
  );
  assert(
    rawRates.every((rate) => rate >= 1_164_000_000_000_000_000n && rate <= 1_236_000_000_000_000_000n),
    'Recent COEN/USD fixtures must fluctuate within 3% of $1.20.',
  );
  const retained = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getPriceSnapshotHistory',
    args: [ORACLE_COEN, oracleQuoteToken(ORACLE_QUOTE_ISO), ORACLE_HISTORY_POINTS + 1],
  });
  assert(
    retained[0].length === ORACLE_HISTORY_POINTS + 1 &&
      Number(retained[0].at(-1)) === oracleNow - ORACLE_RETENTION_DAYS * DAY_SECONDS,
    'Oracle retention boundary fixture was not retained outside the chart-point UI window.',
  );
  const limited = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getPriceSnapshotHistory',
    args: [ORACLE_COEN, oracleQuoteToken(ORACLE_QUOTE_ISO), 2],
  });
  assert(
    limited[0].length === 2 && Number(limited[0][0]) === oracleNow,
    'Oracle history count did not bound the newest-first result.',
  );

  return {
    pair: { base: 'COEN', quote: ORACLE_QUOTE, pairId: 1 },
    retentionDays: ORACLE_RETENTION_DAYS,
    recentDays: ORACLE_HISTORY_DAYS,
    recentPoints: ORACLE_HISTORY_POINTS,
    contractNewestFirst: timestamps.map((timestamp, index) => ({ timestamp, rate: rates[index] })),
    uiChronological: timestamps.toReversed().map((timestamp, index) => ({
      timestamp,
      rate: rates[rates.length - 1 - index],
    })),
  };
};

const shiftWorldwideDay = (worldwideDay, dayOffset) => {
  const value = String(worldwideDay);
  const date = new Date(
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)) + dayOffset),
  );
  return Number(
    [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join(''),
  );
};

const seedPreviousDemandHistory = async (seededAt) => {
  const seeded = [];
  let slotBase = 0;
  for (const fixture of PREVIOUS_DEMAND_FIXTURES) {
    const worldwideDay = shiftWorldwideDay(WORLDWIDE_DAY, -fixture.daysAgo);
    seeded.push(await seedPastDay(worldwideDay, seededAt - fixture.daysAgo * DAY_SECONDS, fixture, slotBase));
    slotBase += (fixture.bids ?? []).length;
  }
  assert(
    seeded.length === 7 && seeded.at(-1)?.worldwideDay === shiftWorldwideDay(WORLDWIDE_DAY, -1),
    'Previous-demand fixture must cover the seven WorldwideDays immediately before the active auction.',
  );
  return seeded;
};

const nextUtc14Midnight = (afterEpochSeconds) => {
  const utcDayStart = Math.floor(afterEpochSeconds / DAY_SECONDS) * DAY_SECONDS;
  const boundary = utcDayStart + (DAY_SECONDS - UTC14_OFFSET_SECONDS);
  return boundary >= afterEpochSeconds ? boundary : boundary + DAY_SECONDS;
};

const auctionParams = (seededAt, { dayState = DAY_GREEN, longWindow = false } = {}, worldwideDay = WORLDWIDE_DAY) => {
  const step = longWindow ? 86_400 : 100;
  const referenceRateCentis = [
    [840, 100n],
    [978, 92n],
    [826, 79n],
    [156, 725n],
    [392, 15_700n],
    [344, 783n],
  ];
  const prices = referenceRateCentis.map(([isoCode, centis]) => ({
    isoCode,
    entryPriceMinor: (centis * PRICE_SCALE) / 100n,
    floorPriceMinor: (centis * FLOOR_PRICE) / 100n,
    callPriceMinor: (centis * CALL_PRICE) / 100n,
  }));
  for (const row of prices) {
    for (const field of ['entryPriceMinor', 'floorPriceMinor', 'callPriceMinor']) {
      assert(
        row[field] > 0n && row[field] <= UINT64_MAX,
        `Reference price ${field} for ISO ${row.isoCode} must fit the uint64 contract field.`,
      );
    }
  }
  const defaultBidPerIntex = (PROMIS_LOAD * BigInt(MIN_BID_RATE)) / RATE_SCALE;
  assert(ENTRY_PRICE === PRICE_SCALE, 'Simulation COEN entry price must stay at 1 USD.');
  const strikePerIntexPrice = (prices[0].entryPriceMinor * PROMIS_LOAD) / PROMIS_SCALE;
  assert(
    defaultBidPerIntex === 5_000n * PROMIS_SCALE &&
      defaultBidPerIntex / PROMIS_SCALE === ((strikePerIntexPrice / PRICE_SCALE) * BigInt(MIN_BID_RATE)) / RATE_SCALE,
    'Simulation default bid must equal 5% of the USD strike per Intex.',
  );
  return {
    worldwideDay,
    commitEnd: seededAt + step,
    revealEnd: seededAt + step * 2,
    issuanceEnd: seededAt + step * 3,
    promisLoadMinor: PROMIS_LOAD,
    minIntexBidRate: MIN_BID_RATE,
    prices,
    callNoticePeriod: INTEX_CALL_PERIOD_SECONDS,
    callWindow: 30 * DAY_SECONDS,
    callThreshold: 21 * DAY_SECONDS,
    minIntexBidQuantity: 1,
    commitBondMinor: COMMIT_BOND,
    dayState,
  };
};

const startAuction = async (seededAt, options, worldwideDay = WORLDWIDE_DAY) => {
  const params = auctionParams(seededAt, options, worldwideDay);
  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'startAuction', [params]);
  return { params, receipt };
};

const makeBidMaterialFor = async (
  account,
  quantity,
  bidRate = BID_RATE,
  issuanceCurrency = 949,
  referenceCurrency = 840,
  worldwideDay = WORLDWIDE_DAY,
) => {
  const signature = await account.signTypedData({
    domain: {
      name: 'IntexAuction',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: deployment.intexAuction,
    },
    types: {
      RevealBid: [
        { name: 'worldwideDay', type: 'uint32' },
        { name: 'bidder', type: 'address' },
        { name: 'quantity', type: 'uint16' },
        { name: 'bidRate', type: 'uint32' },
        { name: 'issuanceCurrency', type: 'uint16' },
        { name: 'referenceCurrency', type: 'uint16' },
      ],
    },
    primaryType: 'RevealBid',
    message: {
      worldwideDay,
      bidder: account.address,
      quantity,
      bidRate,
      issuanceCurrency,
      referenceCurrency,
    },
  });
  return {
    bidder: account.address,
    issuanceCurrency,
    referenceCurrency,
    quantity,
    bidRate,
    signature,
    commitHash: keccak256(signature),
    lockAmount: escrowLockNative(quantity, PROMIS_LOAD, bidRate),
    worldwideDay,
  };
};

const makeBidMaterial = (quantity, bidRate = BID_RATE, worldwideDay = WORLDWIDE_DAY) =>
  makeBidMaterialFor(backgroundBidderAccount, quantity, bidRate, 949, 840, worldwideDay);

const commitBidFor = async (wallet, material) => {
  await tx(wallet, deployment.wcoen, erc20Abi, 'approve', [
    deployment.escrowAdapter,
    COMMIT_BOND + material.lockAmount,
  ]);
  return tx(wallet, deployment.intexAuction, auctionAbi, 'commitBid', [material.worldwideDay, material.commitHash]);
};

const commitBid = (material) => commitBidFor(backgroundBidderWallet, material);

const revealBidFor = (wallet, material) =>
  tx(wallet, deployment.intexAuction, auctionAbi, 'revealBid', [
    material.worldwideDay,
    material.quantity,
    material.bidRate,
    material.issuanceCurrency,
    material.referenceCurrency,
    BigInt(CHAIN_ID),
    material.signature,
  ]);

const revealBid = (material) => revealBidFor(backgroundBidderWallet, material);

const setGlobalStage = async (stage, worldwideDay = WORLDWIDE_DAY) =>
  tx(operatorWallet, deployment.controller, controllerAbi, 'setGlobalAuctionStage', [worldwideDay, stage]);

const moveToReveal = async (params) => {
  await mineAt(params.commitEnd + 1);
  await setGlobalStage(GLOBAL_REVEALING, params.worldwideDay);
  assert((await readTargetStage(params.worldwideDay)) === TARGET_REVEAL, 'Target auction did not enter reveal stage.');
};

const moveToClearing = async (params) => {
  await mineAt(params.revealEnd + 1);
  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'startClearing', [
    params.worldwideDay,
  ]);
  assert((await readGlobalStage(params.worldwideDay)) === GLOBAL_CLEARING, 'Global auction did not enter clearing.');
  assert(
    (await readTargetStage(params.worldwideDay)) === TARGET_ISSUANCE,
    'Target auction did not enter issuance stage.',
  );
  return receipt;
};

const recordGlobalClearing = async (
  { issued, rate, demand, unused = 0n, reportUnused = false },
  worldwideDay = WORLDWIDE_DAY,
) => {
  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'recordGlobalClearing', [
    worldwideDay,
    issued,
    rate,
    BigInt(demand),
    unused,
    reportUnused,
  ]);
  assert((await readGlobalStage(worldwideDay)) === GLOBAL_CLEARED, 'Global auction did not enter Cleared.');
  return receipt;
};

const postTargetResult = async ({ issued, rate, winners }, worldwideDay = WORLDWIDE_DAY) => {
  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'postAuctionResult', [
    CHAIN_ID,
    worldwideDay,
    issued,
    BigInt(rate),
    winners,
  ]);
  assert((await readTargetStage(worldwideDay)) === TARGET_COMPLETED, 'Target auction result was not applied.');
  const logs = await sameTransactionLogs(receipt, deployment.targetRouter, auctionResultReceivedEvent, {
    srcChainId: CHAIN_ID,
    worldwideDay,
  });
  assert(logs.length === 1, 'Expected one target AuctionResultReceived event.');
  return receipt;
};

const seriesIdBytes14 = (worldwideDay) => `0x${Number(worldwideDay).toString(16).padStart(28, '0')}`;

const setCanonicalSeries = async (seededAt, issued, worldwideDay = WORLDWIDE_DAY, issuanceCurrency = 840) =>
  tx(operatorWallet, deployment.controller, controllerAbi, 'setSeries', [
    {
      seriesId: seriesIdBytes14(worldwideDay),
      promisLoadMinor: PROMIS_LOAD,
      entryPriceMinor: ENTRY_PRICE,
      floorPriceMinor: FLOOR_PRICE,
      issuedUnits: issued,
      callWindow: 30 * DAY_SECONDS,
      callThreshold: 21 * DAY_SECONDS,
      callPriceMinor: CALL_PRICE,
      state: 1,
      issuedAt: seededAt,
      calledAt: 0,
      callNoticePeriod: INTEX_CALL_PERIOD_SECONDS,
      issuanceCurrency,
      referenceCurrency: 840,
      worldwideDay,
      settledUnits: 0,
      exercisedUnits: 0,
      gemFactoryUnits: 0,
    },
  ]);

const baseSummary = (name, seededAt) => ({
  name,
  chainId: CHAIN_ID,
  worldwideDay: WORLDWIDE_DAY,
  seededAt,
  deterministicAccounts: {
    operator: operatorAccount.address,
    bidder: bidderAccount.address,
    backgroundBidder: backgroundBidderAccount.address,
  },
});

const seedCommitOpen = async (seededAt) => {
  const oracle = await seedOracleHistory();
  const previousDemand = await seedPreviousDemandHistory(seededAt);
  const currentChainTime = Number((await publicClient.getBlock()).timestamp);
  await seedWorldwideDay(seededAt);
  // Keep deterministic genesis for boundary tests, but snap the interactive deadline to the
  // next UTC+14 midnight so the lifecycle stays live and day-aligned rather than at an arbitrary wall clock.
  const scheduleStartedAt = nextUtc14Midnight(Math.max(currentChainTime, Math.floor(Date.now() / 1000)));
  const { params, receipt } = await startAuction(scheduleStartedAt, { longWindow: true });
  const auction = await readAuctionInfo();
  assert(
    Number(auction.params.callTrigger.callNoticePeriod) === INTEX_CALL_PERIOD_SECONDS,
    'Commit-open fixture must expose the expected seven-day Called deadline.',
  );
  assert((await readGlobalStage()) === GLOBAL_STARTED, 'Expected global Started stage.');
  assert((await readTargetStage()) === TARGET_COMMIT, 'Expected target commit stage.');
  const counts = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'auctionRunningCounts',
    args: [WORLDWIDE_DAY],
  });
  const commitHash = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'committedBidsByHash',
    args: [WORLDWIDE_DAY, backgroundBidderAccount.address],
  });
  assert(Number(counts[0]) === 0 && commitHash === zeroHash, 'commit-open must not imply a bidder commit.');
  return {
    ...baseSummary('commit-open', seededAt),
    schedule: {
      startedAt: scheduleStartedAt,
      commitEnd: params.commitEnd,
      revealEnd: params.revealEnd,
      issuanceEnd: params.issuanceEnd,
      commitWindowSeconds: params.commitEnd - scheduleStartedAt,
      intexCallPeriodSeconds: Number(auction.params.callTrigger.callNoticePeriod),
    },
    previousDemand,
    chart: oracle,
    assertions: {
      globalStage: GLOBAL_STARTED,
      targetStage: TARGET_COMMIT,
      committedBids: 0,
      commitWindowSeconds: DAY_SECONDS,
      previousDemandDays: previousDemand.length,
      oracleRecentDays: ORACLE_HISTORY_DAYS,
      oracleNewestFirst: true,
      oracleRetentionBounded: true,
    },
    transactions: { auctionStart: receipt.transactionHash },
  };
};

const seedRevealOpen = async (seededAt) => {
  const oracle = await seedOracleHistory();
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  const material = await makeBidMaterial(5);
  const commitReceipt = await commitBid(material);

  await mineAt(params.commitEnd - 1);
  const before = await readTargetStage();
  await mineAt(params.commitEnd);
  const exact = await readTargetStage();
  await mineAt(params.commitEnd + 1);
  const after = await readTargetStage();
  assert(
    before === TARGET_COMMIT && exact === TARGET_REVEAL && after === TARGET_REVEAL,
    `Unexpected commit boundary stages: ${before}/${exact}/${after}.`,
  );
  await setGlobalStage(GLOBAL_REVEALING);

  await publicClient.simulateContract({
    account: backgroundBidderAccount,
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'revealBid',
    args: [
      WORLDWIDE_DAY,
      material.quantity,
      material.bidRate,
      material.issuanceCurrency,
      material.referenceCurrency,
      BigInt(CHAIN_ID),
      material.signature,
    ],
  });
  const storedHash = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'committedBidsByHash',
    args: [WORLDWIDE_DAY, backgroundBidderAccount.address],
  });
  const revealed = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'revealedBidsByBidder',
    args: [WORLDWIDE_DAY, backgroundBidderAccount.address],
  });
  assert(
    storedHash === material.commitHash && revealed === false,
    'Reveal-open commitment is not live and unrevealed.',
  );
  const auction = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [WORLDWIDE_DAY],
  });
  assert(
    auction.params.prices.find((price) => Number(price.isoCode) === 840)?.entryPriceMinor ===
      params.prices[0].entryPriceMinor &&
      auction.params.prices.find((price) => Number(price.isoCode) === 840)?.floorPriceMinor ===
        params.prices[0].floorPriceMinor &&
      auction.params.prices.find((price) => Number(price.isoCode) === 840)?.callPriceMinor ===
        params.prices[0].callPriceMinor,
    'Venue Entry/Floor/Call parameters do not match the chart fixture.',
  );
  return {
    ...baseSummary('reveal-open', seededAt),
    bidder: backgroundBidderAccount.address,
    commitHash: material.commitHash,
    schedule: { commitEnd: params.commitEnd, revealEnd: params.revealEnd, issuanceEnd: params.issuanceEnd },
    chart: {
      ...oracle,
      referenceLines: {
        entry: auction.params.prices.find((price) => Number(price.isoCode) === 840)?.entryPriceMinor.toString(),
        floor: auction.params.prices.find((price) => Number(price.isoCode) === 840)?.floorPriceMinor.toString(),
        call: auction.params.prices.find((price) => Number(price.isoCode) === 840)?.callPriceMinor.toString(),
      },
    },
    assertions: {
      beforeCommitBoundary: before,
      atCommitBoundary: exact,
      afterCommitBoundary: after,
      revealSimulation: 'success',
      oracleNewestFirst: true,
      oracleRetentionBounded: true,
      chartReferenceLinesAuthoritative: true,
    },
    transactions: { commit: commitReceipt.transactionHash },
  };
};

const seedOracleUnavailable = async (seededAt) => {
  await seedOracleHistory();
  await seedWorldwideDay(seededAt);
  await startAuction(seededAt, { longWindow: true });
  await tx(operatorWallet, deployment.controller, controllerAbi, 'setOracleFailure', [true]);

  let oracleUnavailable = false;
  try {
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getExchangeRate',
      args: [ORACLE_COEN, oracleQuoteToken(ORACLE_QUOTE_ISO)],
    });
  } catch {
    oracleUnavailable = true;
  }
  const wwd = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getWorldwideDay',
    args: [WORLDWIDE_DAY],
  });
  const targetStage = await readTargetStage();
  assert(oracleUnavailable, 'Oracle fixture did not fail independently.');
  assert(
    Number(wwd[0]) === WWD_COMPLETED && Number(wwd[1]) === DAY_GREEN,
    'Oracle failure changed the retained WWD state.',
  );
  assert(targetStage === TARGET_COMMIT, 'Oracle failure changed the delivered venue state.');

  return {
    ...baseSummary('oracle-unavailable', seededAt),
    assertions: {
      oracleUnavailable: true,
      wwdLifecycle: WWD_COMPLETED,
      dayType: DAY_GREEN,
      targetStage: TARGET_COMMIT,
      wwdUnaffected: true,
      venueUnaffected: true,
    },
  };
};

const seedCompletedSale = async (seededAt, { name, quantity, issued, unused, reportUnused }) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  const material = await makeBidMaterial(quantity);
  await commitBid(material);
  await moveToReveal(params);
  await revealBid(material);
  await moveToClearing(params);

  const globalReceipt = await recordGlobalClearing({
    issued,
    rate: BID_RATE,
    demand: quantity,
    unused,
    reportUnused,
  });
  const targetReceipt = await postTargetResult({ issued, rate: BID_RATE, winners: 1 });
  await setCanonicalSeries(seededAt, issued);

  const clearingLogs = await sameTransactionLogs(globalReceipt, deployment.controller, auctionClearedEvent, {
    worldwideDay: WORLDWIDE_DAY,
  });
  const unusedLogs = await sameTransactionLogs(globalReceipt, deployment.controller, unusedSupplyEvent, {
    worldwideDay: WORLDWIDE_DAY,
  });
  assert(clearingLogs.length === 1, 'Expected one global AuctionCleared event.');
  assert(unusedLogs.length === (reportUnused ? 1 : 0), 'Unexpected unused-supply evidence.');

  const auction = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [WORLDWIDE_DAY],
  });
  assert(
    Number(auction.result.issuedIntexCount) === issued && Number(auction.result.wonBidsCount) === 1,
    'Target aggregate result does not match the global fixture.',
  );
  assert(
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'seriesExists',
      args: [seriesIdBytes14(WORLDWIDE_DAY)],
    }),
    'Positive clearing must expose a canonical series.',
  );

  const offered = issued + Number(unused / PROMIS_LOAD);
  return {
    ...baseSummary(name, seededAt),
    bidder: backgroundBidderAccount.address,
    clearing: {
      issuedQuantity: issued,
      clearingRate: BID_RATE,
      grossIncludedDemand: quantity,
      unusedPromis: unused.toString(),
      offeredQuantity: offered,
      conversionDust: (unused % PROMIS_LOAD).toString(),
    },
    assertions: {
      globalStage: GLOBAL_CLEARED,
      targetStage: TARGET_COMPLETED,
      globalClearingEvent: true,
      targetResultReceived: true,
      recipientDeliveryAsserted: false,
      bidderEscrowFinalizationAsserted: false,
    },
    transactions: {
      globalClearing: globalReceipt.transactionHash,
      targetResultDelivery: targetReceipt.transactionHash,
    },
  };
};

const seedReapedHistoricalAuction = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  const firstBid = await makeBidMaterialFor(bidderAccount, 3, 750_000);
  const secondBid = await makeBidMaterialFor(backgroundBidderAccount, 5, BID_RATE);
  await commitBidFor(bidderWallet, firstBid);
  await commitBidFor(backgroundBidderWallet, secondBid);
  await moveToReveal(params);
  const firstReveal = await revealBidFor(bidderWallet, firstBid);
  const secondReveal = await revealBidFor(backgroundBidderWallet, secondBid);

  const revealLogsBefore = await publicClient.getLogs({
    address: deployment.intexAuction,
    event: bidRevealedEvent,
    args: { worldwideDay: WORLDWIDE_DAY },
    fromBlock: firstReveal.blockNumber,
    toBlock: secondReveal.blockNumber,
  });
  assert(revealLogsBefore.length === 2, 'Expected two durable BidRevealed logs before reaping.');

  await moveToClearing(params);
  await recordGlobalClearing({ issued: 8, rate: 750_000, demand: 8 });
  await postTargetResult({ issued: 8, rate: 750_000, winners: 2 });
  const beforeReap = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionDetails',
    args: [WORLDWIDE_DAY],
  });
  assert(beforeReap[1].length === 2, 'Historical fixture did not retain both revealed bids before reaping.');

  await mineAt(params.issuanceEnd + 1);
  const reapReceipt = await tx(operatorWallet, deployment.intexAuction, auctionAbi, 'reapAuction', [
    WORLDWIDE_DAY,
    100n,
  ]);
  const afterReap = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionDetails',
    args: [WORLDWIDE_DAY],
  });
  const revealLogsAfter = await publicClient.getLogs({
    address: deployment.intexAuction,
    event: bidRevealedEvent,
    args: { worldwideDay: WORLDWIDE_DAY },
    fromBlock: firstReveal.blockNumber,
  });
  assert(afterReap[1].length === 0, 'reapAuction did not remove the stored bid array.');
  assert(revealLogsAfter.length === 2, 'BidRevealed logs did not survive auction reaping.');

  return {
    ...baseSummary('reaped-historical-auction', seededAt),
    bidders: [bidderAccount.address, backgroundBidderAccount.address],
    schedule: { commitEnd: params.commitEnd, revealEnd: params.revealEnd, issuanceEnd: params.issuanceEnd },
    historicalLadder: revealLogsAfter.map((log) => ({
      bidder: log.args.bidder,
      quantity: Number(log.args.quantity),
      bidRate: Number(log.args.bidRate),
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
    })),
    assertions: {
      targetStage: TARGET_COMPLETED,
      storedBidsBeforeReap: 2,
      storedBidsAfterReap: 0,
      durableRevealLogsAfterReap: 2,
    },
    transactions: { reap: reapReceipt.transactionHash },
  };
};

const seedCompletedNoSale = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  await moveToReveal(params);
  await moveToClearing(params);
  const globalReceipt = await recordGlobalClearing({
    issued: 0,
    rate: 0,
    demand: 0,
    unused: 5n * PROMIS_LOAD,
    reportUnused: true,
  });
  const targetReceipt = await postTargetResult({ issued: 0, rate: 0, winners: 0 });

  const emptyLogs = await sameTransactionLogs(globalReceipt, deployment.controller, auctionClearedEmptyEvent, {
    worldwideDay: WORLDWIDE_DAY,
  });
  assert(emptyLogs.length === 1, 'Expected one AuctionClearedEmpty event.');
  assert(
    (await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'seriesExists',
      args: [seriesIdBytes14(WORLDWIDE_DAY)],
    })) === false,
    'No-sale must not create a canonical series.',
  );
  const targetSeries = await publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'seriesIdsByWorldwideDay',
    args: [WORLDWIDE_DAY],
  });
  assert(targetSeries.length === 0, 'No-sale must not create a target series.');

  return {
    ...baseSummary('completed-green-no-sale', seededAt),
    assertions: {
      globalStage: GLOBAL_CLEARED,
      targetStage: TARGET_COMPLETED,
      zeroWinners: true,
      canonicalSeries: false,
      targetSeries: false,
      issuanceApplicable: false,
    },
    transactions: {
      globalClearing: globalReceipt.transactionHash,
      targetResultDelivery: targetReceipt.transactionHash,
    },
  };
};

const seedCompletedRed = async (seededAt) => {
  await seedWorldwideDay(seededAt, WWD_COMPLETED, DAY_RED);
  const { receipt } = await startAuction(seededAt, { dayState: DAY_RED });
  const wwd = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getWorldwideDay',
    args: [WORLDWIDE_DAY],
  });
  assert(Number(wwd[0]) === WWD_COMPLETED && Number(wwd[1]) === DAY_RED, 'WWD is not Completed Red.');
  assert((await readGlobalStage()) === GLOBAL_CANCELLED, 'Red global auction is not Cancelled.');
  assert((await readTargetStage()) === TARGET_CANCELLED, 'Red target auction is not Cancelled.');
  const cleared = await publicClient.getLogs({
    address: deployment.controller,
    event: auctionClearedEvent,
    args: { worldwideDay: WORLDWIDE_DAY },
    fromBlock: receipt.blockNumber,
  });
  assert(cleared.length === 0, 'Red day must not carry Green clearing evidence.');
  return {
    ...baseSummary('completed-red', seededAt),
    assertions: {
      wwdLifecycle: WWD_COMPLETED,
      dayType: DAY_RED,
      globalStage: GLOBAL_CANCELLED,
      targetStage: TARGET_CANCELLED,
      greenClearingEvidence: false,
    },
    transactions: { redCancellationDelivery: receipt.transactionHash },
  };
};

const seedFailedGreen = async (seededAt) => {
  await seedWorldwideDay(seededAt, WWD_FAILED, DAY_GREEN);
  const wwd = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getWorldwideDay',
    args: [WORLDWIDE_DAY],
  });
  assert(Number(wwd[0]) === WWD_FAILED && Number(wwd[1]) === DAY_GREEN, 'WWD is not Failed Green.');
  assert((await readGlobalStage()) === 0, 'Failed Green must not imply a global sale or cancellation.');
  assert((await targetAuctionExists()) === false, 'Failed Green must not imply a venue auction.');
  return {
    ...baseSummary('failed-green', seededAt),
    assertions: {
      wwdExists: true,
      wwdLifecycle: WWD_FAILED,
      dayType: DAY_GREEN,
      red: false,
      noSale: false,
      venueCancelled: false,
      missingWwd: false,
    },
  };
};

const seedCleanedHistoryUnavailable = async (seededAt) => {
  await seedWorldwideDay(seededAt, WWD_COMPLETED, DAY_RED);
  const cleanupReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'cleanWorldwideDay', [
    WORLDWIDE_DAY,
  ]);
  const cleanupLogs = await sameTransactionLogs(cleanupReceipt, deployment.controller, worldwideDayCleanedUpEvent, {
    worldwideDay: WORLDWIDE_DAY,
  });
  let retainedRecordUnavailable = false;
  try {
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getWorldwideDay',
      args: [WORLDWIDE_DAY],
    });
  } catch {
    retainedRecordUnavailable = true;
  }
  assert(
    cleanupLogs.length === 1 && Number(cleanupLogs[0].args.finalStatus) === WWD_COMPLETED,
    'Durable WorldwideDayCleanedUp evidence is missing.',
  );
  assert(retainedRecordUnavailable, 'Cleaned WWD record remains readable.');
  return {
    ...baseSummary('cleaned-history-unavailable', seededAt),
    classification: 'CleanedHistoryUnavailable',
    assertions: {
      cleanupEvidence: true,
      finalLifecycle: WWD_COMPLETED,
      retainedRecordAvailable: false,
      dayTypeRecoverable: false,
      guessedDayType: false,
      missingWwd: false,
    },
    transactions: { cleanup: cleanupReceipt.transactionHash },
  };
};

const seedTerminalNoAuction = async (seededAt) => {
  await seedWorldwideDay(seededAt, WWD_FAILED, DAY_UNKNOWN);
  const block = await publicClient.getBlock();
  await tx(operatorWallet, deployment.controller, controllerAbi, 'setWorldwideDayTerminalReceipt', [
    WORLDWIDE_DAY,
    {
      outcome: 1,
      valueRouted: 5_000n,
      carryOverBefore: 1_000n,
      carryOverAfter: 6_000n,
      retirementOutcome: 1,
      blockNumber: block.number,
      exists: true,
    },
  ]);
  const receipt = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getWorldwideDayTerminalReceipt',
    args: [WORLDWIDE_DAY],
  });
  assert(Number(receipt[0]) === 1, 'Expected MissedOffering terminal receipt.');
  assert((await readGlobalStage()) === 0, 'Terminal no-auction must not create a global auction.');
  assert((await targetAuctionExists()) === false, 'Terminal no-auction must not create a venue auction.');
  return {
    ...baseSummary('terminal-no-auction', seededAt),
    terminalDisposition: 'MissedOffering',
    assertions: { wwdLifecycle: WWD_FAILED, dayType: DAY_UNKNOWN, globalAuction: false, venueAuction: false },
  };
};

const seedVenueDeliveryPending = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setAutoDeliver', [false]);
  const { receipt } = await startAuction(seededAt, { longWindow: true });
  const targets = await publicClient.readContract({
    address: deployment.originRouter,
    abi: originReadAbi,
    functionName: 'targetsOf',
    args: [WORLDWIDE_DAY],
  });
  assert(targets.length === 1 && Number(targets[0]) === CHAIN_ID, 'Venue is not in the frozen target context.');
  assert((await readGlobalStage()) === GLOBAL_STARTED, 'Expected applicable global Started state.');
  assert((await targetAuctionExists()) === false, 'Venue auction was unexpectedly delivered.');
  const payload = await publicClient.readContract({
    address: deployment.bridge,
    abi: bridgeAbi,
    functionName: 'lastPayload',
  });
  assert(payload !== '0x', 'Origin dispatch evidence is missing.');
  return {
    ...baseSummary('venue-delivery-pending', seededAt),
    assertions: {
      frozenTarget: CHAIN_ID,
      globalStage: GLOBAL_STARTED,
      venueAuctionExists: false,
      authoritativeVenueScheduleAvailable: false,
      guessedAuctionDate: false,
    },
    transactions: { originStageDispatch: receipt.transactionHash },
  };
};

const prepareVenueChainSkipped = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  const material = await makeBidMaterial(5);
  await commitBid(material);
  await moveToReveal(params);
  await revealBid(material);
  await mineAt(params.revealEnd + 1);

  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setFee', [1n]);
  const fundHash = await operatorWallet.sendTransaction({ to: deployment.originRouter, value: 1n, chain: null });
  await publicClient.waitForTransactionReceipt({ hash: fundHash, pollingInterval: 100 });
  await tx(operatorWallet, deployment.controller, controllerAbi, 'startClearing', [WORLDWIDE_DAY]);
  assert((await readTargetStage()) === TARGET_ISSUANCE, 'Target did not receive clearing stage.');
  const pending = await publicClient.readContract({
    address: deployment.targetRouter,
    abi: targetExtraAbi,
    functionName: 'bidsRelay',
    args: [WORLDWIDE_DAY],
  });
  assert(!pending[2], 'Local bids relay was not parked.');
  assert(
    (await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getChainBidsCount',
      args: [WORLDWIDE_DAY, CHAIN_ID],
    })) === 0n,
    'Skipped-chain bids reached global clearing.',
  );

  const skippedReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'markChainSkipped', [
    WORLDWIDE_DAY,
    CHAIN_ID,
  ]);
  await recordGlobalClearing({ issued: 0, rate: 0, demand: 0, unused: 5n * PROMIS_LOAD, reportUnused: true });
  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setFee', [0n]);
  await postTargetResult({ issued: 0, rate: 0, winners: 0 });

  const skipLogs = await sameTransactionLogs(skippedReceipt, deployment.controller, chainSkippedEvent, {
    worldwideDay: WORLDWIDE_DAY,
    srcChainId: CHAIN_ID,
  });
  assert(
    skipLogs.length === 1 &&
      (await publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'isChainSkipped',
        args: [WORLDWIDE_DAY, CHAIN_ID],
      })),
    'ChainSkipped evidence is missing.',
  );
  const lock = await publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getBidLock',
    args: [WORLDWIDE_DAY, backgroundBidderAccount.address],
  });
  assert(lock.lockedAmount > 0n && Number(lock.status) !== 2, 'Skipped bidder lock is not left unfinalized.');
  const refundLogs = await publicClient.getLogs({
    address: deployment.targetRouter,
    event: refundReceivedEvent,
    args: { worldwideDay: WORLDWIDE_DAY },
    fromBlock: skippedReceipt.blockNumber,
  });
  assert(refundLogs.length === 0, 'Skipped chain received normal refund instructions.');

  const summary = {
    ...baseSummary('venue-chain-skipped', seededAt),
    bidder: backgroundBidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    bidLockMinor: lock.lockedAmount.toString(),
    lockedAt: Number(lock.lockedAt),
    schedule: { commitEnd: params.commitEnd, revealEnd: params.revealEnd, issuanceEnd: params.issuanceEnd },
    assertions: {
      frozenTarget: CHAIN_ID,
      chainSkipped: true,
      localGlobalBidCount: 0,
      targetResultApplied: true,
      normalRefundInstructions: false,
      bidderLockFinalized: false,
    },
    transactions: { chainSkipped: skippedReceipt.transactionHash },
  };
  return { summary, material, params, lock, skippedReceipt };
};

const seedVenueChainSkipped = async (seededAt) => (await prepareVenueChainSkipped(seededAt)).summary;

const prepareParkedResult = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  await moveToReveal(params);
  await moveToClearing(params);
  await recordGlobalClearing({ issued: 0, rate: 0, demand: 0, unused: 5n * PROMIS_LOAD, reportUnused: true });
  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setFee', [1n]);
  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'postAuctionResult', [
    CHAIN_ID,
    WORLDWIDE_DAY,
    0,
    0n,
    0,
  ]);
  const parked = await publicClient.readContract({
    address: deployment.originRouter,
    abi: originReadAbi,
    functionName: 'parkedMessage',
    args: [0n],
  });
  assert(parked.payload !== '0x' && !parked.sent, 'Origin result send was not parked.');
  assert((await readTargetStage()) === TARGET_ISSUANCE, 'Parked result was unexpectedly applied at target.');
  const logs = await sameTransactionLogs(receipt, deployment.originRouter, sendParkedEvent, {
    idx: 0n,
    dstChainId: CHAIN_ID,
  });
  assert(logs.length === 1, 'MessageParked event is missing.');
  return { receipt, parked };
};

const seedOriginSendParked = async (seededAt) => {
  const { receipt } = await prepareParkedResult(seededAt);
  return {
    ...baseSummary('origin-send-parked', seededAt),
    assertions: { originSendParked: true, parkedSent: false, targetStage: TARGET_ISSUANCE, targetReceipt: false },
    transactions: { parkedAttempt: receipt.transactionHash },
  };
};

const seedOriginSendFlushedTargetPending = async (seededAt) => {
  await prepareParkedResult(seededAt);
  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setFee', [0n]);
  await tx(operatorWallet, deployment.bridge, bridgeAbi, 'setAutoDeliver', [false]);
  const flushReceipt = await tx(operatorWallet, deployment.originRouter, originWriteAbi, 'resendParkedMessage', [0n]);
  const parked = await publicClient.readContract({
    address: deployment.originRouter,
    abi: originReadAbi,
    functionName: 'parkedMessage',
    args: [0n],
  });
  const flushLogs = await sameTransactionLogs(flushReceipt, deployment.originRouter, pendingSendFlushedEvent, {
    idx: 0n,
    dstChainId: CHAIN_ID,
  });
  assert(parked.sent && flushLogs.length === 1, 'Origin parked send was not flushed.');
  assert((await readTargetStage()) === TARGET_ISSUANCE, 'Flushed dispatch was incorrectly treated as target receipt.');
  const targetLogs = await publicClient.getLogs({
    address: deployment.targetRouter,
    event: auctionResultReceivedEvent,
    args: { worldwideDay: WORLDWIDE_DAY },
    fromBlock: flushReceipt.blockNumber,
  });
  assert(targetLogs.length === 0, 'Target receipt occurred despite disabled transport delivery.');
  return {
    ...baseSummary('origin-send-flushed-target-pending', seededAt),
    assertions: { originDispatchFlushed: true, parkedSent: true, targetStage: TARGET_ISSUANCE, targetReceipt: false },
    transactions: { flush: flushReceipt.transactionHash },
  };
};

const assertAuctionBondBoundary = ({ bidder, deadline, amount }) =>
  assertDeadlineBoundary({
    deadline,
    before: (timestamp) =>
      assertContractRevert(() => simulateAuctionBondClaim(bidder), 'CommitBondNotYetClaimable', [deadline, timestamp]),
    exact: () => executeBondClaim({ bidder, functionName: 'claimCommitBond', expectedAmount: amount }),
    after: () => executeBondClaim({ bidder, functionName: 'claimCommitBond', expectedAmount: amount }),
  });

const assertAbandonedBondBoundary = ({ bidder, deadline, amount }) =>
  assertDeadlineBoundary({
    deadline,
    before: (timestamp) =>
      assertContractRevert(() => simulateAbandonedBondClaim(bidder), 'CommitBondNotYetAbandoned', [
        deadline,
        timestamp,
      ]),
    exact: () => executeBondClaim({ bidder, functionName: 'claimAbandonedCommitBond', expectedAmount: amount }),
    after: () => executeBondClaim({ bidder, functionName: 'claimAbandonedCommitBond', expectedAmount: amount }),
  });

const assertRefundBoundary = ({ bidder, deadline, beforeError, beforeArgs, expectedReturned, expectedBurned }) =>
  assertDeadlineBoundary({
    deadline,
    before: (timestamp) =>
      assertContractRevert(
        () => simulateRefundClaim(bidder),
        beforeError,
        beforeArgs?.(timestamp) ?? [deadline, timestamp],
      ),
    exact: () => executeRefundClaim({ bidder, expectedReturned, expectedBurned }),
    after: () => executeRefundClaim({ bidder, expectedReturned, expectedBurned }),
  });

const prepareUnrevealedBond = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt, { longWindow: true });
  const material = await makeBidMaterial(5);
  const commitReceipt = await commitBid(material);
  await moveToReveal(params);
  const clearingReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'startClearing', [
    WORLDWIDE_DAY,
  ]);

  const [auction, bond, storedHash, revealed] = await Promise.all([
    readAuctionInfo(),
    readCommitBond(material.bidder),
    publicClient.readContract({
      address: deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'committedBidsByHash',
      args: [WORLDWIDE_DAY, material.bidder],
    }),
    publicClient.readContract({
      address: deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'revealedBidsByBidder',
      args: [WORLDWIDE_DAY, material.bidder],
    }),
  ]);
  const clearingBlock = await publicClient.getBlock({ blockNumber: clearingReceipt.blockNumber });
  const storedRevealEnd = Number(auction.schedule.revealEnd);
  assert(
    storedRevealEnd === Number(clearingBlock.timestamp),
    'Early clearing did not snap stored revealEnd to the live block timestamp.',
  );
  assert(storedRevealEnd < params.revealEnd, 'Unrevealed-bond fixture did not exercise an early revealEnd snap.');
  assert(
    (await readTargetStage()) === TARGET_ISSUANCE,
    'Unrevealed-bond fixture is not auction-side recovery relevant.',
  );
  assert(storedHash === material.commitHash && revealed === false, 'Unrevealed commitment is not live.');
  assert(bond.amount === COMMIT_BOND && bond.lockedAt > 0, 'Bidder-level commit bond is not present.');

  const period = Number(await readConstant(deployment.intexAuction, auctionAbi, 'UNREVEALED_BOND_LOCK_PERIOD'));
  assert(period === 24 * 60 * 60, `Reviewed unrevealed-bond period changed to ${period}.`);
  const claimableAt = storedRevealEnd + period;
  return { params, material, bond, commitReceipt, clearingReceipt, storedRevealEnd, period, claimableAt };
};

const seedUnrevealedBond = async (seededAt, claimable) => {
  const prepared = await prepareUnrevealedBond(seededAt);
  const boundary = await assertAuctionBondBoundary({
    bidder: prepared.material.bidder,
    deadline: prepared.claimableAt,
    amount: prepared.bond.amount,
  });

  let claimReceipt;
  if (claimable) {
    await mineAt(boundary.exact);
    claimReceipt = await executeBondClaim({
      bidder: prepared.material.bidder,
      functionName: 'claimCommitBond',
      expectedAmount: prepared.bond.amount,
    });
  } else {
    await mineAt(boundary.before);
    await assertContractRevert(() => simulateAuctionBondClaim(prepared.material.bidder), 'CommitBondNotYetClaimable', [
      prepared.claimableAt,
      boundary.before,
    ]);
    assert(
      (await readCommitBond(prepared.material.bidder)).amount === prepared.bond.amount,
      'Waiting fixture lost the bidder-level commit bond.',
    );
  }

  const name = claimable ? 'unrevealed-bond-claimable' : 'unrevealed-bond-waiting';
  return {
    ...baseSummary(name, seededAt),
    bidder: prepared.material.bidder,
    caller: bidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    commitHash: prepared.material.commitHash,
    commitBondMinor: prepared.bond.amount.toString(),
    lockedAt: Number(prepared.bond.lockedAt),
    originalRevealEnd: prepared.params.revealEnd,
    revealEnd: prepared.storedRevealEnd,
    claimableAt: prepared.claimableAt,
    timing: { periodSeconds: prepared.period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    assertions: {
      liveCommitment: true,
      unrevealed: true,
      earlyRevealEndSnap: true,
      exactDeadlineAllowed: true,
      bidderPaidNotCaller: claimable,
      bondCleared: claimable,
    },
    transactions: {
      commit: prepared.commitReceipt.transactionHash,
      earlyClearing: prepared.clearingReceipt.transactionHash,
      ...(claimReceipt ? { claim: claimReceipt.transactionHash } : {}),
    },
  };
};

const prepareAbandonedBond = async (seededAt) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt, { longWindow: true });
  const material = await makeBidMaterial(5);
  const commitReceipt = await commitBid(material);
  const bond = await readCommitBond(material.bidder);
  assert(bond.amount === COMMIT_BOND && bond.lockedAt > 0, 'Abandoned-bond fixture has no bidder-level bond.');

  const wireReceipt = await tx(operatorWallet, deployment.escrowAdapter, escrowAbi, 'wire', [
    deployment.controller,
    deployment.theCompact,
    deployment.wcoen,
  ]);
  const currentAuction = await publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'intexAuctionContract',
  });
  const wireLogs = await sameTransactionLogs(wireReceipt, deployment.escrowAdapter, wiredEvent);
  assert(
    currentAuction.toLowerCase() === deployment.controller.toLowerCase(),
    'Escrow auction rotation did not apply.',
  );
  assert(
    wireLogs.length === 1 &&
      wireLogs[0].args.intexAuctionOld.toLowerCase() === deployment.intexAuction.toLowerCase() &&
      wireLogs[0].args.intexAuctionNew.toLowerCase() === deployment.controller.toLowerCase(),
    'Wiring epoch evidence does not retain old and new auction custody context.',
  );

  const period = Number(await readConstant(deployment.escrowAdapter, escrowAbi, 'COMMIT_BOND_ABANDON_DELAY'));
  assert(period === 30 * 24 * 60 * 60, `Reviewed abandoned-bond delay changed to ${period}.`);
  return {
    params,
    material,
    bond,
    commitReceipt,
    wireReceipt,
    currentAuction,
    period,
    claimableAt: Number(bond.lockedAt) + period,
  };
};

const seedAbandonedBond = async (seededAt, claimable) => {
  const prepared = await prepareAbandonedBond(seededAt);
  const boundary = await assertAbandonedBondBoundary({
    bidder: prepared.material.bidder,
    deadline: prepared.claimableAt,
    amount: prepared.bond.amount,
  });

  let claimReceipt;
  if (claimable) {
    await mineAt(boundary.exact);
    claimReceipt = await executeBondClaim({
      bidder: prepared.material.bidder,
      functionName: 'claimAbandonedCommitBond',
      expectedAmount: prepared.bond.amount,
    });
  } else {
    await mineAt(boundary.before);
    await assertContractRevert(
      () => simulateAbandonedBondClaim(prepared.material.bidder),
      'CommitBondNotYetAbandoned',
      [prepared.claimableAt, boundary.before],
    );
  }

  const name = claimable ? 'abandoned-commit-bond-claimable' : 'abandoned-commit-bond-waiting';
  return {
    ...baseSummary(name, seededAt),
    bidder: prepared.material.bidder,
    caller: bidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    currentEscrowAuction: prepared.currentAuction,
    commitHash: prepared.material.commitHash,
    commitBondMinor: prepared.bond.amount.toString(),
    lockedAt: Number(prepared.bond.lockedAt),
    claimableAt: prepared.claimableAt,
    timing: { periodSeconds: prepared.period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    wiringEpoch: {
      createdAuction: deployment.intexAuction,
      currentAuction: prepared.currentAuction,
      custodyEscrow: deployment.escrowAdapter,
    },
    assertions: {
      oldWiringRetained: true,
      auctionIndependent: true,
      exactDeadlineAllowed: true,
      bidderPaidNotCaller: claimable,
      bondCleared: claimable,
    },
    transactions: {
      commit: prepared.commitReceipt.transactionHash,
      wireRotation: prepared.wireReceipt.transactionHash,
      ...(claimReceipt ? { claim: claimReceipt.transactionHash } : {}),
    },
  };
};

const prepareRevealedAuction = async (seededAt, twoBidders) => {
  await seedWorldwideDay(seededAt);
  const { params } = await startAuction(seededAt);
  const primary = await makeBidMaterialFor(backgroundBidderAccount, 5, BID_RATE);
  const secondary = twoBidders ? await makeBidMaterialFor(bidderAccount, 3, 750_000) : null;

  await commitBidFor(backgroundBidderWallet, primary);
  if (secondary) await commitBidFor(bidderWallet, secondary);
  await moveToReveal(params);
  await revealBidFor(backgroundBidderWallet, primary);
  if (secondary) await revealBidFor(bidderWallet, secondary);
  await moveToClearing(params);

  const issued = secondary ? 8 : 5;
  const clearingRate = secondary ? 750_000 : BID_RATE;
  await recordGlobalClearing({ issued, rate: clearingRate, demand: issued });
  await postTargetResult({ issued, rate: clearingRate, winners: secondary ? 2 : 1 });

  const primaryLock = await readBidLock(primary.bidder);
  const secondaryLock = secondary ? await readBidLock(secondary.bidder) : null;
  assert(
    Number(primaryLock.status) === 1 && primaryLock.lockedAmount === primary.lockAmount,
    'Primary bidder lock is not real and active.',
  );
  if (secondary) {
    assert(
      Number(secondaryLock.status) === 1 && secondaryLock.lockedAmount === secondary.lockAmount,
      'Secondary bidder lock is not real and active.',
    );
  }
  return { params, primary, secondary, primaryLock, secondaryLock };
};

const seedUnfinalizedEscrow = async (seededAt, claimable) => {
  const prepared = await prepareVenueChainSkipped(seededAt);
  const bidder = prepared.material.bidder;
  const lock = await readBidLock(bidder);
  const [state, status] = await Promise.all([readEscrowState(), readAuctionStatus()]);
  assert(Number(lock.status) === 1 && lock.lockedAmount > 0n, 'Skipped bidder-level lock is not active.');
  assert(state[3] === false && status[1] === false, 'Skipped-chain escrow was finalized unexpectedly.');
  assert(status[0] === true, 'Historical hasLocks evidence is missing.');

  const period = Number(await readConstant(deployment.escrowAdapter, escrowAbi, 'UNFINALIZED_REFUND_DELAY'));
  assert(period === 72 * 60 * 60, `Reviewed unfinalized-refund delay changed to ${period}.`);
  const claimableAt = Number(lock.lockedAt) + period;
  const boundary = await assertRefundBoundary({
    bidder,
    deadline: claimableAt,
    beforeError: 'RefundNotYetClaimable',
    expectedReturned: lock.lockedAmount,
    expectedBurned: 0n,
  });

  let claimReceipt;
  if (claimable) {
    await mineAt(boundary.exact);
    claimReceipt = await executeRefundClaim({ bidder, expectedReturned: lock.lockedAmount, expectedBurned: 0n });
    const afterStatus = await readAuctionStatus();
    assert(
      afterStatus[0] === true && afterStatus[1] === false && afterStatus[2] === 0n,
      'Bidder recovery was inferred from aggregate hasLocks instead of bidder state.',
    );
  } else {
    await mineAt(boundary.before);
    await assertContractRevert(() => simulateRefundClaim(bidder), 'RefundNotYetClaimable', [
      claimableAt,
      boundary.before,
    ]);
  }

  const name = claimable ? 'unfinalized-escrow-claimable' : 'unfinalized-escrow-waiting';
  return {
    ...prepared.summary,
    name,
    caller: bidderAccount.address,
    bidLockMinor: lock.lockedAmount.toString(),
    lockedAt: Number(lock.lockedAt),
    claimableAt,
    expectedReturnedMinor: lock.lockedAmount.toString(),
    expectedBurnedMinor: '0',
    timing: { periodSeconds: period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    assertions: {
      ...prepared.summary.assertions,
      bidderLockActive: !claimable,
      aggregateFinalized: false,
      hasLocksIsHistoricalOnly: true,
      exactDeadlineAllowed: true,
      bidderPaidNotCaller: claimable,
    },
    transactions: {
      ...prepared.summary.transactions,
      ...(claimReceipt ? { claim: claimReceipt.transactionHash } : {}),
    },
  };
};

const seedFinalizedFailedSplit = async (seededAt) => {
  const prepared = await prepareRevealedAuction(seededAt, true);
  const bidder = prepared.primary.bidder;
  const refund = (prepared.primaryLock.lockedAmount * 30n) / 100n;
  const paid = prepared.primaryLock.lockedAmount - refund;

  await tx(operatorWallet, deployment.controller, controllerAbi, 'postRefundInstructions', [
    CHAIN_ID,
    WORLDWIDE_DAY,
    0,
    2,
    [prepared.secondary.bidder],
    [prepared.secondaryLock.lockedAmount],
    [0n],
  ]);
  await tx(operatorWallet, deployment.theCompact, compactAbi, 'setForcedWithdrawalShouldFail', [true]);
  const finalizationReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'postRefundInstructions', [
    CHAIN_ID,
    WORLDWIDE_DAY,
    1,
    2,
    [bidder],
    [refund],
    [paid],
  ]);
  await tx(operatorWallet, deployment.theCompact, compactAbi, 'setForcedWithdrawalShouldFail', [false]);

  const [lock, otherLock, state, failedLogs, finalizedLogs, noOpLogs] = await Promise.all([
    readBidLock(bidder),
    readBidLock(prepared.secondary.bidder),
    readEscrowState(),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, bidderRefundFailedEvent, {
      worldwideDay: WORLDWIDE_DAY,
      bidder,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, auctionEscrowFinalizedEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, finalizationNoOpEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
  ]);
  assert(state[3] && Number(state[2]) > 0, 'Failed-split escrow aggregate was not finalized.');
  assert(
    Number(lock.status) === 1 && lock.splitRecorded && lock.failedRefund === refund,
    'Validated failed split was not retained at bidder level.',
  );
  assert(Number(otherLock.status) === 2, 'Control bidder did not settle successfully.');
  assert(
    failedLogs.length === 1 && finalizedLogs.length === 1 && noOpLogs.length === 1,
    'Failed-split event evidence is inconsistent.',
  );

  const period = Number(await readConstant(deployment.escrowAdapter, escrowAbi, 'POST_FINALIZE_REFUND_DELAY'));
  assert(period === 72 * 60 * 60, `Reviewed failed-split delay changed to ${period}.`);
  const claimableAt = Number(state[2]) + period;
  const boundary = await assertRefundBoundary({
    bidder,
    deadline: claimableAt,
    beforeError: 'RefundNotYetClaimable',
    expectedReturned: refund,
    expectedBurned: paid,
  });
  await mineAt(boundary.before);
  await assertContractRevert(() => simulateRefundClaim(bidder), 'RefundNotYetClaimable', [
    claimableAt,
    boundary.before,
  ]);

  return {
    ...baseSummary('finalized-failed-split', seededAt),
    bidder,
    caller: bidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    bidLockMinor: lock.lockedAmount.toString(),
    lockedAt: Number(lock.lockedAt),
    finalizedAt: Number(state[2]),
    claimableAt,
    expectedReturnedMinor: refund.toString(),
    expectedBurnedMinor: paid.toString(),
    timing: { periodSeconds: period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    assertions: {
      aggregateFinalized: true,
      bidderLockActive: true,
      splitRecorded: true,
      failedRefundMinor: refund.toString(),
      otherBidderSettled: true,
      finalizationNoOp: true,
      exactDeadlineAllowed: true,
    },
    transactions: { finalization: finalizationReceipt.transactionHash },
  };
};

const seedFinalizedWithoutSplit = async (seededAt) => {
  const prepared = await prepareRevealedAuction(seededAt, true);
  const bidder = prepared.primary.bidder;
  const finalizationReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'postRefundInstructions', [
    CHAIN_ID,
    WORLDWIDE_DAY,
    0,
    1,
    [prepared.secondary.bidder],
    [prepared.secondaryLock.lockedAmount],
    [0n],
  ]);

  const [lock, otherLock, state, failedLogs, finalizedLogs, noOpLogs] = await Promise.all([
    readBidLock(bidder),
    readBidLock(prepared.secondary.bidder),
    readEscrowState(),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, bidderRefundFailedEvent, {
      worldwideDay: WORLDWIDE_DAY,
      bidder,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, auctionEscrowFinalizedEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, finalizationNoOpEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
  ]);
  assert(
    state[3] && Number(lock.status) === 1 && !lock.splitRecorded,
    'Omitted bidder was incorrectly treated as complete.',
  );
  assert(Number(otherLock.status) === 2, 'Included control bidder did not settle.');
  assert(
    failedLogs.length === 0 && finalizedLogs.length === 1 && noOpLogs.length === 0,
    'No-split finalization evidence is inconsistent.',
  );

  const period = Number(await readConstant(deployment.escrowAdapter, escrowAbi, 'POST_FINALIZE_REFUND_DELAY'));
  assert(period === 72 * 60 * 60, `Reviewed no-split delay changed to ${period}.`);
  const claimableAt = Number(state[2]) + period;
  const boundary = await assertRefundBoundary({
    bidder,
    deadline: claimableAt,
    beforeError: 'RefundNotYetClaimable',
    expectedReturned: lock.lockedAmount,
    expectedBurned: 0n,
  });

  return {
    ...baseSummary('finalized-without-split', seededAt),
    bidder,
    caller: bidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    bidLockMinor: lock.lockedAmount.toString(),
    lockedAt: Number(lock.lockedAt),
    finalizedAt: Number(state[2]),
    claimableAt,
    expectedReturnedMinor: lock.lockedAmount.toString(),
    expectedBurnedMinor: '0',
    timing: { periodSeconds: period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    assertions: {
      aggregateFinalized: true,
      bidderLockActive: true,
      splitRecorded: false,
      bidderOmitted: true,
      otherBidderSettled: true,
      finalizationNoOp: false,
      exactDeadlineAllowed: true,
    },
    transactions: { finalization: finalizationReceipt.transactionHash },
  };
};

const seedFinalizationNoOp = async (seededAt) => {
  const prepared = await prepareRevealedAuction(seededAt, false);
  const bidder = prepared.primary.bidder;
  const finalizationReceipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'postRefundInstructions', [
    CHAIN_ID,
    WORLDWIDE_DAY,
    0,
    1,
    [bidder],
    [0n],
    [prepared.primaryLock.lockedAmount - 1n],
  ]);

  const [lock, state, failedLogs, finalizedLogs, noOpLogs] = await Promise.all([
    readBidLock(bidder),
    readEscrowState(),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, bidderRefundFailedEvent, {
      worldwideDay: WORLDWIDE_DAY,
      bidder,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, auctionEscrowFinalizedEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
    sameTransactionLogs(finalizationReceipt, deployment.escrowAdapter, finalizationNoOpEvent, {
      worldwideDay: WORLDWIDE_DAY,
    }),
  ]);
  assert(
    state[3] && Number(lock.status) === 1 && !lock.splitRecorded,
    'FinalizationNoOp bidder was incorrectly treated as complete.',
  );
  assert(
    failedLogs.length === 1 && finalizedLogs.length === 1 && noOpLogs.length === 1,
    'Named FinalizationNoOp evidence is missing.',
  );
  assert(Number(noOpLogs[0].args.bidsProcessed) === 1, 'FinalizationNoOp bidder count is incorrect.');

  const period = Number(await readConstant(deployment.escrowAdapter, escrowAbi, 'POST_FINALIZE_REFUND_DELAY'));
  assert(period === 72 * 60 * 60, `Reviewed no-op fallback delay changed to ${period}.`);
  const claimableAt = Number(state[2]) + period;
  const boundary = await assertRefundBoundary({
    bidder,
    deadline: claimableAt,
    beforeError: 'RefundNotYetClaimable',
    expectedReturned: lock.lockedAmount,
    expectedBurned: 0n,
  });

  return {
    ...baseSummary('finalization-no-op', seededAt),
    bidder,
    caller: bidderAccount.address,
    auction: deployment.intexAuction,
    escrowAdapter: deployment.escrowAdapter,
    paymentToken: deployment.wcoen,
    bidLockMinor: lock.lockedAmount.toString(),
    lockedAt: Number(lock.lockedAt),
    finalizedAt: Number(state[2]),
    claimableAt,
    expectedReturnedMinor: lock.lockedAmount.toString(),
    expectedBurnedMinor: '0',
    timing: { periodSeconds: period, before: boundary.before, exact: boundary.exact, after: boundary.after },
    assertions: {
      aggregateFinalized: true,
      bidderLockActive: true,
      splitRecorded: false,
      bidderRefundFailed: true,
      finalizationNoOp: true,
      bidsProcessed: 1,
      exactDeadlineAllowed: true,
    },
    transactions: { finalization: finalizationReceipt.transactionHash },
  };
};

const seedPastDay = async (worldwideDay, seededAt, fixture, slotBase) => {
  const { red = false } = fixture;
  if (red) {
    await seedWorldwideDay(seededAt, WWD_COMPLETED, DAY_RED, worldwideDay);
    await setGlobalStage(GLOBAL_CANCELLED, worldwideDay);
    return { worldwideDay, red: true };
  }
  return await seedCompletedVenueAuction(worldwideDay, seededAt, fixture, slotBase);
};

const PAST_BIDDER_INDEX_BASE = 10;
const PAST_BIDDER_NATIVE_BALANCE = 10n * 10n ** 18n;
const localTokenAbi = parseAbi(['function mint(address to,uint256 amount)']);
const pastBidderAccount = (slot) => mnemonicToAccount(MNEMONIC, { addressIndex: PAST_BIDDER_INDEX_BASE + slot });
const pastBidderWallet = (slot) => createWalletClient({ account: pastBidderAccount(slot), transport: http(RPC_URL) });
const fundPastBidder = async (slot, lockAmount) => {
  const account = pastBidderAccount(slot);
  await rpc('anvil_setBalance', [account.address, `0x${PAST_BIDDER_NATIVE_BALANCE.toString(16)}`]);
  await tx(operatorWallet, deployment.wcoen, localTokenAbi, 'mint', [
    account.address,
    COMMIT_BOND + lockAmount + 10n ** 24n,
  ]);
};

const seedCompletedVenueAuction = async (
  worldwideDay,
  seededAt,
  { issued, demand, rate = 720_000, bids },
  slotBase,
) => {
  let existingStatus = 0;
  try {
    const existingWwd = await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getWorldwideDay',
      args: [worldwideDay],
    });
    existingStatus = Number(existingWwd[0]);
  } catch {}
  if (existingStatus === WWD_COMPLETED) {
    return { worldwideDay, red: false, issued, demand, bidders: bids.length };
  }

  await seedWorldwideDay(seededAt, WWD_COMPLETED, DAY_GREEN, worldwideDay);
  await recordGlobalClearing({ issued, rate, demand, unused: 0n, reportUnused: false }, worldwideDay);

  const chainNow = Number((await publicClient.getBlock()).timestamp);
  const futureTimestamp = chainNow + 200;
  const params = auctionParams(futureTimestamp, { dayState: DAY_GREEN, longWindow: false }, worldwideDay);

  const receipt = await tx(operatorWallet, deployment.controller, controllerAbi, 'startAuction', [params]);
  assert(receipt.status === 'success', 'startAuction failed for historical venue auction');

  assert(
    bids.reduce((total, bid) => total + bid.quantity, 0) === issued,
    `Past-day ${worldwideDay} ladder must sum to the issued count.`,
  );
  const materials = [];
  for (let offset = 0; offset < bids.length; offset += 1) {
    const material = await makeBidMaterialFor(
      pastBidderAccount(slotBase + offset),
      bids[offset].quantity,
      bids[offset].bidRate,
      949,
      840,
      worldwideDay,
    );
    await fundPastBidder(slotBase + offset, material.lockAmount);
    await commitBidFor(pastBidderWallet(slotBase + offset), material);
    materials.push(material);
  }

  await mineAt(params.commitEnd + 1);
  await setGlobalStage(GLOBAL_REVEALING, worldwideDay);
  assert((await readTargetStage(worldwideDay)) === TARGET_REVEAL, 'Target auction did not enter reveal stage.');

  for (let offset = 0; offset < materials.length; offset += 1) {
    await revealBidFor(pastBidderWallet(slotBase + offset), materials[offset]);
  }
  const revealLogs = await publicClient.getLogs({
    address: deployment.intexAuction,
    event: bidRevealedEvent,
    args: { worldwideDay },
    fromBlock: receipt.blockNumber,
    toBlock: 'latest',
  });
  assert(revealLogs.length === bids.length, 'Historical venue auction did not retain the full revealed ladder.');

  await mineAt(params.revealEnd + 1);
  await tx(operatorWallet, deployment.controller, controllerAbi, 'startClearing', [worldwideDay]);
  assert((await readGlobalStage(worldwideDay)) === GLOBAL_CLEARING, 'Global auction did not enter clearing.');
  assert((await readTargetStage(worldwideDay)) === TARGET_ISSUANCE, 'Target auction did not enter issuance stage.');

  const targetReceipt = await postTargetResult({ issued, rate, winners: materials.length }, worldwideDay);
  assert(targetReceipt.status === 'success', 'postTargetResult failed for historical venue auction');

  await setCanonicalSeries(futureTimestamp, issued, worldwideDay);

  await mineAt(params.issuanceEnd + 1);

  return { worldwideDay, red: false, issued, demand, bidders: bids.length };
};

const PAST_AUCTION_FIXTURES = [
  {
    daysAgo: 4,
    issued: 9,
    demand: 11,
    rate: 750_000,
    bids: [
      { quantity: 4, bidRate: 790_000 },
      { quantity: 3, bidRate: 760_000 },
      { quantity: 2, bidRate: 720_000 },
    ],
  },
  {
    daysAgo: 3,
    issued: 14,
    demand: 14,
    rate: 770_000,
    bids: [
      { quantity: 5, bidRate: 800_000 },
      { quantity: 4, bidRate: 775_000 },
      { quantity: 3, bidRate: 740_000 },
      { quantity: 2, bidRate: 710_000 },
    ],
  },
  { daysAgo: 2, red: true },
  {
    daysAgo: 1,
    issued: 10,
    demand: 13,
    rate: 690_000,
    bids: [
      { quantity: 4, bidRate: 720_000 },
      { quantity: 3, bidRate: 700_000 },
      { quantity: 2, bidRate: 660_000 },
      { quantity: 1, bidRate: 620_000 },
    ],
  },
];

const seedPastAuctions = async (seededAt) => {
  const oracle = await seedOracleHistory();
  const days = [];
  let slotBase = 0;
  for (const fixture of PAST_AUCTION_FIXTURES) {
    const worldwideDay = shiftWorldwideDay(WORLDWIDE_DAY, -fixture.daysAgo);
    days.push(await seedPastDay(worldwideDay, seededAt - fixture.daysAgo * DAY_SECONDS, fixture, slotBase));
    slotBase += (fixture.bids ?? []).length;
  }
  const currentChainTime = Number((await publicClient.getBlock()).timestamp);
  const scheduleStartedAt = nextUtc14Midnight(Math.max(currentChainTime, Math.floor(Date.now() / 1000)));
  await seedWorldwideDay(seededAt);
  const { params, receipt } = await startAuction(scheduleStartedAt, { longWindow: true });
  const auction = await readAuctionInfo();
  assert(
    Number(auction.params.callTrigger.callNoticePeriod) === INTEX_CALL_PERIOD_SECONDS,
    'Past-auctions fixture must expose the expected seven-day Called deadline.',
  );
  assert((await readGlobalStage()) === GLOBAL_STARTED, 'Expected global Started stage for the active auction.');
  assert((await readTargetStage()) === TARGET_COMMIT, 'Expected target commit stage for the active auction.');

  return {
    ...baseSummary('past-auctions', seededAt),
    schedule: {
      startedAt: scheduleStartedAt,
      commitEnd: params.commitEnd,
      revealEnd: params.revealEnd,
      issuanceEnd: params.issuanceEnd,
      commitWindowSeconds: params.commitEnd - scheduleStartedAt,
      intexCallPeriodSeconds: Number(auction.params.callTrigger.callNoticePeriod),
    },
    previousDemand: days,
    chart: oracle,
    assertions: {
      globalStage: GLOBAL_STARTED,
      targetStage: TARGET_COMMIT,
      pastDays: days.length,
      pastRedDays: days.filter((day) => day.red).length,
      previousDemandDays: days.length,
      oracleRecentDays: ORACLE_HISTORY_DAYS,
      oracleNewestFirst: true,
      oracleRetentionBounded: true,
    },
    transactions: { auctionStart: receipt.transactionHash },
  };
};

const scenarios = {
  'commit-open': seedCommitOpen,
  'reveal-open': seedRevealOpen,
  'oracle-unavailable': seedOracleUnavailable,
  'reaped-historical-auction': seedReapedHistoricalAuction,
  'failed-green': seedFailedGreen,
  'cleaned-history-unavailable': seedCleanedHistoryUnavailable,
  'completed-green-sold-out': (seededAt) =>
    seedCompletedSale(seededAt, {
      name: 'completed-green-sold-out',
      quantity: 5,
      issued: 5,
      unused: 0n,
      reportUnused: false,
    }),
  'completed-green-partial': (seededAt) =>
    seedCompletedSale(seededAt, {
      name: 'completed-green-partial',
      quantity: 2,
      issued: 2,
      unused: 3n * PROMIS_LOAD + 7n,
      reportUnused: true,
    }),
  'completed-green-no-sale': seedCompletedNoSale,
  'completed-red': seedCompletedRed,
  'terminal-no-auction': seedTerminalNoAuction,
  'venue-delivery-pending': seedVenueDeliveryPending,
  'venue-chain-skipped': seedVenueChainSkipped,
  'origin-send-parked': seedOriginSendParked,
  'origin-send-flushed-target-pending': seedOriginSendFlushedTargetPending,
  'unrevealed-bond-waiting': (seededAt) => seedUnrevealedBond(seededAt, false),
  'unrevealed-bond-claimable': (seededAt) => seedUnrevealedBond(seededAt, true),
  'abandoned-commit-bond-waiting': (seededAt) => seedAbandonedBond(seededAt, false),
  'abandoned-commit-bond-claimable': (seededAt) => seedAbandonedBond(seededAt, true),
  'unfinalized-escrow-waiting': (seededAt) => seedUnfinalizedEscrow(seededAt, false),
  'unfinalized-escrow-claimable': (seededAt) => seedUnfinalizedEscrow(seededAt, true),
  'finalized-failed-split': seedFinalizedFailedSplit,
  'finalized-without-split': seedFinalizedWithoutSplit,
  'finalization-no-op': seedFinalizationNoOp,
  'past-auctions': seedPastAuctions,
};

await stopOracleWalk();
await writeScenarioAfterAssertions({
  clear: () => rm(SCENARIO_PATH, { force: true }),
  build: async () => {
    await restoreBaseline();
    requireLocalChainId(await publicClient.getChainId(), CHAIN_ID);
    const expectedBalance = 200_000_000n * 10n ** 18n;
    const [manualBalance, backgroundBalance] = await Promise.all([
      readTokenBalance(bidderAccount.address),
      readTokenBalance(backgroundBidderAccount.address),
    ]);
    assert(
      manualBalance === expectedBalance && backgroundBalance === expectedBalance,
      'Baseline snapshot did not restore deterministic bidder balances.',
    );
    assert((await targetAuctionExists()) === false, 'Baseline snapshot leaked a prior scenario auction.');

    const seededAt = Number((await publicClient.getBlock()).timestamp);
    const summary = await scenarios[requested](seededAt);
    await publicClient.request({ method: 'evm_mine', params: [] });
    return summary;
  },
  write: (summary) => writeJson(SCENARIO_PATH, summary),
});
console.log(`Seeded ${requested} WorldwideDay ${WORLDWIDE_DAY}.`);
