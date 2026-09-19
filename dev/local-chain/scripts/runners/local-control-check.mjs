import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import {
  CHAIN_ID,
  DEPLOYMENT_PATH,
  LOCAL_CONFIG_ROOT,
  MNEMONIC,
  ROOT,
  RPC_URL,
  SCENARIO_PATH,
  TESTER_WALLET_ADDRESS,
} from '../local/infrastructure/constants.mjs';
import { readJson } from '../local/infrastructure/config.mjs';

const tester = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
if (tester.address !== TESTER_WALLET_ADDRESS) {
  throw new Error(`Local-control check requires ITX_TESTER_WALLET_ADDRESS=${tester.address}.`);
}
const spawnScript = (script, args = [], env = {}) =>
  spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: false,
  });
const runScript = (script, args = [], env = {}) => {
  const result = spawnScript(script, args, env);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
};
const control = (command, count, address) =>
  JSON.parse(
    runScript(
      'dev/local-chain/scripts/local/commands/local-control.mjs',
      [command, ...(count === undefined ? [] : [String(count)])],
      address === undefined ? {} : { ITX_TESTER_WALLET_ADDRESS: address },
    ),
  );

const reset = control('reset');
if (reset.oracle?.available !== true) throw new Error('Reset scenario did not report a readable Oracle.');
runScript('dev/local-chain/scripts/local/infrastructure/local-smoke.mjs');
const unavailableOracle = control('oracle-unavailable');
if (unavailableOracle.oracle?.available !== false) throw new Error('Oracle failure did not report unavailable.');
const restoredOracle = control('oracle-available');
if (restoredOracle.oracle?.available !== true) throw new Error('Oracle recovery did not report available.');
control('fund');
const seeded = control('seed-bids', 3);
if (Number(seeded.protocol?.runningCounts?.[0]) !== 3) throw new Error('Bid seeding did not commit 3 sealed bids.');
if (Number(seeded.protocol?.runningCounts?.[1]) !== 0)
  throw new Error('Bid seeding revealed bids before the reveal stage.');
const deployment = await readJson(DEPLOYMENT_PATH);
const scenario = await readJson(SCENARIO_PATH);
const readAbi = async (name) => JSON.parse(await readFile(resolve(LOCAL_CONFIG_ROOT, 'abi', `${name}.json`), 'utf8'));
const [auctionAbi, escrowAbi, tokenAbi, nftAbi] = await Promise.all([
  readAbi('IntexAuction'),
  readAbi('EscrowAdapter'),
  readAbi('ERC20'),
  readAbi('IntexNFT1155'),
]);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const wallet = createWalletClient({ account: tester, transport: http(RPC_URL) });
if ((await publicClient.getChainId()) !== CHAIN_ID) throw new Error('Unexpected local chain.');

const externalTester = mnemonicToAccount(MNEMONIC, { addressIndex: 4 });
const externalStatus = control('status', undefined, externalTester.address);
if (externalStatus.tester?.address !== externalTester.address) {
  throw new Error(`Status did not inspect requested tester address ${externalTester.address}.`);
}
const externalFunded = control('fund', undefined, externalTester.address);
if (externalFunded.tester?.address !== externalTester.address)
  throw new Error('Fund returned the wrong tester context.');
if (BigInt(externalFunded.tester?.wcoen ?? 0) <= 0n) throw new Error('External tester did not receive wCOEN.');
if (Number(externalFunded.tester?.native ?? 0) <= 0) throw new Error('External tester did not receive native COEN.');
if (BigInt(externalFunded.tester?.allowance ?? 0) !== 0n)
  throw new Error('External tester was pre-approved unexpectedly.');
const defaultStatus = control('status');
if (defaultStatus.tester?.address !== TESTER_WALLET_ADDRESS)
  throw new Error('Default tester wallet is no longer supported.');

const blockBeforeInvalidAddress = await publicClient.getBlockNumber();
const invalidAddress = spawnScript('dev/local-chain/scripts/local/commands/local-control.mjs', ['fund'], {
  ITX_TESTER_WALLET_ADDRESS: 'not-an-address',
});
if (invalidAddress.error) throw invalidAddress.error;
if (invalidAddress.status === 0) throw new Error('Malformed tester address unexpectedly reached the funding command.');
if (!invalidAddress.stderr.includes('Address "not-an-address" is invalid')) {
  throw new Error(`Malformed tester address failed for an unexpected reason:\n${invalidAddress.stderr}`);
}
if ((await publicClient.getBlockNumber()) !== blockBeforeInvalidAddress) {
  throw new Error('Malformed tester address changed Anvil state before validation rejected it.');
}

