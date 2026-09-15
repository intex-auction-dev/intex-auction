import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, decodeFunctionData, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import {
  executeCommitTransaction,
  executeRecommitTransaction,
  readFreshCommitState,
} from '@/bidding/commit-transaction';
import { executeCancelCommitTransaction, executeRevealBidTransaction } from '@/bidding/cancel-reveal-transaction';
import { formatContractBidRatePercent } from '@/domain/commit-domain';
import { parseWorldwideDayKey, type WorldwideDayKey } from '@/domain/protocol-time';
import { MemoryStorage } from '../../unit/src/receipts/test-fixtures';
import { listStoredRevealMaterials, listTransactionAttempts } from '@/receipts/receipt-store';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider, Eip1193RequestArguments } from '@/wallet/eip1193';

const enabled = process.env.ITX_PHASE8_LOCAL === '1';
const localTest = enabled ? it : it.skip;
const MNEMONIC = 'test test test test test test test test test test test junk';
const bidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const backgroundBidderAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const ZERO_HASH = `0x${'0'.repeat(64)}`;

interface LocalDeployment {
  chainId: number;
  deploymentBlock: number;
  rpcUrl: string;
  bidder: Address;
  intexAuction: Address;
  escrowAdapter: Address;
  targetRouter: Address;
  intexNFT1155: Address;
  wcoen: Address;
}

const json = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const abi = (name: string): Promise<Abi> => json<Abi>(resolve('.local/config/abi', name));

class InjectedAnvilProvider implements Eip1193Provider {
  readonly requests: Eip1193RequestArguments[] = [];

  constructor(
    private readonly rpc: ReturnType<typeof createPublicClient>,
    private readonly account: HDAccount,
  ) {}

  async request(args: Eip1193RequestArguments): Promise<unknown> {
    this.requests.push(args);
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [this.account.address];
    if (args.method === 'eth_chainId') return '0x7a69';
    if (args.method === 'eth_signTypedData_v4') {
      const params = args.params as readonly [Address, string];
      if (getAddress(params[0]) !== this.account.address) throw new Error('Unexpected signing account.');
      return this.account.signTypedData(JSON.parse(params[1]) as Parameters<HDAccount['signTypedData']>[0]);
    }
    return this.rpc.request(args as never);
  }
}

const sentTransactions = (provider: InjectedAnvilProvider): readonly { to: Address; data: Hex }[] =>
  provider.requests
    .filter((request) => request.method === 'eth_sendTransaction')
    .map((request) => {
      const params = request.params as readonly [{ to: Address; data?: Hex; input?: Hex }];
      const transaction = params[0];
      const data = transaction.data ?? transaction.input;
      if (!data) throw new Error('Submitted transaction has no calldata.');
      return { to: getAddress(transaction.to), data };
    });

const signatureRequestCount = (provider: InjectedAnvilProvider): number =>
  provider.requests.filter((request) => request.method === 'eth_signTypedData_v4').length;

class FailingEstimateProvider extends InjectedAnvilProvider {
  estimateGasRequests = 0;

  override async request(args: Eip1193RequestArguments): Promise<unknown> {
    if (args.method === 'eth_estimateGas') {
      this.estimateGasRequests += 1;
      throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: undefined });
    }
    return super.request(args);
  }
}

const advanceToCommitEnd = (): void => {
  const result = spawnSync(
    process.execPath,
    [resolve('dev/local-chain/scripts/local/commands/local-advance.mjs'), 'commit-end'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`local:advance commit-end failed:\n${result.stdout}\n${result.stderr}`);
  }
};

const context = (input: {
  readonly profile: ResolvedVenueReadProfile;
  readonly bidder: Address;
  readonly worldwideDay: WorldwideDayKey;
  readonly token: string;
}) => ({
  token: input.token,
  chainId: input.profile.chainId,
  deploymentId: input.profile.deploymentId,
  auctionProxy: input.profile.addresses.intexAuction,
  bidder: input.bidder,
  worldwideDay: input.worldwideDay,
});

