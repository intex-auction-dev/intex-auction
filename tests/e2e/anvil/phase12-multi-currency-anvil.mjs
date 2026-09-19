import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, parseAbi } from 'viem';
import {
  backgroundBidderAccount,
  bidderAccount,
  CHAIN_ID,
  DEPLOYMENT_PATH,
  LOCAL_CONFIG_ROOT,
  operatorAccount,
  RPC_URL,
  SCENARIO_PATH,
} from '../../../dev/local-chain/scripts/local/infrastructure/constants.mjs';
import { readJson } from '../../../dev/local-chain/scripts/local/infrastructure/config.mjs';
import { rpc } from '../../../dev/local-chain/scripts/local/infrastructure/rpc.mjs';

const RATE_SCALE = 1_000_000n;
// IntexAuction.sol:39,403-405 -- the escrow lock is native-18 WCOEN from the 1e6 protocol basis,
// and the divide by RATE_SCALE precedes the native-units multiply.
const NATIVE_UNITS_PER_PROTOCOL_UNIT = 1_000_000_000_000n;
const TRY = 949;
const EUR = 978;
// The auction's `prices` array is ReferenceCurrencyPrice[]: "one row per currency the day can
// clear in; the bid's reference currency must appear here" (IIntexAuction.sol AuctionParams).
// The local venue seeds six of them from `referenceRateCentis` in
// dev/local-chain/scripts/local/commands/local-scenario.mjs.
//
// This is a different catalogue from the oracle's reference currencies, asserted separately
// further down as 840,949,978. TRY is an oracle and issuance currency; it is deliberately not
// an auction-enabled reference currency, so it never has an auction price row.
const AUCTION_REFERENCE_CURRENCIES = [840, EUR, 826, 156, 392, 344];
// The oracle quotes COEN against one more currency than the auction can clear in: it also
// carries TRY (DeployLocal.s.sol publishes a COEN/TRY rate). TRY is an oracle and issuance
// currency; it is deliberately not auction-enabled, which the invariant below pins.
const ORACLE_REFERENCE_CURRENCIES = [840, TRY, EUR, 826, 156, 392, 344];
const REFERENCE_CURRENCY = 840;
const sid = (value) => `0x${value.toString(16).padStart(28, '0')}`;
const TRY_SERIES = sid(100_000_001);
const EUR_SERIES = sid(100_000_002);

