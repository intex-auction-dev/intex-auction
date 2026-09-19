import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  zeroHash,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  ANVIL_STATE_PATH,
  CHAIN_ID,
  DEPLOYMENT_PATH,
  escrowLockNative,
  LOCAL_CONFIG_ROOT,
  LOCAL_ROOT,
  MNEMONIC,
  operatorAccount,
  ROOT,
  RPC_URL,
  SCENARIO_PATH,
  TESTER_NATIVE_BALANCE,
  TESTER_WALLET_ADDRESS,
} from '../infrastructure/constants.mjs';
import { readJson, writeJson } from '../infrastructure/config.mjs';
import { rpc } from '../infrastructure/rpc.mjs';
import { deriveRecoveryTimes } from '../controls/control-status.mjs';

const command = process.argv[2] ?? 'status';
const seedRequested = Number(process.argv[3]);
const commands = new Set([
  'status',
  'preview',
  'reset',
  'fund',
  'seed-bid',
  'seed-bids',
  'reveal',
  'clearing',
  'complete-sale',
  'no-sale',
  'red-day',
  'past-auctions',
  'advance-bond',
  'claim-bond',
  'advance-abandoned-bond',
  'claim-abandoned-bond',
  'advance-refund',
  'claim-refund',
  'qualify',
  'call',
  'oracle-defaults',
  'oracle-up',
  'oracle-usd-up',
  'oracle-try-up',
  'oracle-eur-up',
  'oracle-stale',
  'oracle-try-inactive',
  'oracle-available',
  'oracle-unavailable',
  'oracle-walk-start',
  'oracle-walk-stop',
]);
if (!commands.has(command)) throw new Error(`Unknown local control command: ${command}`);
if (!existsSync(DEPLOYMENT_PATH)) throw new Error('Local deployment is missing. Run npm run local:anvil first.');
if (
  !existsSync(SCENARIO_PATH) &&
  command !== 'reset' &&
  command !== 'red-day' &&
  command !== 'past-auctions' &&
  command !== 'status' &&
  command !== 'oracle-walk-start' &&
  command !== 'oracle-walk-stop'
) {
  throw new Error('Local scenario is missing. Reset the auction first.');
}

const deployment = await readJson(DEPLOYMENT_PATH);
const localAbi = async (name) => JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi', `${name}.json`), 'utf8'));
const [auctionAbi, escrowAbi, nftAbi, tokenAbi] = await Promise.all([
  localAbi('IntexAuction'),
  localAbi('EscrowAdapter'),
  localAbi('IntexNFT1155'),
  localAbi('ERC20'),
]);
const COEN = getAddress('0x0000000000000000000000000000000000000000');
const quoteToken = (isoCode) =>
  getAddress(
    `0x${keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'uint16' }], ['itx-acn.local.quote', isoCode]),
    ).slice(26)}`,
  );
