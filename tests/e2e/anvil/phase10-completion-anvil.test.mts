import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Abi, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { CompletionVenueAdapter } from '@/completion/completion-adapters';
import { deriveBidderEconomics, isTargetSeriesExpired } from '@/domain/completion-domain';
import { fromViemPublicClient } from '@/protocol/read-client';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';

const enabled = process.env.ITX_PHASE10_LOCAL === '1';
const localTest = enabled ? it : it.skip;
const MNEMONIC = 'test test test test test test test test test test test junk';
const operator = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const bidder = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

interface LocalDeployment {
  chainId: number;
  deploymentBlock: number;
  rpcUrl: string;
  controller: Address;
  intexAuction: Address;
  escrowAdapter: Address;
  targetRouter: Address;
  intexNFT1155: Address;
  wcoen: Address;
}
interface LocalScenario {
  worldwideDay: number;
  bidder?: Address;
}

const json = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const abi = (name: string): Promise<Abi> => json<Abi>(resolve('.local/config/abi', name));
const run = (path: string, args: readonly string[] = []): void => {
  const result = spawnSync(process.execPath, [resolve(path), ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};
const seed = (name: string): void => {
  run('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['reset']);
  run('dev/local-chain/scripts/local/commands/local-scenario.mjs', [name]);
};

const controllerAbi = parseAbi([
  'function postRefundInstructions(uint32 dstChainId,uint32 worldwideDay,uint16 chunkIndex,uint16 totalChunks,address[] bidderAddresses,uint128[] refundedAmounts,uint128[] paidAmounts)',
  'function postIssuanceInstructions(uint32 dstChainId,(bytes14 seriesId,uint32 worldwideDay,uint32 issuedAt,uint32 issuedUnits,uint128 promisLoadMinor,uint64 entryPriceMinor,uint64 floorPriceMinor,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 callWindow,uint32 callThreshold,uint64 callPriceMinor,address[] recipients,uint256[] quantities)[] series)',
  'function markQualified(bytes14 seriesId,uint32 worldwideDay)',
  'function seriesData(bytes14 seriesId) view returns ((bytes14 seriesId,uint256 promisLoadMinor,uint256 entryPriceMinor,uint256 floorPriceMinor,uint32 issuedUnits,uint32 callWindow,uint32 callThreshold,uint256 callPriceMinor,uint8 state,uint32 issuedAt,uint32 calledAt,uint32 callNoticePeriod,uint16 issuanceCurrency,uint16 referenceCurrency,uint32 worldwideDay,uint32 settledUnits,uint32 exercisedUnits,uint32 gemFactoryUnits))',
]);
const escrowReadAbi = parseAbi([
  'function getBidLock(uint32 worldwideDay,address bidder) view returns ((uint128 lockedAmount,uint32 lockedAt,uint8 status,uint128 failedRefund,bool splitRecorded))',
]);

const setup = async () => {
  const [deployment, scenario, intexAuction, escrowAdapter, targetRouter, intexNFT1155, paymentToken] =
    await Promise.all([
      json<LocalDeployment>(resolve('.local/deployment.json')),
      json<LocalScenario>(resolve('.local/scenario.json')),
      abi('IntexAuction.json'),
      abi('EscrowAdapter.json'),
      abi('TargetRouter.json'),
      abi('IntexNFT1155.json'),
      abi('ERC20.json'),
    ]);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const walletClient = createWalletClient({ account: operator, transport: http(deployment.rpcUrl) });
  const profile: ResolvedVenueReadProfile = {
    id: 'local-auction-venue',
    name: 'Localhost',
    deploymentId: 'phase10-local',
    deploymentBlock: BigInt(deployment.deploymentBlock),
    chainId: deployment.chainId,
    rpcUrls: [deployment.rpcUrl],
    explorerUrl: null,
    confirmationDepth: 1,
    logBatchSize: 2_000,
    requestTimeoutMs: 5_000,
    readRetryCount: 0,
    addresses: {
      intexAuction: getAddress(deployment.intexAuction),
      escrowAdapter: getAddress(deployment.escrowAdapter),
      targetRouter: getAddress(deployment.targetRouter),
      intexNFT1155: getAddress(deployment.intexNFT1155),
      paymentToken: getAddress(deployment.wcoen),
    },
    abis: { intexAuction, escrowAdapter, targetRouter, intexNFT1155, paymentToken },
  };
  const write = async (functionName: string, args: readonly unknown[]) => {
    const hash = await walletClient.writeContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName,
      args,
    } as never);
    await publicClient.waitForTransactionReceipt({ hash });
  };
  const parsed = parseWorldwideDayKey(String(scenario.worldwideDay));
  if (!parsed.ok) throw new Error('Invalid local WorldwideDay.');
  return {
    deployment,
    scenario,
    publicClient,
    profile,
    write,
    day: parsed.value,
    adapter: new CompletionVenueAdapter(fromViemPublicClient(publicClient), profile),
  };
};

const sid = (worldwideDay: number): Address => `0x${worldwideDay.toString(16).padStart(28, '0')}` as unknown as Address;

type AuctionInfo = {
  params: {
    prices?: readonly { isoCode: number; entryPriceMinor: bigint; floorPriceMinor: bigint; callPriceMinor: bigint }[];
    referenceCurrency?: number;
    promisLoadMinor: bigint;
    callTrigger: { callWindow: number; callThreshold: number; callNoticePeriod: number };
  };
  result: { auctionClearingRate: bigint; issuedIntexCount: number };
};

const issuanceParams = (input: {
  deployment: LocalDeployment;
  worldwideDay: number;
  recipient: Address;
  quantity: bigint;
  auction: AuctionInfo;
}) => {
  const prices = input.auction.params.prices ?? [];
  const first = prices[0] ?? { isoCode: 840, entryPriceMinor: 0n, floorPriceMinor: 0n, callPriceMinor: 0n };
  return [
    {
      seriesId: sid(input.worldwideDay),
      worldwideDay: input.worldwideDay,
      issuedIntexCount: input.auction.result.issuedIntexCount,
      promisLoadMinor: input.auction.params.promisLoadMinor,
      entryPriceMinor: first.entryPriceMinor,
      floorPriceMinor: first.floorPriceMinor,
      callNoticePeriod: input.auction.params.callTrigger.callNoticePeriod,
      issuanceCurrency: Number(first.isoCode),
      referenceCurrency: Number(prices[0]?.isoCode ?? input.auction.params.referenceCurrency ?? 840),
      callWindow: input.auction.params.callTrigger.callWindow,
      callThreshold: input.auction.params.callTrigger.callThreshold,
      callPriceMinor: first.callPriceMinor,
      recipients: [input.recipient],
      quantities: [input.quantity],
    },
  ];
};

describe('Phase 10 local completion reads', () => {
  localTest(
    'reconciles delivered allocation, exact bidder economics, portfolio mapping and lifecycle lag',
    async () => {
      seed('completed-green-sold-out');
      const local = await setup();
      const wallet = getAddress(local.scenario.bidder ?? bidder.address);
      const lock = (await local.publicClient.readContract({
        address: local.profile.addresses.escrowAdapter,
        abi: escrowReadAbi,
        functionName: 'getBidLock',
        args: [Number(local.day), wallet],
      })) as { lockedAmount: bigint; status: number };

      const auction = (await local.publicClient.readContract({
        address: local.profile.addresses.intexAuction,
        abi: local.profile.abis.intexAuction,
        functionName: 'getAuctionInfo',
        args: [Number(local.day)],
      })) as AuctionInfo;
      await local.write('postRefundInstructions', [
        local.deployment.chainId,
        Number(local.day),
        0,
        1,
        [wallet],
        [0n],
        [lock.lockedAmount],
      ]);
      await local.write('postIssuanceInstructions', [
        local.deployment.chainId,
        issuanceParams({
          deployment: local.deployment,
          worldwideDay: Number(local.day),
          recipient: wallet,
          quantity: 5n,
          auction,
        }),
      ]);

      const [seriesIds, target, recipient, bidderCompletion, bidderBid, portfolio] = await Promise.all([
        local.adapter.readSeriesIdsByWorldwideDay(local.day),
        local.adapter.readTargetSeries(sid(Number(local.day))),
        local.adapter.readRecipientEvidence(sid(Number(local.day)), wallet),
        local.adapter.readBidderCompletion(local.day, wallet),
        local.adapter.readBidderRevealedBid(local.day, wallet),
        local.adapter.readPortfolio(wallet, 1),
      ]);
      expect(seriesIds).toEqual([sid(Number(local.day))]);
      expect(target.lifecycle).toBe('issued');
      expect(recipient).toMatchObject({
        wonCount: 5n,
        deliveredEvent: true,
        deferred: false,
        currentIssuedBalance: 5n,
      });
      expect(bidderCompletion.lock.status).toBe('finalized');
      expect(bidderBid).not.toBeNull();
      expect(bidderBid!.bidRate > 0n && bidderBid!.bidRate <= 1_000_000n).toBe(true);
      expect(
        deriveBidderEconomics({
          lockedAmount: bidderCompletion.lock.lockedAmount,
          lockStatus: bidderCompletion.lock.status,
          wonCount: recipient.wonCount,
          promisLoadMinor: target.promisLoadMinor,
          clearingRate: auction.result.auctionClearingRate,
          issuanceInstructionsReceived: recipient.issuanceInstructionsReceived,
          deliveryDeferred: recipient.deferred,
          deliveryObserved: recipient.deliveredEvent,
        }),
      ).toMatchObject({ kind: 'finalized', paidAmount: lock.lockedAmount, refundedAmount: 0n, burnedAmount: 0n });
      expect(portfolio).toMatchObject([{ seriesId: sid(Number(local.day)), tokenStatus: 'issued', balance: 5n }]);

      const canonical = (await local.publicClient.readContract({
        address: local.deployment.controller,
        abi: controllerAbi,
        functionName: 'seriesData',
        args: [sid(Number(local.day))],
      })) as { state: number };
      expect(canonical.state).toBe(1);
      expect(target.lifecycle).toBe('issued');
      await local.write('markQualified', [sid(Number(local.day)), Number(local.day)]);
      expect((await local.adapter.readTargetSeries(sid(Number(local.day)))).lifecycle).toBe('qualified');
    },
    120_000,
  );

  localTest(
    'treats no-sale as a terminal absence of target series',
    async () => {
      seed('completed-green-no-sale');
      const local = await setup();
      expect(await local.adapter.readSeriesIdsByWorldwideDay(local.day)).toEqual([]);
      expect(await local.adapter.readPortfolio(bidder.address, 1)).toEqual([]);
    },
    120_000,
  );

  localTest(
    'surfaces recipient delivery deferred by the reviewed router path',
    async () => {
      seed('completed-green-sold-out');
      const local = await setup();
      const rejectingRecipient = getAddress(local.deployment.controller);
      const auction = (await local.publicClient.readContract({
        address: local.profile.addresses.intexAuction,
        abi: local.profile.abis.intexAuction,
        functionName: 'getAuctionInfo',
        args: [Number(local.day)],
      })) as AuctionInfo;
      await local.write('postIssuanceInstructions', [
        local.deployment.chainId,
        issuanceParams({
          deployment: local.deployment,
          worldwideDay: Number(local.day),
          recipient: rejectingRecipient,
          quantity: 5n,
          auction,
        }),
      ]);
      const recipient = await local.adapter.readRecipientEvidence(sid(Number(local.day)), rejectingRecipient);
      expect(recipient).toMatchObject({
        issuanceInstructionsReceived: true,
        deferred: true,
        deliveredEvent: false,
        wonCount: 0n,
        currentIssuedBalance: 0n,
      });
    },
    120_000,
  );

  it('keeps Called expiry strict at the deadline', () => {
    expect(
      isTargetSeriesExpired({ lifecycle: 'called', calledAt: 100n, intexCallPeriod: 20n, latestBlockTimestamp: 120n }),
    ).toBe(false);
    expect(
      isTargetSeriesExpired({ lifecycle: 'called', calledAt: 100n, intexCallPeriod: 20n, latestBlockTimestamp: 121n }),
    ).toBe(true);
  });
});