describe('Phase 8 local Anvil integration', () => {
  localTest('cancels, recommits unchanged and changed bids, then reveals through real contracts', async () => {
    const deployment = await json<LocalDeployment>(resolve('.local/deployment.json'));
    const scenario = await json<{ name: string; worldwideDay: number }>(resolve('.local/scenario.json'));
    expect(scenario.name).toBe('commit-open');
    expect(getAddress(deployment.bidder)).toBe(bidderAccount.address);
    const parsedDay = parseWorldwideDayKey(String(scenario.worldwideDay));
    if (!parsedDay.ok) throw new Error('Seeded WorldwideDay is invalid.');

    const [intexAuction, escrowAdapter, targetRouter, intexNFT1155, paymentToken] = await Promise.all([
      abi('IntexAuction.json'),
      abi('EscrowAdapter.json'),
      abi('TargetRouter.json'),
      abi('IntexNFT1155.json'),
      abi('ERC20.json'),
    ]);
    const profile: ResolvedVenueReadProfile = {
      id: 'local-auction-venue',
      name: 'Localhost',
      deploymentId: 'local-auction-venue-deployment',
      adapterProfile: 'multi-issuance-usd-reference',
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
    const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
    const storage = new MemoryStorage();
    const bidderProvider = new InjectedAnvilProvider(publicClient, bidderAccount);
    const backgroundProvider = new InjectedAnvilProvider(publicClient, backgroundBidderAccount);
    const bidder = bidderAccount.address;
    const backgroundBidder = backgroundBidderAccount.address;
    const bidderContext = context({ profile, bidder, worldwideDay: parsedDay.value, token: 'phase8-bidder' });
    const backgroundContext = context({
      profile,
      bidder: backgroundBidder,
      worldwideDay: parsedDay.value,
      token: 'phase8-background',
    });

    const initial = await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value });
    expect(initial.stage).toBe('committing-bids');
    expect(initial.params.commitBondMinor).toBeGreaterThan(0n);
    expect(initial.liveCommitHash).toBe(ZERO_HASH);

    const quantity = String(initial.params.minIntexBidQuantity);
    const rate = formatContractBidRatePercent(initial.params.minIntexBidRate).replace('%', '');
    const issuanceCurrency = initial.params.issuanceCurrencies[0];
    if (issuanceCurrency === undefined) throw new Error('Local v2 auction has no issuance currency.');
    const committed = await executeCommitTransaction({
      publicClient,
      walletProvider: bidderProvider,
      profile,
      context: bidderContext,
      storage,
      quantity,
      bidRatePercent: rate,
      issuanceCurrency,
      isContextCurrent: (token) => token === bidderContext.token,
      download: async () => {},
    });
    expect(committed.reconciliation).toBe('confirmed');
    expect(
      (await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value })).liveCommitHash,
    ).toBe(committed.material.commitHash);

    const cancelled = await executeCancelCommitTransaction({
      publicClient,
      walletProvider: bidderProvider,
      profile,
      context: bidderContext,
      storage,
      isContextCurrent: (token) => token === bidderContext.token,
    });
    expect(cancelled.reconciliation).toBe('confirmed');
    expect(cancelled.returnedBondAmount).toBe(initial.params.commitBondMinor);
    const afterCancel = await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value });
    expect(afterCancel.liveCommitHash).toBe(ZERO_HASH);
    expect(afterCancel.bidderBondAmount).toBe(0n);
    expect(afterCancel.allowance).toBe(0n);

    const signaturesBeforeSameRecommit = signatureRequestCount(bidderProvider);
    const sameRecommit = await executeRecommitTransaction({
      publicClient,
      walletProvider: bidderProvider,
      profile,
      context: bidderContext,
      storage,
      quantity,
      bidRatePercent: rate,
      issuanceCurrency,
      isContextCurrent: (token) => token === bidderContext.token,
      download: async () => {},
    });
    expect(signatureRequestCount(bidderProvider)).toBe(signaturesBeforeSameRecommit);
    expect(sameRecommit.material.commitHash).toBe(committed.material.commitHash);
    expect(sameRecommit.reconciliation).toBe('confirmed');
    expect(
      (await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value })).liveCommitHash,
    ).toBe(committed.material.commitHash);

    const backgroundInitial = await readFreshCommitState({
      publicClient,
      profile,
      bidder: backgroundBidder,
      worldwideDay: parsedDay.value,
    });
    const backgroundOld = await executeCommitTransaction({
      publicClient,
      walletProvider: backgroundProvider,
      profile,
      context: backgroundContext,
      storage,
      quantity: String(backgroundInitial.params.minIntexBidQuantity),
      issuanceCurrency,
      bidRatePercent: formatContractBidRatePercent(backgroundInitial.params.minIntexBidRate).replace('%', ''),
      isContextCurrent: (token) => token === backgroundContext.token,
      download: async () => {},
    });
    await executeCancelCommitTransaction({
      publicClient,
      walletProvider: backgroundProvider,
      profile,
      context: backgroundContext,
      storage,
      isContextCurrent: (token) => token === backgroundContext.token,
    });
    const changedQuantity = backgroundInitial.params.minIntexBidQuantity + 1;
    const changedRate = Math.min(1_000_000, backgroundInitial.params.minIntexBidRate + 100_000);
    const backgroundChanged = await executeRecommitTransaction({
      publicClient,
      walletProvider: backgroundProvider,
      profile,
      context: backgroundContext,
      storage,
      quantity: String(changedQuantity),
      issuanceCurrency,
      bidRatePercent: formatContractBidRatePercent(changedRate).replace('%', ''),
      isContextCurrent: (token) => token === backgroundContext.token,
      download: async () => {},
    });
    expect(backgroundChanged.material.commitHash).not.toBe(backgroundOld.material.commitHash);
    const storedBeforeReveal = await listStoredRevealMaterials(storage);
    const backgroundRecords = storedBeforeReveal.filter(({ stored }) => stored.material.bidder === backgroundBidder);
    expect(backgroundRecords.map(({ stored }) => stored.material.commitHash)).toEqual(
      expect.arrayContaining([backgroundOld.material.commitHash, backgroundChanged.material.commitHash]),
    );
    expect(
      (
        await readFreshCommitState({
          publicClient,
          profile,
          bidder: backgroundBidder,
          worldwideDay: parsedDay.value,
        })
      ).liveCommitHash,
    ).toBe(backgroundChanged.material.commitHash);

    advanceToCommitEnd();

    const bidderBeforeReveal = await readFreshCommitState({
      publicClient,
      profile,
      bidder,
      worldwideDay: parsedDay.value,
    });
    expect(bidderBeforeReveal.stage).toBe('revealing-bids');
    expect(bidderBeforeReveal.allowance).toBe(0n);
    const bidderReveal = await executeRevealBidTransaction({
      publicClient,
      walletProvider: bidderProvider,
      profile,
      context: bidderContext,
      storage,
      isContextCurrent: (token) => token === bidderContext.token,
    });
    expect(bidderReveal.reconciliation).toBe('confirmed');
    const bidderReconciled = await readFreshCommitState({
      publicClient,
      profile,
      bidder,
      worldwideDay: parsedDay.value,
    });
    expect(bidderReconciled.bidderRevealed).toBe(true);
    expect(bidderReconciled.liveCommitHash).toBe(ZERO_HASH);
    expect(bidderReconciled.bidderBondAmount).toBe(0n);
    expect(bidderReconciled.bidLock.status).toBe('locked');
    expect(bidderReconciled.bidLock.lockedAmount).toBe(bidderReveal.fullLockAmount);

    const backgroundReveal = await executeRevealBidTransaction({
      publicClient,
      walletProvider: backgroundProvider,
      profile,
      context: backgroundContext,
      storage,
      isContextCurrent: (token) => token === backgroundContext.token,
    });
    expect(backgroundReveal.material.commitHash).toBe(backgroundChanged.material.commitHash);
    expect(backgroundReveal.reconciliation).toBe('confirmed');

    const bidderAttempts = listTransactionAttempts(storage, committed.revealMaterialKey);
    expect(bidderAttempts.map((attempt) => attempt.kind)).toEqual([
      'approval',
      'commit',
      'cancellation',
      'approval',
      'recommit',
      'approval',
      'reveal',
    ]);
    expect(bidderAttempts.every((attempt) => attempt.state === 'confirmed')).toBe(true);
    const restored = await listStoredRevealMaterials(storage);
    expect(restored.length).toBeGreaterThanOrEqual(3);
    expect(
      listTransactionAttempts(storage, backgroundOld.revealMaterialKey).some((attempt) => attempt.kind === 'commit'),
    ).toBe(true);
    expect(
      listTransactionAttempts(storage, backgroundChanged.revealMaterialKey).some(
        (attempt) => attempt.kind === 'reveal',
      ),
    ).toBe(true);

    const bidderWrites = sentTransactions(bidderProvider);
    const decoded = bidderWrites.map((transaction) =>
      transaction.to === profile.addresses.intexAuction
        ? decodeFunctionData({ abi: intexAuction, data: transaction.data }).functionName
        : decodeFunctionData({ abi: paymentToken, data: transaction.data }).functionName,
    );
    expect(decoded).toEqual(['approve', 'commitBid', 'cancelCommit', 'approve', 'commitBid', 'approve', 'revealBid']);
  });

  localTest('commits despite the wallet node failing eth_estimateGas with "Internal JSON-RPC error."', async () => {
    const seed = spawnSync(
      process.execPath,
      [resolve('dev/local-chain/scripts/local/commands/local-scenario.mjs'), 'commit-open'],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
      },
    );
    if (seed.status !== 0) throw new Error(`seed failed: ${seed.stdout}\n${seed.stderr}`);

    const deployment = await json<LocalDeployment>(resolve('.local/deployment.json'));
    const scenario = await json<{ name: string; worldwideDay: number }>(resolve('.local/scenario.json'));
    const parsedDay = parseWorldwideDayKey(String(scenario.worldwideDay));
    if (!parsedDay.ok) throw new Error('Seeded WorldwideDay is invalid.');

    const [intexAuction, escrowAdapter, targetRouter, intexNFT1155, paymentToken] = await Promise.all([
      abi('IntexAuction.json'),
      abi('EscrowAdapter.json'),
      abi('TargetRouter.json'),
      abi('IntexNFT1155.json'),
      abi('ERC20.json'),
    ]);
    const profile: ResolvedVenueReadProfile = {
      id: 'local-auction-venue',
      name: 'Localhost',
      deploymentId: 'local-auction-venue-deployment',
      adapterProfile: 'multi-issuance-usd-reference',
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
    const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
    const provider = new FailingEstimateProvider(publicClient, bidderAccount);
    const bidder = bidderAccount.address;
    const bidderContext = context({ profile, bidder, worldwideDay: parsedDay.value, token: 'phase8-failing-estimate' });

    const initial = await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value });
    expect(initial.stage).toBe('committing-bids');
    expect(initial.liveCommitHash).toBe(ZERO_HASH);

    const committed = await executeCommitTransaction({
      publicClient,
      walletProvider: provider,
      profile,
      context: bidderContext,
      storage: new MemoryStorage(),
      quantity: String(initial.params.minIntexBidQuantity),
      bidRatePercent: formatContractBidRatePercent(initial.params.minIntexBidRate).replace('%', ''),
      issuanceCurrency: initial.params.issuanceCurrencies[0],
      isContextCurrent: (token) => token === bidderContext.token,
      download: async () => {},
    });
    expect(committed.reconciliation).toBe('confirmed');
    expect(provider.estimateGasRequests).toBe(0);
    expect(
      (await readFreshCommitState({ publicClient, profile, bidder, worldwideDay: parsedDay.value })).liveCommitHash,
    ).toBe(committed.material.commitHash);
  });
});
