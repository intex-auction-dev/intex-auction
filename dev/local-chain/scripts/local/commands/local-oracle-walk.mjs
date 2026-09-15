import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from 'viem';
import { CHAIN_ID, DEPLOYMENT_PATH, operatorAccount, RPC_URL } from '../infrastructure/constants.mjs';
import { readJson } from '../infrastructure/config.mjs';
import { requireLocalChainId } from '../controls/advance-targets.mjs';

const TICK_SECONDS = 30;
const PRICE_SCALE = 1_000_000_000_000_000_000n;

const COEN = getAddress('0x0000000000000000000000000000000000000000');
const USD_ISO = 840;
const USD_QUOTE = getAddress(
  `0x${keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint16' }], ['itx-acn.local.quote', USD_ISO])).slice(
    26,
  )}`,
);

const MIN_STEP = 200_000_000_000_000n; // 0.0002 USD in 1e18 scale
const MAX_STEP = 20_000_000_000_000_000n; // 0.02   USD in 1e18 scale
const MIN_RATE = MIN_STEP;

const deployment = await readJson(DEPLOYMENT_PATH);
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const testClient = createTestClient({ mode: 'anvil', transport: http(RPC_URL) });
const operatorWallet = createWalletClient({ account: operatorAccount, transport: http(RPC_URL) });
await requireLocalChainId(await publicClient.getChainId(), CHAIN_ID);

const controllerAbi = parseAbi([
  'function setOracleFixture(address base,address quote,uint16 isoCode,uint256 rate,uint256 vwap,uint64 timestamp)',
  'function getExchangeRateData(address base,address quote) view returns (uint256 rate,uint64 lastBlock,uint64 lastTimestamp)',
]);

const readRate = async () => {
  const [rate] = await publicClient.readContract({
    address: deployment.controller,
    abi: controllerAbi,
    functionName: 'getExchangeRateData',
    args: [COEN, USD_QUOTE],
  });
  return rate;
};

const clamp = (value) => {
  if (value < MIN_RATE) return MIN_RATE;
  return value;
};

const nextRate = (previous) => {
  const direction = Math.random() < 0.5 ? -1n : 1n;
  const range = MAX_STEP - MIN_STEP;
  const step = MIN_STEP + BigInt(Math.floor(Math.random() * Number(range)));
  return clamp(previous + step * direction);
};

let rate = await readRate();
let running = true;
const stop = () => {
  running = false;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log(`Oracle walk started: COEN/USD on ${RPC_URL} (${TICK_SECONDS}s ticks). Ctrl-C to stop.`);

while (running) {
  try {
    const block = await publicClient.getBlock();
    const timestamp = Number(block.timestamp) + TICK_SECONDS;
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
    await testClient.mine({ blocks: 1 });
    rate = nextRate(rate);
    const hash = await operatorWallet.writeContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'setOracleFixture',
      args: [COEN, USD_QUOTE, USD_ISO, rate, rate, BigInt(timestamp)],
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Oracle COEN/USD @ t=${timestamp} -> ${rate.toString()} (${Number(rate) / Number(PRICE_SCALE)} USD)`);
  } catch {
    try {
      rate = await readRate();
    } catch {
      /* use previous rate */
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, TICK_SECONDS * 1000));
}

console.log('Oracle walk stopped.');
process.exit(0);
