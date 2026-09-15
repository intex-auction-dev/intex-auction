import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeAbiParameters, getAddress, http, keccak256, parseAbi } from 'viem';
import {
  CHAIN_ID,
  DEPLOYMENT_PATH,
  LOCAL_CONFIG_ROOT,
  IMPLEMENTATION_SLOT,
  RPC_URL,
  TESTER_WALLET_ADDRESS,
  SCENARIO_PATH,
  YESTERDAY_WORLDWIDE_DAY,
} from './constants.mjs';
import { readJson } from './config.mjs';

const quoteToken = (isoCode) =>
  getAddress(
    `0x${keccak256(
      encodeAbiParameters([{ type: 'string' }, { type: 'uint16' }], ['itx-acn.local.quote', isoCode]),
    ).slice(26)}`,
  );

const deployment = await readJson(DEPLOYMENT_PATH);
const scenario = existsSync(SCENARIO_PATH) ? await readJson(SCENARIO_PATH) : null;
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const abiFiles = Object.fromEntries(
  await Promise.all(
    [
      'IMetadosis',
      'IOracle',
      'IntexAuction',
      'EscrowAdapter',
      'TargetRouter',
      'TheCompact',
      'ERC20',
      'IntexNFT1155',
    ].map(async (name) => [name, await readJson(resolve(LOCAL_CONFIG_ROOT, 'abi', `${name}.json`))]),
  ),
);
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check((await publicClient.getChainId()) === CHAIN_ID, 'wrong local chain ID');