const deployment = await readJson(DEPLOYMENT_PATH);
const scenario = await readJson(SCENARIO_PATH);
const auctionAbi = JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexAuction.json'), 'utf8'));
const escrowAbi = JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi/EscrowAdapter.json'), 'utf8'));
const nftAbi = JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi/IntexNFT1155.json'), 'utf8'));
const oracleAbi = JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi/IOracle.json'), 'utf8'));
const tokenAbi = JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi/ERC20.json'), 'utf8'));
const targetRouterAbi = parseAbi([
  'function bidsRelay(uint32 worldwideDay) view returns (uint16 nextBatch,uint16 totalBatches,bool done)',
  'function relayBids(uint32 worldwideDay)',
]);
const controllerAbi = parseAbi([
  'function setGlobalAuctionStage(uint32 worldwideDay,uint8 stage)',
  'function startClearing(uint32 worldwideDay)',
  'function recordGlobalClearing(uint32 worldwideDay,uint32 issuedIntexCount,uint32 clearingRate,uint64 totalDemand,uint256 unusedPromis,bool reportUnused)',
  'function postAuctionResult(uint32 dstChainId,uint32 worldwideDay,uint32 issuedIntexCount,uint64 auctionClearingRate,uint32 wonBidsCount)',
  'function postRefundInstructions(uint32 dstChainId,uint32 worldwideDay,uint16 chunkIndex,uint16 totalChunks,address[] bidderAddresses,uint128[] refundedAmounts,uint128[] paidAmounts)',
  'function postIssuanceInstructions(uint32 dstChainId,(bytes14 seriesId,uint32 worldwideDay,uint32 issuedAt,uint32 issuedUnits,uint128 promisLoadMinor,uint64 entryPriceMinor,uint64 floorPriceMinor,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 callWindow,uint32 callThreshold,uint64 callPriceMinor,address[] recipients,uint256[] quantities)[] series)',
  'function setSeries((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits) data)',
  'function currencies(uint256 index) view returns (uint16)',
  'function bidsCount() view returns (uint256)',
  'function getBidsCount(uint32 worldwideDay) view returns (uint32)',
  'function proceedsValue() view returns (uint256)',
  'function proceedsCalls() view returns (uint256)',
]);

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const operator = createWalletClient({ account: operatorAccount, transport: http(RPC_URL) });
const tryWallet = createWalletClient({ account: bidderAccount, transport: http(RPC_URL) });
const eurWallet = createWalletClient({ account: backgroundBidderAccount, transport: http(RPC_URL) });
const day = Number(scenario.worldwideDay);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const write = async (wallet, address, abi, functionName, args = []) => {
  try {
    const hash = await wallet.writeContract({ address, abi, functionName, args, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted.`);
    return receipt;
  } catch (error) {
    throw new Error(
      `${functionName} failed for ${JSON.stringify(args, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}.`,
      { cause: error },
    );
  }
};
const mineAt = async (timestamp) => {
  const current = Number((await publicClient.getBlock()).timestamp);
  if (current > timestamp) throw new Error(`Cannot move local time backwards from ${current} to ${timestamp}.`);
  if (current < timestamp) {
    await rpc('evm_setNextBlockTimestamp', [`0x${timestamp.toString(16)}`]);
    await rpc('evm_mine');
  }
};
const material = async (account, issuanceCurrency, bidRate) => {
  const quantity = 1;
  const referenceCurrency = REFERENCE_CURRENCY;
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
    message: { worldwideDay: day, bidder: account.address, quantity, bidRate, issuanceCurrency, referenceCurrency },
  });
  return {
    account,
    issuanceCurrency,
    referenceCurrency,
    quantity,
    bidRate,
    signature,
    commitHash: keccak256(signature),
  };
};

assert((await publicClient.getChainId()) === CHAIN_ID, 'Wrong local chain.');
const auction = await publicClient.readContract({
  address: deployment.intexAuction,
  abi: auctionAbi,
  functionName: 'getAuctionInfo',
  args: [day],
});
const priceRows = (auction.params.prices ?? []).map((price) => Number(price.isoCode));
assert(
  priceRows.join(',') === AUCTION_REFERENCE_CURRENCIES.join(','),
  'Auction-enabled reference currencies are not the reviewed local set.',
);

const tryBid = await material(bidderAccount, TRY, 900_000);
const eurBid = await material(backgroundBidderAccount, EUR, 800_000);
for (const [wallet, bid] of [
  [tryWallet, tryBid],
  [eurWallet, eurBid],
]) {
  const lock =
    ((BigInt(bid.quantity) * auction.params.promisLoadMinor * BigInt(bid.bidRate)) / RATE_SCALE) *
    NATIVE_UNITS_PER_PROTOCOL_UNIT;
  await write(wallet, deployment.wcoen, tokenAbi, 'approve', [
    deployment.escrowAdapter,
    auction.params.commitBondMinor + lock,
  ]);
  await write(wallet, deployment.intexAuction, auctionAbi, 'commitBid', [day, bid.commitHash]);
}

await mineAt(Number(auction.schedule.commitEnd) + 1);
await write(operator, deployment.controller, controllerAbi, 'setGlobalAuctionStage', [day, 3]);
for (const [wallet, bid] of [
  [tryWallet, tryBid],
  [eurWallet, eurBid],
]) {
  await write(wallet, deployment.intexAuction, auctionAbi, 'revealBid', [
    day,
    bid.quantity,
    bid.bidRate,
    bid.issuanceCurrency,
    bid.referenceCurrency,
    BigInt(CHAIN_ID),
    bid.signature,
  ]);
}

await mineAt(Number(auction.schedule.revealEnd) + 1);
await write(operator, deployment.controller, controllerAbi, 'startClearing', [day]);
// Upstream now carries the bids relay only as far as the CLEARING delivery's gas float allows and
// exposes `relayBids(worldwideDay)` as a permissionless push for a relay that ran dry
// (TargetRouter.sol:263). The single-chain local harness has no keeper, so drive it here until the
// day reports done; without this the relay never leaves batch 0 and no bids reach Outbe.
for (let round = 0; round < 8; round += 1) {
  const relay = await publicClient.readContract({
    address: deployment.targetRouter,
    abi: targetRouterAbi,
    functionName: 'bidsRelay',
    args: [day],
  });
  if (relay[2]) break;
  await write(operator, deployment.targetRouter, targetRouterAbi, 'relayBids', [day]);
}
// bidsCount() is the mock controller's cumulative `bidders.length` across every relay, so it
// also counts the bids the seeded scenario created. Assert the per-day counter instead, and read
// this day's currencies off the tail of the cumulative arrays.
assert(
  Number(
    await publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'getBidsCount',
      args: [day],
    }),
  ) === 2,
  'V2 bridge did not relay both revealed bids.',
);
const relayedTotal = await publicClient.readContract({
  address: deployment.controller,
  abi: controllerAbi,
  functionName: 'bidsCount',
});
const relayedCurrencies = await Promise.all(
  [relayedTotal - 2n, relayedTotal - 1n].map((index) =>
    publicClient.readContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'currencies',
      args: [index],
    }),
  ),
);
assert(
  JSON.stringify(relayedCurrencies.map(Number).sort((a, b) => a - b)) ===
    JSON.stringify([TRY, EUR].sort((a, b) => a - b)),
  'V2 bridge did not preserve TRY and EUR.',
);

const clearingRate = 800_000;
await write(operator, deployment.controller, controllerAbi, 'recordGlobalClearing', [
  day,
  2,
  clearingRate,
  2n,
  0n,
  false,
]);
await write(operator, deployment.controller, controllerAbi, 'postAuctionResult', [
  CHAIN_ID,
  day,
  2,
  BigInt(clearingRate),
  2,
]);

const tryLock = await publicClient.readContract({
  address: deployment.escrowAdapter,
  abi: escrowAbi,
  functionName: 'getBidLock',
  args: [day, bidderAccount.address],
});
const eurLock = await publicClient.readContract({
  address: deployment.escrowAdapter,
  abi: escrowAbi,
  functionName: 'getBidLock',
  args: [day, backgroundBidderAccount.address],
});
const paidPerWinner =
  ((auction.params.promisLoadMinor * BigInt(clearingRate)) / RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
await write(operator, deployment.controller, controllerAbi, 'postRefundInstructions', [
  CHAIN_ID,
  day,
  0,
  1,
  [bidderAccount.address, backgroundBidderAccount.address],
  [tryLock.lockedAmount - paidPerWinner, eurLock.lockedAmount - paidPerWinner],
  [paidPerWinner, paidPerWinner],
]);

const issuedAt = Number((await publicClient.getBlock()).timestamp);
// Terms come from the row for the series' reference currency. Looking a row up by issuance
// currency only worked while the seeded reference set happened to contain the issuance codes.
const referencePriceRow = (referenceCurrency) => {
  const row = (auction.params.prices ?? []).find((price) => Number(price.isoCode) === Number(referenceCurrency));
  if (!row) throw new Error(`Missing auction reference-currency terms for ${referenceCurrency}.`);
  return row;
};
const issue = async (seriesId, issuanceCurrency, recipient) => {
  const row = referencePriceRow(REFERENCE_CURRENCY);
  const series = {
    seriesId,
    promisLoadMinor: auction.params.promisLoadMinor,
    entryPriceMinor: row.entryPriceMinor,
    floorPriceMinor: row.floorPriceMinor,
    issuedUnits: 1,
    callWindow: auction.params.callTrigger.callWindow,
    callThreshold: auction.params.callTrigger.callThreshold,
    callPriceMinor: row.callPriceMinor,
    state: 1,
    issuedAt,
    calledAt: 0,
    callNoticePeriod: auction.params.callTrigger.callNoticePeriod,
    issuanceCurrency,
    referenceCurrency: REFERENCE_CURRENCY,
    worldwideDay: day,
    settledUnits: 0,
    exercisedUnits: 0,
    gemFactoryUnits: 0,
  };
  await write(operator, deployment.controller, controllerAbi, 'setSeries', [series]);
  await write(operator, deployment.controller, controllerAbi, 'postIssuanceInstructions', [
    CHAIN_ID,
    [
      {
        seriesId,
        worldwideDay: day,
        issuedAt,
        issuedUnits: 1,
        promisLoadMinor: auction.params.promisLoadMinor,
        entryPriceMinor: row.entryPriceMinor,
        floorPriceMinor: row.floorPriceMinor,
        callNoticePeriod: auction.params.callTrigger.callNoticePeriod,
        issuanceCurrency,
        referenceCurrency: REFERENCE_CURRENCY,
        callWindow: auction.params.callTrigger.callWindow,
        callThreshold: auction.params.callTrigger.callThreshold,
        callPriceMinor: row.callPriceMinor,
        recipients: [recipient],
        quantities: [1n],
      },
    ],
  ]);
};
await issue(TRY_SERIES, TRY, bidderAccount.address);
await issue(EUR_SERIES, EUR, backgroundBidderAccount.address);

const [daySeries, tryData, eurData, tryBalances, eurBalances] = await Promise.all([
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'seriesIdsByWorldwideDay',
    args: [day],
  }),
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'readData',
    args: [TRY_SERIES],
  }),
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'readData',
    args: [EUR_SERIES],
  }),
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'ownerBalances',
    args: [TRY_SERIES, bidderAccount.address],
  }),
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'ownerBalances',
    args: [EUR_SERIES, backgroundBidderAccount.address],
  }),
]);
assert(
  daySeries.includes(TRY_SERIES) && daySeries.includes(EUR_SERIES),
  'WorldwideDay does not enumerate both issued series.',
);
assert(
  Number(tryData.issuanceCurrency) === TRY && Number(eurData.issuanceCurrency) === EUR,
  'Issued series currencies are incorrect.',
);
assert(
  Number(tryData.worldwideDay) === day && Number(eurData.worldwideDay) === day,
  'Issued series lost WorldwideDay provenance.',
);
const referenceRow = referencePriceRow(REFERENCE_CURRENCY);
assert(
  tryData.callPriceMinor === referenceRow.callPriceMinor && eurData.callPriceMinor === referenceRow.callPriceMinor,
  'Issued series lost contract-authoritative strike amounts.',
);
const tryIssued = tryBalances.issued ?? tryBalances[0];
const eurIssued = eurBalances.issued ?? eurBalances[0];
assert(
  BigInt(tryIssued) === 1n && BigInt(eurIssued) === 1n,
  `Winning recipients did not receive their currency series (${tryIssued}/${eurIssued}).`,
);

const [settlementCurrencies, usdRate, tryRate, eurRate] = await Promise.all([
  publicClient.readContract({ address: deployment.controller, abi: oracleAbi, functionName: 'getReferenceCurrencies' }),
  publicClient.readContract({
    address: deployment.controller,
    abi: oracleAbi,
    functionName: 'getCoenExchangeRateFor',
    args: [840],
  }),
  publicClient.readContract({
    address: deployment.controller,
    abi: oracleAbi,
    functionName: 'getCoenExchangeRateFor',
    args: [TRY],
  }),
  publicClient.readContract({
    address: deployment.controller,
    abi: oracleAbi,
    functionName: 'getCoenExchangeRateFor',
    args: [EUR],
  }),
]);
assert(
  settlementCurrencies.map(Number).join(',') === ORACLE_REFERENCE_CURRENCIES.join(','),
  'Oracle reference-currency catalogue is incorrect.',
);
assert(!AUCTION_REFERENCE_CURRENCIES.includes(TRY), 'TRY must not be an auction-enabled reference currency.');
assert(
  ORACLE_REFERENCE_CURRENCIES.filter((iso) => iso !== TRY).join(',') === AUCTION_REFERENCE_CURRENCIES.join(','),
  'The auction reference set must be the oracle catalogue minus TRY.',
);
assert(usdRate > 0n && tryRate > 0n && eurRate > 0n, 'Oracle conversion evidence is unavailable.');
assert(
  BigInt(tryIssued) === 1n && BigInt(eurIssued) === 1n,
  'Winning recipients did not receive their currency series.',
);

console.log(
  JSON.stringify(
    {
      worldwideDay: day,
      series: [
        { seriesId: TRY_SERIES, issuanceCurrency: TRY, recipient: bidderAccount.address },
        { seriesId: EUR_SERIES, issuanceCurrency: EUR, recipient: backgroundBidderAccount.address },
      ],
      oracleReferenceCurrencies: settlementCurrencies.map(Number),
    },
    null,
    2,
  ),
);