const controllerAbi = parseAbi([
  'function getWorldwideDay(uint32 worldwideDay) view returns (uint8 status,uint8 dayType,uint64 formingStart,uint64 formingEnd,uint64 lookbackEnd,uint64 offeringEnd,uint64 scheduledProcessTime,uint256 previousVwap,uint256 currentVwap)',
  'function getAuctionStage(uint32 worldwideDay) view returns (uint8)',
  'function setGlobalAuctionStage(uint32 worldwideDay,uint8 stage)',
  'function startClearing(uint32 worldwideDay)',
  'function recordGlobalClearing(uint32 worldwideDay,uint32 issuedIntexCount,uint32 clearingRate,uint64 totalDemand,uint256 unusedPromis,bool reportUnused)',
  'function postAuctionResult(uint32 dstChainId,uint32 worldwideDay,uint32 issuedIntexCount,uint64 auctionClearingRate,uint32 wonBidsCount)',
  'function postRefundInstructions(uint32 dstChainId,uint32 worldwideDay,uint16 chunkIndex,uint16 totalChunks,address[] bidderAddresses,uint128[] refundedAmounts,uint128[] paidAmounts)',
  'function postIssuanceInstructions(uint32 dstChainId,(bytes14 seriesId,uint32 worldwideDay,uint32 issuedAt,uint32 issuedUnits,uint128 promisLoadMinor,uint64 entryPriceMinor,uint64 floorPriceMinor,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 callWindow,uint32 callThreshold,uint64 callPriceMinor,address[] recipients,uint256[] quantities)[] series)',
  'function setSeries((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits) data)',
  'function seriesExists(bytes14 seriesId) view returns (bool)',
  'function seriesData(bytes14 seriesId) view returns ((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits))',
  'function markQualified(bytes14 seriesId,uint32 worldwideDay)',
  'function markCalled(bytes14 seriesId,uint32 worldwideDay)',
  'function setOracleFixture(address base,address quote,uint16 isoCode,uint256 rate,uint256 vwap,uint64 timestamp)',
  'function setOraclePairActive(address base,address quote,bool active)',
  'function setOracleFailure(bool unavailable)',
  'function oracleFailure() view returns (bool)',
  'function getReferenceCurrencies() view returns (uint16[] isoCodes)',
  'function getExchangeRateData(address base,address quote) view returns (uint256 rate,uint64 lastBlock,uint64 lastTimestamp)',
  'function getCoenExchangeRateFor(uint16 isoCode) view returns (uint256 rate)',
]);
const localTokenAbi = parseAbi([
  'function mint(address to,uint256 amount)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);
const bondAbi = parseAbi([
  'function UNREVEALED_BOND_LOCK_PERIOD() view returns (uint32)',
  'function claimCommitBond(uint32 worldwideDay,address bidder)',
]);
const escrowClaimAbi = parseAbi([
  'function COMMIT_BOND_ABANDON_DELAY() view returns (uint32)',
  'function UNFINALIZED_REFUND_DELAY() view returns (uint32)',
  'function POST_FINALIZE_REFUND_DELAY() view returns (uint32)',
  'function claimAbandonedCommitBond(uint32 worldwideDay,address bidder)',
  'function claimRefund(uint32 worldwideDay,address bidder)',
]);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const operatorWallet = createWalletClient({ account: operatorAccount, transport: http(RPC_URL) });
if ((await publicClient.getChainId()) !== CHAIN_ID)
  throw new Error('Local control page only supports Anvil chain 31337.');

const stringify = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
const tx = async (address, abi, functionName, args = []) => {
  const hash = await operatorWallet.writeContract({ address, abi, functionName, args, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: TX_CONFIRM_TIMEOUT_MS,
    pollingInterval: 100,
  });
  if (receipt.status !== 'success') throw new Error(`${functionName} transaction reverted.`);
  return hash;
};

// Serialize mutating controls so concurrent scenario resets cannot corrupt the shared Anvil state.
const CONTROL_LOCK_PATH = resolve(LOCAL_ROOT, 'control.lock');
const CONTROL_LOCK_TIMEOUT_MS = 10_000;
const TX_CONFIRM_TIMEOUT_MS = 90_000;
const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const acquireControlLock = async () => {
  const deadline = Date.now() + CONTROL_LOCK_TIMEOUT_MS;
  while (true) {
    let stale = false;
    try {
      const holder = Number(await readFile(CONTROL_LOCK_PATH, 'utf8'));
      if (Number.isFinite(holder) && holder > 0 && holder !== process.pid && processAlive(holder)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Another local control command (PID ${holder}) is still running. Wait for it to finish before retrying; kill PID ${holder} only if it is genuinely stuck.`,
          );
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        continue;
      }
      stale = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stale) {
      try {
        await unlink(CONTROL_LOCK_PATH);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      await writeFile(CONTROL_LOCK_PATH, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
};
const releaseControlLock = async () => {
  try {
    if (Number(await readFile(CONTROL_LOCK_PATH, 'utf8')) === process.pid) await unlink(CONTROL_LOCK_PATH);
  } catch {
    /* best-effort cleanup — a stale lock is taken over by the liveness check */
  }
};
const safe = async (read, fallback = null) => {
  try {
    return await read();
  } catch {
    return fallback;
  }
};
const scenario = () => readJson(SCENARIO_PATH);
const worldwideDay = async () => Number((await scenario()).worldwideDay);
const auctionInfo = (day) =>
  publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [day],
  });
const targetStage = async (day) =>
  Number(
    await publicClient.readContract({
      address: deployment.intexAuction,
      abi: auctionAbi,
      functionName: 'getAuctionStage',
      args: [day],
    }),
  );
const globalStage = async (day) =>
  Number(
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getAuctionStage',
      args: [day],
    }),
  );
const mineAt = async (timestamp) => {
  const current = Number((await publicClient.getBlock()).timestamp);
  if (current > timestamp)
    throw new Error(`Cannot move local time backwards from ${current} to ${timestamp}. Reset the auction first.`);
  if (current === timestamp) return;
  await rpc('evm_setNextBlockTimestamp', [`0x${timestamp.toString(16)}`]);
  await rpc('evm_mine');
};
const runScenario = (name) => {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-scenario.mjs'), name],
    {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Failed to seed ${name}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
};

const fundTester = async () => {
  await rpc('anvil_setBalance', [TESTER_WALLET_ADDRESS, `0x${TESTER_NATIVE_BALANCE.toString(16)}`]);
  await tx(deployment.wcoen, localTokenAbi, 'mint', [TESTER_WALLET_ADDRESS, 200_000_000n * 10n ** 18n]);
};

const SEED_BIDDER_INDEX_BASE = 10;
const SEED_POOL_SIZE = 200;
const SEED_NATIVE_BALANCE = 10n * 10n ** 18n;
const seedAccount = (index) => mnemonicToAccount(MNEMONIC, { addressIndex: SEED_BIDDER_INDEX_BASE + index });
const seedWallet = (index) => createWalletClient({ account: seedAccount(index), transport: http(RPC_URL) });
const seedHash = (index) => BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [BigInt(index)])));
const seedBidValues = (index, auction) => {
  const hash = seedHash(index);
  const currencies = (auction.params.prices ?? []).map((price) => Number(price.isoCode));
  if (currencies.length === 0) throw new Error('Auction exposes no priced reference currencies.');
  const minQuantity = Math.max(1, Number(auction.params.minIntexBidQuantity));
  const minBidRate = Number(auction.params.minIntexBidRate);
  const quantity = Math.min(0xffff, minQuantity + Number((hash >> 8n) % 30n));
  const bidRate = Math.min(1_000_000, minBidRate + Number((hash >> 40n) % 350_000n));
  const issuanceCurrency = currencies[Number((hash >> 80n) % BigInt(currencies.length))];
  return { quantity, bidRate, issuanceCurrency };
};
const seedBidMaterial = async (index, day, auction) => {
  const account = seedAccount(index);
  const { quantity, bidRate, issuanceCurrency } = seedBidValues(index, auction);
  const referenceCurrency = Number(auction.params.prices?.[0]?.isoCode ?? auction.params.referenceCurrency);
  const signature = await account.signTypedData({
    domain: { name: 'IntexAuction', version: '1', chainId: CHAIN_ID, verifyingContract: deployment.intexAuction },
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
    message: { worldwideDay: day, bidder: account.address, quantity, bidRate, issuanceCurrency, referenceCurrency },
  });
  const lockAmount = escrowLockNative(quantity, auction.params.promisLoadMinor, bidRate);
  return {
    account,
    signature,
    commitHash: keccak256(signature),
    quantity,
    bidRate,
    issuanceCurrency,
    referenceCurrency,
    lockAmount,
  };
};
const seedWrite = async (index, address, abi, functionName, args) => {
  const hash = await seedWallet(index).writeContract({ address, abi, functionName, args, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: TX_CONFIRM_TIMEOUT_MS,
    pollingInterval: 100,
  });
  if (receipt.status !== 'success') throw new Error(`${functionName} transaction reverted.`);
  return receipt;
};
const fundSeedBidder = async (index, bond, lockAmount) => {
  const account = seedAccount(index);
  await rpc('anvil_setBalance', [account.address, `0x${SEED_NATIVE_BALANCE.toString(16)}`]);
  await tx(deployment.wcoen, localTokenAbi, 'mint', [account.address, bond + lockAmount + 10n ** 24n]);
  await seedWrite(index, deployment.wcoen, localTokenAbi, 'approve', [deployment.escrowAdapter, bond + lockAmount]);
};

const seedAuction = async (count) => {
  const day = await worldwideDay();
  const stage = await targetStage(day);
  const auction = await auctionInfo(day);
  const bond = auction.params.commitBondMinor;
  let done = 0;
  for (let index = 0; index < SEED_POOL_SIZE && done < count; index += 1) {
    const account = seedAccount(index);
    const [committed, revealed] = await Promise.all([
      publicClient.readContract({
        address: deployment.intexAuction,
        abi: auctionAbi,
        functionName: 'committedBidsByHash',
        args: [day, account.address],
      }),
      publicClient.readContract({
        address: deployment.intexAuction,
        abi: auctionAbi,
        functionName: 'revealedBidsByBidder',
        args: [day, account.address],
      }),
    ]);
    if (stage === 0) {
      if (committed !== zeroHash || revealed === true) continue;
      const material = await seedBidMaterial(index, day, auction);
      await fundSeedBidder(index, bond, material.lockAmount);
      await seedWrite(index, deployment.intexAuction, auctionAbi, 'commitBid', [day, material.commitHash]);
      done += 1;
    } else if (stage === 1) {
      if (committed === zeroHash || revealed === true) continue;
      const material = await seedBidMaterial(index, day, auction);
      await seedWrite(index, deployment.intexAuction, auctionAbi, 'revealBid', [
        day,
        material.quantity,
        material.bidRate,
        material.issuanceCurrency,
        material.referenceCurrency,
        BigInt(CHAIN_ID),
        material.signature,
      ]);
      done += 1;
    } else {
      throw new Error('Bid seeding requires the auction to be in the commit or reveal stage.');
    }
  }
  if (done === 0) throw new Error('No eligible synthetic bidders for the current auction stage.');
  return { day, stage, submitted: done };
};

const seriesIdBytes14 = (worldwideDay) => `0x${Number(worldwideDay).toString(16).padStart(28, '0')}`;
const referenceCurrency = (auction) =>
  Number(auction.params.prices?.[0]?.isoCode ?? auction.params.referenceCurrency ?? 840);
const priceRow = (auction, referenceIso) => {
  const row = (auction.params.prices ?? []).find((price) => Number(price.isoCode) === Number(referenceIso));
  if (!row) throw new Error(`Reference currency ${referenceIso} is not priced.`);
  return row;
};

const setCanonicalSeries = async (day, auction, issued, issuanceCurrency, state = 1, calledAt = 0) => {
  const block = await publicClient.getBlock();
  const row = priceRow(auction, referenceCurrency(auction));
  await tx(deployment.controller, controllerAbi, 'setSeries', [
    {
      seriesId: seriesIdBytes14(day),
      promisLoadMinor: auction.params.promisLoadMinor,
      entryPriceMinor: row.entryPriceMinor,
      floorPriceMinor: row.floorPriceMinor,
      issuedUnits: issued,
      callWindow: auction.params.callTrigger.callWindow,
      callThreshold: auction.params.callTrigger.callThreshold,
      callPriceMinor: row.callPriceMinor,
      state,
      issuedAt: Number(block.timestamp),
      calledAt,
      callNoticePeriod: auction.params.callTrigger.callNoticePeriod,
      issuanceCurrency,
      referenceCurrency: referenceCurrency(auction),
      worldwideDay: day,
      settledUnits: 0,
      exercisedUnits: 0,
      gemFactoryUnits: 0,
    },
  ]);
};

// Preview and completion use the same uniform-price allocation over delivered supply.
const computeClearing = async (day, supply) => {
  const auction = await auctionInfo(day);
  const details = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionDetails',
    args: [day],
  });
  const bids = details[1]
    .map((b) => ({
      bidder: b.bidderAddress,
      rate: Number(b.intexBidRate),
      quantity: Number(b.intexQuantity),
      issuanceCurrency: Number(b.issuanceCurrency),
      referenceCurrency: Number(b.referenceCurrency),
      timestamp: Number(b.timestamp),
    }))
    .sort((a, b) => b.rate - a.rate || a.timestamp - b.timestamp);
  if (bids.length === 0) throw new Error('No revealed bids to clear.');

  let remaining = supply;
  const rows = bids.map((bid) => {
    const won = Math.max(0, Math.min(bid.quantity, remaining));
    remaining -= won;
    return { ...bid, won };
  });
  const winners = rows.filter((row) => row.won > 0);
  if (winners.length === 0) throw new Error('No bid allocates against the offered supply.');
  const issued = winners.reduce((sum, row) => sum + row.won, 0);
  const clearingRate = winners.at(-1).rate;
  const totalDemand = bids.reduce((sum, bid) => sum + bid.quantity, 0);
  const unusedPromis = BigInt(Math.max(0, supply - issued)) * auction.params.promisLoadMinor;
  return { auction, bids, rows, winners, issued, clearingRate, totalDemand, unusedPromis, supply };
};

const completeSale = async (day, supply = 24) => {
  if ((await targetStage(day)) !== 2) throw new Error('Move the auction to clearing before completing issuance.');
  const { auction, rows, winners, issued, clearingRate, totalDemand, unusedPromis } = await computeClearing(
    day,
    supply,
  );

  if ((await globalStage(day)) !== 5) {
    await tx(deployment.controller, controllerAbi, 'recordGlobalClearing', [
      day,
      issued,
      clearingRate,
      BigInt(totalDemand),
      unusedPromis,
      unusedPromis > 0n,
    ]);
  }
  await tx(deployment.controller, controllerAbi, 'postAuctionResult', [
    CHAIN_ID,
    day,
    issued,
    BigInt(clearingRate),
    winners.length,
  ]);
  await setCanonicalSeries(day, auction, issued, winners[0].issuanceCurrency);

  const refunded = [];
  const paid = [];
  for (const row of rows) {
    const lock = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowAbi,
      functionName: 'getBidLock',
      args: [day, row.bidder],
    });
    const paidAmount = escrowLockNative(row.won, auction.params.promisLoadMinor, clearingRate);
    paid.push(paidAmount);
    refunded.push(lock.lockedAmount - paidAmount);
  }
  await tx(deployment.controller, controllerAbi, 'postRefundInstructions', [
    CHAIN_ID,
    day,
    0,
    1,
    rows.map((row) => row.bidder),
    refunded,
    paid,
  ]);

  const refRow = priceRow(auction, referenceCurrency(auction));
  for (const currency of [...new Set(winners.map((row) => row.issuanceCurrency))]) {
    const group = winners.filter((row) => row.issuanceCurrency === currency);
    const row = refRow;
    await tx(deployment.controller, controllerAbi, 'postIssuanceInstructions', [
      CHAIN_ID,
      [
        {
          seriesId: seriesIdBytes14(day),
          worldwideDay: day,
          issuedAt: Number(auction.schedule.revealEnd),
          issuedUnits: issued,
          promisLoadMinor: auction.params.promisLoadMinor,
          entryPriceMinor: row.entryPriceMinor,
          floorPriceMinor: row.floorPriceMinor,
          callNoticePeriod: auction.params.callTrigger.callNoticePeriod,
          issuanceCurrency: currency,
          referenceCurrency: referenceCurrency(auction),
          callWindow: auction.params.callTrigger.callWindow,
          callThreshold: auction.params.callTrigger.callThreshold,
          callPriceMinor: row.callPriceMinor,
          recipients: group.map((row) => row.bidder),
          quantities: group.map((row) => BigInt(row.won)),
        },
      ],
    ]);
  }
};

const completeNoSale = async (day) => {
  if ((await targetStage(day)) !== 2) throw new Error('Move the auction to clearing before posting a no-sale result.');
  const counts = await publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'auctionRunningCounts',
    args: [day],
  });
  if ((await globalStage(day)) !== 5) {
    await tx(deployment.controller, controllerAbi, 'recordGlobalClearing', [day, 0, 0, BigInt(counts[1]), 0n, false]);
  }
  await tx(deployment.controller, controllerAbi, 'postAuctionResult', [CHAIN_ID, day, 0, 0n, 0]);
  const lock = await publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getBidLock',
    args: [day, TESTER_WALLET_ADDRESS],
  });
  if (Number(lock.status) === 1 && lock.lockedAmount > 0n) {
    await tx(deployment.controller, controllerAbi, 'postRefundInstructions', [
      CHAIN_ID,
      day,
      0,
      1,
      [TESTER_WALLET_ADDRESS],
      [lock.lockedAmount],
      [0n],
    ]);
  }
};

const updateLifecycle = async (day, state) => {
  const seriesId = seriesIdBytes14(day);
  const exists = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'seriesExists',
    args: [seriesId],
  });
  if (!exists) throw new Error('No issued series exists for this auction.');
  const data = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'seriesData',
    args: [seriesId],
  });
  const calledAt = state === 3 ? Number((await publicClient.getBlock()).timestamp) : Number(data.calledAt);
  await tx(deployment.controller, controllerAbi, 'setSeries', [{ ...data, state, calledAt }]);
  await tx(deployment.controller, controllerAbi, state === 2 ? 'markQualified' : 'markCalled', [seriesId, day]);
};

const ORACLE_DEFAULT_RATES = [
  [840, 1_000_000_000_000_000_000n],
  [949, 15_000_000_000_000_000_000n],
  [978, 920_000_000_000_000_000n],
];
const setOracleRate = async (isoCode, rate) => {
  await tx(deployment.controller, controllerAbi, 'setOracleFixture', [
    COEN,
    quoteToken(isoCode),
    isoCode,
    rate,
    rate,
    Number((await publicClient.getBlock()).timestamp),
  ]);
};
const bumpOracleRate = async (isoCode, percent) => {
  const basis = Math.round(percent * 100);
  if (!Number.isFinite(basis) || Math.abs(basis) > 100_000) {
    throw new Error(`Invalid oracle increment: ${percent}%.`);
  }
  const current = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getCoenExchangeRateFor',
    args: [isoCode],
  });
  const next = (current * (10_000n + BigInt(basis))) / 10_000n;
  await setOracleRate(isoCode, next);
};
const resetOracle = async () => {
  await tx(deployment.controller, controllerAbi, 'setOracleFailure', [false]);
  for (const [isoCode, rate] of ORACLE_DEFAULT_RATES) {
    await tx(deployment.controller, controllerAbi, 'setOracleFixture', [
      COEN,
      quoteToken(isoCode),
      isoCode,
      rate,
      rate,
      Number((await publicClient.getBlock()).timestamp),
    ]);
  }
};

const isOracleWalkRunning = async () => {
  try {
    const state = await readJson(ANVIL_STATE_PATH);
    if (!state.oracleWalkPid) return false;
    process.kill(state.oracleWalkPid, 0);
    return true;
  } catch {
    return false;
  }
};

const status = async () => {
  const currentScenario = existsSync(SCENARIO_PATH) ? await scenario() : null;
  const day = currentScenario ? Number(currentScenario.worldwideDay) : null;
  const block = await publicClient.getBlock();
  const tokenBalance = await publicClient.readContract({
    address: deployment.wcoen,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [TESTER_WALLET_ADDRESS],
  });
  const allowance = await publicClient.readContract({
    address: deployment.wcoen,
    abi: tokenAbi,
    functionName: 'allowance',
    args: [TESTER_WALLET_ADDRESS, deployment.escrowAdapter],
  });
  const nativeBalance = await publicClient.getBalance({ address: TESTER_WALLET_ADDRESS });
  if (day === null)
    return {
      chain: { chainId: CHAIN_ID, blockNumber: block.number, timestamp: block.timestamp },
      tester: { address: TESTER_WALLET_ADDRESS, native: formatEther(nativeBalance), wcoen: tokenBalance, allowance },
      oracle: { walkRunning: await isOracleWalkRunning() },
      scenario: null,
    };

  const [
    auction,
    target,
    global,
    counts,
    commitHash,
    revealed,
    bond,
    lock,
    escrow,
    worldwideDayRead,
    seriesIds,
    owned,
    oracleFailure,
    oraclePairs,
    usdRate,
    tryRate,
    eurRate,
  ] = await Promise.all([
    safe(() => auctionInfo(day)),
    safe(() => targetStage(day)),
    safe(() => globalStage(day)),
    safe(() =>
      publicClient.readContract({
        address: deployment.intexAuction,
        abi: auctionAbi,
        functionName: 'auctionRunningCounts',
        args: [day],
      }),
    ),
    safe(
      () =>
        publicClient.readContract({
          address: deployment.intexAuction,
          abi: auctionAbi,
          functionName: 'committedBidsByHash',
          args: [day, TESTER_WALLET_ADDRESS],
        }),
      zeroHash,
    ),
    safe(
      () =>
        publicClient.readContract({
          address: deployment.intexAuction,
          abi: auctionAbi,
          functionName: 'revealedBidsByBidder',
          args: [day, TESTER_WALLET_ADDRESS],
        }),
      false,
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.escrowAdapter,
        abi: escrowAbi,
        functionName: 'getCommitBond',
        args: [day, TESTER_WALLET_ADDRESS],
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.escrowAdapter,
        abi: escrowAbi,
        functionName: 'getBidLock',
        args: [day, TESTER_WALLET_ADDRESS],
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.escrowAdapter,
        abi: escrowAbi,
        functionName: 'auctionEscrowState',
        args: [day],
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'getWorldwideDay',
        args: [day],
      }),
    ),
    safe(
      () =>
        publicClient.readContract({
          address: deployment.intexNFT1155,
          abi: nftAbi,
          functionName: 'seriesIdsByWorldwideDay',
          args: [day],
        }),
      [],
    ),
    safe(async () => {
      // getOwnedSeriesWithBalancesPaginated was removed upstream with no successor. Read the
      // tester's issued balance per series of the day via ownerBalances(seriesId, owner).
      const daySeries = await publicClient.readContract({
        address: deployment.intexNFT1155,
        abi: nftAbi,
        functionName: 'seriesIdsByWorldwideDay',
        args: [day],
      });
      const balances = await Promise.all(
        daySeries.map((seriesId) =>
          publicClient.readContract({
            address: deployment.intexNFT1155,
            abi: nftAbi,
            functionName: 'ownerBalances',
            args: [seriesId, TESTER_WALLET_ADDRESS],
          }),
        ),
      );
      return [daySeries, balances];
    }),
    safe(
      () =>
        publicClient.readContract({
          address: deployment.controller,
          abi: controllerAbi,
          functionName: 'oracleFailure',
        }),
      true,
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'getReferenceCurrencies',
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'getExchangeRateData',
        args: [COEN, quoteToken(840)],
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'getExchangeRateData',
        args: [COEN, quoteToken(949)],
      }),
    ),
    safe(() =>
      publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'getExchangeRateData',
        args: [COEN, quoteToken(978)],
      }),
    ),
  ]);
  const [unrevealedBondDelay, abandonedBondDelay, unfinalizedRefundDelay, postFinalizeRefundDelay] = auction
    ? await Promise.all([
        publicClient.readContract({
          address: deployment.intexAuction,
          abi: bondAbi,
          functionName: 'UNREVEALED_BOND_LOCK_PERIOD',
        }),
        publicClient.readContract({
          address: deployment.escrowAdapter,
          abi: escrowClaimAbi,
          functionName: 'COMMIT_BOND_ABANDON_DELAY',
        }),
        publicClient.readContract({
          address: deployment.escrowAdapter,
          abi: escrowClaimAbi,
          functionName: 'UNFINALIZED_REFUND_DELAY',
        }),
        publicClient.readContract({
          address: deployment.escrowAdapter,
          abi: escrowClaimAbi,
          functionName: 'POST_FINALIZE_REFUND_DELAY',
        }),
      ])
    : [0n, 0n, 0n, 0n];
  const recoveryTimes = deriveRecoveryTimes({
    auction,
    bond,
    lock,
    escrow,
    revealed,
    unrevealedBondDelay,
    abandonedBondDelay,
    unfinalizedRefundDelay,
    postFinalizeRefundDelay,
  });
  const canonicalSeries = await safe(async () => {
    const seriesId = seriesIdBytes14(day);
    if (
      !(await publicClient.readContract({
        address: deployment.controller,
        abi: controllerAbi,
        functionName: 'seriesExists',
        args: [seriesId],
      }))
    )
      return null;
    return publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'seriesData',
      args: [seriesId],
    });
  });
  return {
    chain: { chainId: CHAIN_ID, blockNumber: block.number, timestamp: block.timestamp },
    scenario: { name: currentScenario.name, worldwideDay: day },
    tester: {
      address: TESTER_WALLET_ADDRESS,
      native: formatEther(nativeBalance),
      wcoen: tokenBalance,
      allowance,
      commitHash,
      revealed,
      commitBond: bond,
      bidLock: lock,
      ...recoveryTimes,
    },
    oracle: {
      available: !oracleFailure,
      pairs: oraclePairs,
      rates: { USD: usdRate, TRY: tryRate, EUR: eurRate },
      walkRunning: await isOracleWalkRunning(),
    },
    protocol: {
      worldwideDay: worldwideDayRead,
      globalStage: global,
      targetStage: target,
      schedule: auction?.schedule ?? null,
      parameters: auction?.params ?? null,
      result: auction?.result ?? null,
      runningCounts: counts,
      escrow,
      canonicalSeries,
      targetSeriesIds: seriesIds,
      ownedTokenIds: owned?.[0] ?? [],
      ownedBalances: owned?.[1] ?? [],
    },
  };
};

if (command !== 'status') await acquireControlLock();
try {
  if (command === 'reset') runScenario('commit-open');
  if (command === 'red-day') runScenario('completed-red');
  if (command === 'past-auctions') runScenario('past-auctions');
  if (command === 'fund') await fundTester();
  if (command === 'seed-bid') await seedAuction(1);
  if (command === 'seed-bids') {
    const count = Number.isFinite(seedRequested) && seedRequested > 0 ? Math.min(seedRequested, SEED_POOL_SIZE) : 10;
    await seedAuction(count);
  }
  if (command === 'reveal') {
    const day = await worldwideDay();
    if ((await targetStage(day)) !== 0) throw new Error('Auction is not in the commit stage.');
    const auction = await auctionInfo(day);
    await mineAt(Number(auction.schedule.commitEnd));
    await tx(deployment.controller, controllerAbi, 'setGlobalAuctionStage', [day, 3]);
  }
  if (command === 'clearing') {
    const day = await worldwideDay();
    if ((await targetStage(day)) !== 1) throw new Error('Auction is not in the reveal stage.');
    const auction = await auctionInfo(day);
    await mineAt(Number(auction.schedule.revealEnd) + 1);
    await tx(deployment.controller, controllerAbi, 'startClearing', [day]);
  }
  if (command === 'complete-sale')
    await completeSale(
      await worldwideDay(),
      Number.isFinite(seedRequested) && seedRequested > 0 ? Math.min(seedRequested, 100_000) : 24,
    );
  if (command === 'no-sale') await completeNoSale(await worldwideDay());
  if (command === 'preview') {
    const day = await worldwideDay();
    const supply = Number.isFinite(seedRequested) && seedRequested > 0 ? Math.min(seedRequested, 100_000) : 24;
    const { rows, winners, issued, clearingRate, totalDemand, unusedPromis } = await computeClearing(day, supply);
    console.log(
      stringify({
        supply,
        clearingRate,
        issuedIntexCount: issued,
        wonBidsCount: winners.length,
        totalDemand,
        unusedPromis: unusedPromis.toString(),
        rows,
      }),
    );
  }
  if (command === 'advance-bond') {
    const day = await worldwideDay();
    const auction = await auctionInfo(day);
    const period = await publicClient.readContract({
      address: deployment.intexAuction,
      abi: bondAbi,
      functionName: 'UNREVEALED_BOND_LOCK_PERIOD',
    });
    await mineAt(Number(auction.schedule.revealEnd) + Number(period));
  }
  if (command === 'claim-bond')
    await tx(deployment.intexAuction, bondAbi, 'claimCommitBond', [await worldwideDay(), TESTER_WALLET_ADDRESS]);
  if (command === 'qualify') await updateLifecycle(await worldwideDay(), 2);
  if (command === 'call') await updateLifecycle(await worldwideDay(), 3);
  if (command === 'advance-abandoned-bond') {
    const day = await worldwideDay();
    const bond = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowAbi,
      functionName: 'getCommitBond',
      args: [day, TESTER_WALLET_ADDRESS],
    });
    if (bond.amount === 0n) throw new Error('No commit bond to advance.');
    const delay = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowClaimAbi,
      functionName: 'COMMIT_BOND_ABANDON_DELAY',
    });
    await mineAt(Number(bond.lockedAt) + Number(delay));
  }
  if (command === 'claim-abandoned-bond') {
    await tx(deployment.escrowAdapter, escrowClaimAbi, 'claimAbandonedCommitBond', [
      await worldwideDay(),
      TESTER_WALLET_ADDRESS,
    ]);
  }
  if (command === 'advance-refund') {
    const day = await worldwideDay();
    const lock = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowAbi,
      functionName: 'getBidLock',
      args: [day, TESTER_WALLET_ADDRESS],
    });
    if (lock.lockedAmount === 0n) throw new Error('No bid lock to advance.');
    const escrowState = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowAbi,
      functionName: 'auctionEscrowState',
      args: [day],
    });
    const unfinalizedDelay = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowClaimAbi,
      functionName: 'UNFINALIZED_REFUND_DELAY',
    });
    const postFinalizeDelay = await publicClient.readContract({
      address: deployment.escrowAdapter,
      abi: escrowClaimAbi,
      functionName: 'POST_FINALIZE_REFUND_DELAY',
    });
    let targetTime;
    if (!escrowState.finalized) {
      targetTime = Number(lock.lockedAt) + Number(unfinalizedDelay);
    } else {
      // Post-finalize claimRefund gates both the split-recorded and no-split cases on
      // finalizedAt + POST_FINALIZE_REFUND_DELAY (EscrowAdapter.claimRefund).
      targetTime = Number(escrowState.finalizedAt) + Number(postFinalizeDelay);
    }
    await mineAt(targetTime);
  }
  if (command === 'claim-refund') {
    await tx(deployment.escrowAdapter, escrowClaimAbi, 'claimRefund', [await worldwideDay(), TESTER_WALLET_ADDRESS]);
  }
  if (command === 'oracle-defaults') await resetOracle();
  if (command === 'oracle-up') {
    const isoCode = Number(process.argv[3]);
    const percent = Number(process.argv[4]);
    if (!Number.isInteger(isoCode) || isoCode <= 0 || !Number.isFinite(percent)) {
      throw new Error(
        'oracle-up requires an ISO code and a signed percent, e.g. `oracle-up 949 10` or `oracle-up 840 -2.5`.',
      );
    }
    await bumpOracleRate(isoCode, percent);
  }
  if (command === 'oracle-usd-up') await bumpOracleRate(840, 5);
  if (command === 'oracle-try-up') await bumpOracleRate(949, 5);
  if (command === 'oracle-eur-up') await bumpOracleRate(978, 5);
  if (command === 'oracle-stale') {
    const stale = Number((await publicClient.getBlock()).timestamp) - 7 * 86_400;
    await tx(deployment.controller, controllerAbi, 'setOracleFixture', [
      COEN,
      quoteToken(949),
      949,
      15_000_000_000_000_000_000n,
      15_000_000_000_000_000_000n,
      stale,
    ]);
  }
  if (command === 'oracle-try-inactive') {
    await tx(deployment.controller, controllerAbi, 'setOracleFixture', [
      COEN,
      quoteToken(949),
      949,
      15_000_000_000_000_000_000n,
      15_000_000_000_000_000_000n,
      Number((await publicClient.getBlock()).timestamp),
    ]);
    await tx(deployment.controller, controllerAbi, 'setOraclePairActive', [COEN, quoteToken(949), false]);
  }
  if (command === 'oracle-available') await tx(deployment.controller, controllerAbi, 'setOracleFailure', [false]);
  if (command === 'oracle-unavailable') await tx(deployment.controller, controllerAbi, 'setOracleFailure', [true]);

  const processAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (command === 'oracle-walk-start') {
    const state = await readJson(ANVIL_STATE_PATH);
    if (state.oracleWalkPid && processAlive(state.oracleWalkPid)) {
    } else {
      const logFd = openSync(resolve(LOCAL_ROOT, 'oracle-walk.log'), 'a');
      const child = spawn(
        process.execPath,
        [resolve(ROOT, 'dev/local-chain/scripts/local/commands/local-oracle-walk.mjs')],
        {
          cwd: ROOT,
          stdio: ['ignore', logFd, logFd],
          detached: true,
        },
      );
      child.unref();
      closeSync(logFd);
      state.oracleWalkPid = child.pid;
      await writeJson(ANVIL_STATE_PATH, state);
    }
  }
  if (command === 'oracle-walk-stop') {
    const state = await readJson(ANVIL_STATE_PATH);
    if (state.oracleWalkPid && processAlive(state.oracleWalkPid)) {
      process.kill(state.oracleWalkPid, 'SIGTERM');
    }
    state.oracleWalkPid = null;
    await writeJson(ANVIL_STATE_PATH, state);
  }

  if (command !== 'preview') console.log(stringify(await status()));
} finally {
  if (command !== 'status') await releaseControlLock();
}