const codeAddresses = [
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
for (const key of codeAddresses) {
  const code = await publicClient.getCode({ address: deployment[key] });
  check(code && code !== '0x', `${key} has no code`);
}

for (const key of [
  'intexNFT1155',
  'legacyIntexAuction',
  'intexAuction',
  'escrowAdapter',
  'originRouter',
  'targetRouter',
  'intexNFT1155Bridge',
]) {
  const storage = await publicClient.getStorageAt({
    address: deployment[key],
    slot: IMPLEMENTATION_SLOT,
  });
  const implementation = storage ? getAddress(`0x${storage.slice(-40)}`) : null;
  const code = implementation ? await publicClient.getCode({ address: implementation }) : undefined;
  check(Boolean(code && code !== '0x'), `${key} proxy implementation is missing`);
}

const coreAbi = parseAbi([
  'function BRIDGE() view returns (address)',
  'function remoteMessenger(uint32) view returns (bytes)',
  'function hasRole(bytes32,address) view returns (bool)',
]);
const originAbi = [
  ...coreAbi,
  ...parseAbi([
    'function desis() view returns (address)',
    'function intexFactory() view returns (address)',
    'function tokenBridge() view returns (address)',
    'function isTarget(uint32) view returns (bool)',
    'function DESIS_ROLE() view returns (bytes32)',
    'function INTEX_FACTORY_ROLE() view returns (bytes32)',
  ]),
];
const targetAbi = abiFiles.TargetRouter;
const auctionAbi = abiFiles.IntexAuction;
const escrowAbi = abiFiles.EscrowAdapter;
const nftAbi = abiFiles.IntexNFT1155;
const nftBridgeAbi = [
  ...coreAbi,
  ...parseAbi(['function token() view returns (address)', 'function SYSTEM_RELAYER_ROLE() view returns (bytes32)']),
];
const controllerAbi = parseAbi([
  'function operator() view returns (address)',
  'function originRouter() view returns (address)',
]);
const metadosisAbi = abiFiles.IMetadosis;
const oracleAbi = abiFiles.IOracle;

const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
const same = (left, right) => getAddress(left) === getAddress(right);

check(same(await read(deployment.originRouter, originAbi, 'BRIDGE'), deployment.bridge), 'origin bridge mismatch');
check(same(await read(deployment.targetRouter, targetAbi, 'BRIDGE'), deployment.bridge), 'target bridge mismatch');
check(
  same(await read(deployment.intexNFT1155Bridge, nftBridgeAbi, 'BRIDGE'), deployment.bridge),
  'NFT bridge mismatch',
);
check(
  Number(await read(deployment.targetRouter, targetAbi, 'OUTBE_CHAIN_ID')) === CHAIN_ID,
  'target origin chain mismatch',
);
check(
  same(await read(deployment.intexNFT1155Bridge, nftBridgeAbi, 'token'), deployment.intexNFT1155),
  'NFT bridge token mismatch',
);
check(same(await read(deployment.originRouter, originAbi, 'desis'), deployment.controller), 'origin Desis mismatch');
check(
  same(await read(deployment.originRouter, originAbi, 'intexFactory'), deployment.controller),
  'origin factory mismatch',
);
check(
  same(await read(deployment.originRouter, originAbi, 'tokenBridge'), deployment.tokenBridge),
  'origin proceeds bridge mismatch',
);
check(await read(deployment.originRouter, originAbi, 'isTarget', [CHAIN_ID]), 'local target is not registered');
check(
  same(await read(deployment.targetRouter, targetAbi, 'auction'), deployment.intexAuction),
  'target auction mismatch',
);
check(same(await read(deployment.targetRouter, targetAbi, 'intex'), deployment.intexNFT1155), 'target NFT mismatch');
check(
  same(await read(deployment.targetRouter, targetAbi, 'escrowAdapter'), deployment.escrowAdapter),
  'target escrow mismatch',
);
check(
  same(await read(deployment.targetRouter, targetAbi, 'nftBridge'), deployment.intexNFT1155Bridge),
  'target NFT bridge mismatch',
);
check(
  same(await read(deployment.targetRouter, targetAbi, 'tokenBridge'), deployment.tokenBridge),
  'target proceeds bridge mismatch',
);
check(
  same(await read(deployment.targetRouter, targetAbi, 'originRouter'), deployment.originRouter),
  'target origin router mismatch',
);
check(
  same(await read(deployment.intexAuction, auctionAbi, 'escrowContract'), deployment.escrowAdapter),
  'auction escrow mismatch',
);
const expectedEscrowAuction = scenario?.currentEscrowAuction ?? deployment.intexAuction;
check(
  same(await read(deployment.escrowAdapter, escrowAbi, 'intexAuctionContract'), expectedEscrowAuction),
  'escrow auction mismatch',
);
check(same(await read(deployment.escrowAdapter, escrowAbi, 'compact'), deployment.theCompact), 'Compact mismatch');
check(
  same(await read(deployment.escrowAdapter, escrowAbi, 'paymentToken'), deployment.wcoen),
  'payment token mismatch',
);
check(
  same(await read(deployment.escrowAdapter, escrowAbi, 'proceedsRecipient'), deployment.targetRouter),
  'proceeds recipient mismatch',
);
check(
  same(await read(deployment.controller, controllerAbi, 'operator'), deployment.operator),
  'controller operator mismatch',
);
check(
  same(await read(deployment.controller, controllerAbi, 'originRouter'), deployment.originRouter),
  'controller origin mismatch',
);

const originPeer = await read(deployment.originRouter, originAbi, 'remoteMessenger', [CHAIN_ID]);
const targetPeer = await read(deployment.targetRouter, targetAbi, 'remoteMessenger', [CHAIN_ID]);
check(originPeer.toLowerCase().endsWith(deployment.targetRouter.slice(2).toLowerCase()), 'origin peer mismatch');
check(targetPeer.toLowerCase().endsWith(deployment.originRouter.slice(2).toLowerCase()), 'target peer mismatch');

const roleChecks = [
  [deployment.originRouter, originAbi, 'DESIS_ROLE', deployment.controller, 'controller lacks DESIS_ROLE'],
  [
    deployment.originRouter,
    originAbi,
    'INTEX_FACTORY_ROLE',
    deployment.controller,
    'controller lacks INTEX_FACTORY_ROLE',
  ],
  [deployment.intexAuction, auctionAbi, 'RELAYER_ROLE', deployment.targetRouter, 'target lacks auction RELAYER_ROLE'],
  [deployment.escrowAdapter, escrowAbi, 'RELAYER_ROLE', deployment.targetRouter, 'target lacks escrow RELAYER_ROLE'],
  [deployment.intexNFT1155, nftAbi, 'RELAYER_ROLE', deployment.targetRouter, 'target lacks NFT RELAYER_ROLE'],
  [deployment.intexNFT1155, nftAbi, 'RELAYER_ROLE', deployment.intexNFT1155Bridge, 'NFT bridge lacks NFT RELAYER_ROLE'],
  [
    deployment.intexNFT1155,
    nftAbi,
    'SYSTEM_RELAYER_ROLE',
    deployment.intexNFT1155Bridge,
    'NFT bridge lacks NFT SYSTEM_RELAYER_ROLE',
  ],
  [
    deployment.intexNFT1155Bridge,
    nftBridgeAbi,
    'SYSTEM_RELAYER_ROLE',
    deployment.targetRouter,
    'target lacks bridge SYSTEM_RELAYER_ROLE',
  ],
];
for (const [address, abi, roleFunction, account, message] of roleChecks) {
  const role = await read(address, abi, roleFunction);
  check(await read(address, abi, 'hasRole', [role, account]), message);
}

const COEN = getAddress('0x0000000000000000000000000000000000000000');
const usdQuote = quoteToken(840);
const [usdRate, , oracleTimestamp] = await read(deployment.controller, oracleAbi, 'getExchangeRateData', [
  COEN,
  usdQuote,
]);
const [historyTimestamps, historyRates, historyVolumes] = await read(
  deployment.controller,
  oracleAbi,
  'getPriceSnapshotHistory',
  [COEN, usdQuote, 1],
);
const referenceCurrencies = (await read(deployment.controller, oracleAbi, 'getReferenceCurrencies')).map(Number);
check(
  referenceCurrencies.length === 7 && referenceCurrencies.join(',') === '840,949,978,826,156,392,344',
  'deterministic Oracle reference-currency mismatch',
);
check(
  usdRate > 0n &&
    historyTimestamps.length === 1 &&
    historyRates.length === 1 &&
    historyVolumes.length === 1 &&
    historyTimestamps[0] === oracleTimestamp &&
    historyRates[0] > 0n &&
    historyVolumes[0] > 0n,
  'deterministic Oracle fixture mismatch',
);
check(
  (await read(deployment.controller, oracleAbi, 'getCoenExchangeRateFor', [840])) > 0n &&
    (await read(deployment.controller, oracleAbi, 'getCurrencyRate', [840])) > 0n,
  'deterministic Oracle currency-rate mismatch',
);
const worldwideDay = await read(deployment.controller, metadosisAbi, 'getWorldwideDay', [YESTERDAY_WORLDWIDE_DAY]);
check(
  worldwideDay[8] === 995_000n || worldwideDay[8] === 995_000_000_000_000_000n,
  'Metadosis fixture ABI decoding mismatch',
);

const tokenSymbol = await read(deployment.wcoen, abiFiles.ERC20, 'symbol');
const bidderBalance = await read(deployment.wcoen, abiFiles.ERC20, 'balanceOf', [deployment.bidder]);
const backgroundBalance = await read(deployment.wcoen, abiFiles.ERC20, 'balanceOf', [deployment.backgroundBidder]);
const testerBalance = await read(deployment.wcoen, abiFiles.ERC20, 'balanceOf', [TESTER_WALLET_ADDRESS]);
const bidderAllowance = await read(deployment.wcoen, abiFiles.ERC20, 'allowance', [
  deployment.bidder,
  deployment.escrowAdapter,
]);
const testerAllowance = await read(deployment.wcoen, abiFiles.ERC20, 'allowance', [
  TESTER_WALLET_ADDRESS,
  deployment.escrowAdapter,
]);
check(tokenSymbol === 'WCOEN', 'payment-token ABI decoding mismatch');
check(bidderBalance > 0n && backgroundBalance > 0n, 'deterministic bidders are not funded');
check(testerBalance > 0n, 'tester wallet is not funded with wCOEN');
check(deployment.testerWallet === TESTER_WALLET_ADDRESS, 'deployment tester wallet mismatch');
check(bidderAllowance === 0n && testerAllowance === 0n, 'bidder was pre-approved unexpectedly');
await read(deployment.theCompact, abiFiles.TheCompact, 'balanceOf', [deployment.escrowAdapter, 0n]);

const chains = await readJson(resolve(LOCAL_CONFIG_ROOT, 'chains.json'));
const deployments = await readJson(resolve(LOCAL_CONFIG_ROOT, 'deployments.json'));
check(chains.originChainProfileId === 'local-outbe-origin', 'local origin profile is not designated');
check(chains.chains.length === 2, 'local config must contain separate origin and venue profiles');
check(chains.chains[0].id !== chains.chains[1].id, 'local logical profiles are aliased');
check(
  deployments.deployments[0].chainProfileId !== deployments.deployments[1].chainProfileId,
  'local deployments share one logical context',
);
check(
  deployments.deployments[1].adapterProfile === 'multi-issuance-usd-reference',
  'local venue adapter profile is not the canonical upstream profile',
);

if (failures.length > 0) {
  throw new Error(`Local smoke failed:\n- ${failures.join('\n- ')}`);
}
console.log('Local deployment smoke passed.');
