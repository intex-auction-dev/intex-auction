import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const readText = (path) => readFile(resolve(ROOT, path), 'utf8');
const readAbi = async (path) => JSON.parse(await readText(path));

const canonicalType = (input) => {
  if (!input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  return `(${(input.components ?? []).map(canonicalType).join(',')})${suffix}`;
};

const signatureOf = (item) => `${item.name}(${(item.inputs ?? []).map(canonicalType).join(',')})`;

const checks = [
  {
    abi: 'config/abi/IMetadosis.json',
    source: 'blockchain/outbe-chain/contracts/precompiles/src/IMetadosis.sol',
    functions: [
      'getWorldwideDay(uint32)',
      'getActiveWorldwideDays()',
      'getWorldwideDaysByStatus(uint8)',
      'getBootstrapEndTime()',
      'getWorldwideDayTerminalReceipt(uint32)',
      'getCapacityForfeitureReceipt(uint32)',
    ],
    events: ['WorldwideDayCleanedUp(uint32,uint8)'],
  },
  {
    abi: 'config/abi/IDesis.json',
    source: 'blockchain/outbe-chain/contracts/precompiles/src/IDesis.sol',
    functions: [
      'getAuctionStage(uint32)',
      'getBidsCount(uint32)',
      'getChainBidsCount(uint32,uint32)',
      'isChainDone(uint32,uint32)',
    ],
    events: [
      'ChainSkipped(uint32,uint32)',
      'AuctionCleared(uint32,uint32,uint32,uint64)',
      'AuctionClearedEmpty(uint32,uint64)',
      'UnusedSupplyReported(uint32,uint256)',
    ],
  },
  {
    abi: 'config/abi/OriginRouter.json',
    source: 'blockchain/outbe-chain/contracts/intex/src/origin/interfaces/IOriginRouter.sol',
    functions: ['targetsOf(uint32)', 'parkedSend(uint256)', 'parkedProceeds(uint256)'],
    events: [
      'BidsDoneReceived(uint32,uint32,uint16,uint32)',
      'SendParked(uint256,uint32,uint8)',
      'PendingSendFlushed(uint256,uint32,bytes32)',
    ],
  },
  {
    abi: 'config/abi/IOracle.json',
    source: 'blockchain/outbe-chain/contracts/precompiles/src/IOracle.sol',
    functions: [
      'getExchangeRate(address,address)',
      'getCurrencyRate(uint16)',
      'getCoenExchangeRateFor(uint16)',
      'getPriceSnapshotHistory(address,address,uint32)',
      'getDayVwap(address,address)',
      'getUtcDayVwap(address,address,uint32)',
      'getWorldwideDayVwapSnapshot(uint32)',
      'getReferenceCurrencies()',
    ],
    events: ['VwapCalculated(uint32,address,address,uint256)'],
  },
  {
    abi: 'config/abi/IIntex.json',
    source: 'blockchain/outbe-chain/contracts/precompiles/src/IIntex.sol',
    functions: ['seriesData(bytes14)', 'seriesExists(bytes14)', 'totalSeries()', 'seriesAt(uint64)'],
    events: ['CertifiedContributorRootInstalled(bytes32,uint32,uint64,uint64,uint32,bytes32,uint256,bytes32)'],
  },
  {
    abi: 'config/abi/TargetRouter.json',
    source: 'blockchain/outbe-chain/contracts/intex/src/target/interfaces/ITargetRouter.sol',
    functions: [],
    events: [
      'BidsDoneSent(bytes32,uint32,uint16,uint32)',
      'IssuanceMintDeferred(uint256,bytes14,address,bytes)',
      'IssuanceMintFlushed(uint256,bytes14)',
    ],
  },
  {
    abi: 'config/abi/EscrowAdapter.json',
    source: 'blockchain/outbe-chain/contracts/intex/src/target/interfaces/IEscrowAdapter.sol',
    functions: [],
    events: [
      'BidderRefundFailed(bytes32,uint32,address,bytes)',
      'BidderRetried(bytes32,uint32,address,uint128,uint128)',
      'FinalizationNoOp(uint32,uint32)',
    ],
  },
];

for (const check of checks) {
  const [abi, source] = await Promise.all([readAbi(check.abi), readText(check.source)]);
  const normalizedSource = source.replace(/\s+/g, ' ');

  for (const [type, signatures] of [
    ['function', check.functions],
    ['event', check.events],
  ]) {
    for (const signature of signatures) {
      const name = signature.slice(0, signature.indexOf('('));
      assert.match(
        normalizedSource,
        new RegExp(`\\b${type}\\s+${name}\\s*\\(`),
        `${check.source} lacks ${type} ${name}`,
      );
      assert.ok(
        abi.some((item) => item.type === type && signatureOf(item) === signature),
        `${check.abi} lacks ${type} ${signature}`,
      );
    }
  }
}

const nftAbi = await readAbi('config/abi/IntexNFT1155.json');
for (const signature of [
  'getSeriesPaginated(uint256,uint256)',
  'getOwnedSeriesWithBalancesPaginated(address,uint256,uint256)',
]) {
  assert.ok(
    nftAbi.some((item) => item.type === 'function' && signatureOf(item) === signature),
    `config/abi/IntexNFT1155.json lacks function ${signature}`,
  );
}
for (const forbidden of ['expireSeries', 'SeriesExpired', 'SeriesExpiredProgress']) {
  assert.equal(
    nftAbi.some((item) => item.name === forbidden),
    false,
    `config/abi/IntexNFT1155.json still exposes obsolete ${forbidden}`,
  );
}

console.log('Reviewed contract ABI profile matches required source selectors and events.');