const write = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted.`);
};

const day = Number(scenario.worldwideDay);
const auction = await publicClient.readContract({
  address: deployment.intexAuction,
  abi: auctionAbi,
  functionName: 'getAuctionInfo',
  args: [day],
});
const quantity = 5;
const bidRate = 800_000;
const referenceCurrency = Number(auction.params.prices?.[0]?.isoCode ?? auction.params.referenceCurrency);
const signature = await tester.signTypedData({
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
  message: { worldwideDay: day, bidder: tester.address, quantity, bidRate, issuanceCurrency: 949, referenceCurrency },
});
// IntexAuction.sol:39,403-405 -- the lock is native-18 WCOEN from the 1e6 basis, and the divide
// by the rate scale precedes the native-units multiply.
const lockAmount =
  ((BigInt(quantity) * auction.params.promisLoadMinor * BigInt(bidRate)) / 1_000_000n) * 1_000_000_000_000n;
await write(deployment.wcoen, tokenAbi, 'approve', [
  deployment.escrowAdapter,
  auction.params.commitBondMinor + lockAmount,
]);
await write(deployment.intexAuction, auctionAbi, 'commitBid', [day, keccak256(signature)]);
control('reveal');
const revealed = control('seed-bids', 3);
if (Number(revealed.protocol?.runningCounts?.[1]) !== 3)
  throw new Error('Bid seeding did not reveal the 3 committed bids.');
await write(deployment.intexAuction, auctionAbi, 'revealBid', [
  day,
  quantity,
  bidRate,
  949,
  referenceCurrency,
  BigInt(CHAIN_ID),
  signature,
]);
const clearing = control('clearing');
if (clearing.tester?.escrowRecoveryClaimableAt === null || clearing.tester?.escrowRecoveryClaimableAt === undefined) {
  throw new Error('Active tester lock did not expose its EscrowAdapter recovery time.');
}
const completed = control('complete-sale');

const [stage, lock, balances, info] = await Promise.all([
  publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionStage',
    args: [day],
  }),
  publicClient.readContract({
    address: deployment.escrowAdapter,
    abi: escrowAbi,
    functionName: 'getBidLock',
    args: [day, tester.address],
  }),
  publicClient.readContract({
    address: deployment.intexNFT1155,
    abi: nftAbi,
    functionName: 'ownerBalances',
    args: [`0x${day.toString(16).padStart(28, '0')}`, tester.address],
  }),
  publicClient.readContract({
    address: deployment.intexAuction,
    abi: auctionAbi,
    functionName: 'getAuctionInfo',
    args: [day],
  }),
]);
const details = await publicClient.readContract({
  address: deployment.intexAuction,
  abi: auctionAbi,
  functionName: 'getAuctionDetails',
  args: [day],
});
const cleared = details[1]
  .map((b) => ({
    bidder: b.bidderAddress,
    rate: Number(b.intexBidRate),
    qty: Number(b.intexQuantity),
    ts: Number(b.timestamp),
  }))
  .sort((a, b) => b.rate - a.rate || a.ts - b.ts);
let remaining = 24;
const allocated = cleared.map((b) => {
  const won = Math.max(0, Math.min(b.qty, remaining));
  remaining -= won;
  return { ...b, won };
});
const winners = allocated.filter((b) => b.won > 0);
const issued = winners.reduce((sum, b) => sum + b.won, 0);
const clearingRate = winners.at(-1)?.rate;
const testerWon = allocated.find((b) => b.bidder.toLowerCase() === tester.address.toLowerCase())?.won ?? 0;

if (Number(stage) !== 3) throw new Error(`Expected Completed target stage, received ${stage}.`);
if (Number(lock.status) !== 2) throw new Error(`Expected finalized bidder lock, received ${lock.status}.`);
if (Number(info.result.issuedIntexCount) !== issued)
  throw new Error(`Issued count ${info.result.issuedIntexCount} does not match rate-based clearing ${issued}.`);
if (Number(info.result.auctionClearingRate) !== clearingRate)
  throw new Error(`Clearing rate ${info.result.auctionClearingRate} does not match the marginal bid ${clearingRate}.`);
if (Number(balances.issued) !== testerWon)
  throw new Error(`Tester received ${balances.issued} intexes, expected ${testerWon} from rate-based clearing.`);
if (completed.protocol?.canonicalSeries === null) throw new Error('Canonical series was not projected.');
console.log(
  `Local control lifecycle passed for ${tester.address}: commit, reveal, clearing, rate-based refund finalization and ${issued} issued intexes (tester won ${testerWon}). External wallet funding/status validation passed for ${externalTester.address}.`,
);
