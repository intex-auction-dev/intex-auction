import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { TEST_ACCOUNT, TEST_AUCTION, TEST_TIME, MemoryStorage, createTestMaterial } from '../receipts/test-fixtures';
import { persistRevealMaterial } from '@/receipts/receipt-store';
import {
  listTransactionAttempts,
  RECEIPT_STORAGE_PREFIX,
  TransactionAttemptPersistenceError,
} from '@/receipts/receipt-store';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import {
  CommitPreflightError,
  StaleCommitContextError,
  executeCommitTransaction,
  type CommitWalletClient,
} from '@/bidding/commit-transaction';

const ESCROW = '0x000000000000000000000000000000000000eC01' as Address;
const OTHER_ESCROW = '0x000000000000000000000000000000000000eC02' as Address;
const TOKEN = '0x0000000000000000000000000000000000007001' as Address;
const ROUTER = '0x0000000000000000000000000000000000007002' as Address;
const NFT = '0x0000000000000000000000000000000000007003' as Address;
const APPROVAL_HASH = `0x${'a'.repeat(64)}` as Hash;
const COMMIT_HASH = `0x${'b'.repeat(64)}` as Hash;
const REPLACEMENT_HASH = `0x${'c'.repeat(64)}` as Hash;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hash;
const parsedWorldwideDay = parseWorldwideDayKey('20260804');
if (!parsedWorldwideDay.ok) throw new Error('Test WorldwideDay is invalid.');
const WORLDWIDE_DAY = parsedWorldwideDay.value;

const profile = (): ResolvedVenueReadProfile => ({
  id: 'venue',
  name: 'Venue',
  deploymentId: 'venue-v1',
  deploymentBlock: 1n,
  chainId: 31337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['http://127.0.0.1:8545'],
  explorerUrl: null,
  confirmationDepth: 1,
  logBatchSize: 100,
  requestTimeoutMs: 1_000,
  readRetryCount: 0,
  adapterProfile: 'multi-issuance-usd-reference',
  addresses: {
    intexAuction: TEST_AUCTION,
    escrowAdapter: ESCROW,
    targetRouter: ROUTER,
    intexNFT1155: NFT,
    paymentToken: TOKEN,
  },
  abis: { intexAuction: [], escrowAdapter: [], targetRouter: [], intexNFT1155: [], paymentToken: [] },
});

interface FakeOptions {
  bond?: bigint;
  allowance?: bigint;
  balance?: bigint;
  approvalReject?: boolean;
  commitReject?: boolean;
  approvalRevert?: boolean;
  commitRevert?: boolean;
  approvalReplacement?: boolean;
  commitReplacement?: boolean;
  keepAllowanceInsufficient?: boolean;
  waitFailure?: 'unknown' | 'dropped';
  simulationFailure?: 'approval' | 'commit';
  gasFailure?: 'approval' | 'commit';
}

class FakeChain {
  stage = 0;
  liveCommit = ZERO_HASH;
  escrow = ESCROW;
  allowance: bigint;
  balance: bigint;
  bidderBond = 0n;
  bond: bigint;
  readonly writes: Array<{ functionName: string; args: readonly unknown[] }> = [];
  readonly simulations: string[] = [];
  readonly estimates: string[] = [];
  readonly options: FakeOptions;
  private pendingApproval = 0n;
  private pendingCommit = ZERO_HASH;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.bond = options.bond ?? 10n;
    this.allowance = options.allowance ?? 0n;
    this.balance = options.balance ?? 100n;
  }

  client(): PublicClient {
    return {
      readContract: async (request: { functionName: string }) => {
        switch (request.functionName) {
          case 'getAuctionStage':
            return this.stage;
          case 'getAuctionInfo':
            return {
              schedule: { commitEnd: 2_000_000_000n, revealEnd: 2_000_003_600n, issuanceEnd: 2_000_007_200n },
              params: {
                promisLoadMinor: 1_000n,
                minIntexBidRate: 500_000,
                minIntexBidQuantity: 2,
                commitBondMinor: this.bond,
                prices: [{ isoCode: 840, entryPriceMinor: 100n, floorPriceMinor: 100n, callPriceMinor: 200n }],
              },
            };
          case 'committedBidsByHash':
            return this.liveCommit;
          case 'revealedBidsByBidder':
            return false;
          case 'escrowContract':
            return this.escrow;
          case 'intexAuctionContract':
            return TEST_AUCTION;
          case 'paymentToken':
            return TOKEN;
          case 'getCommitBond':
            return { amount: this.bidderBond, lockedAt: 0n };
          case 'getBidLock':
            return { lockedAmount: 0n, lockedAt: 0n, status: 0, failedRefund: 0n, splitRecorded: false };
          case 'balanceOf':
            return this.balance;
          case 'allowance':
            return this.allowance;
          case 'decimals':
            return 18;
          case 'symbol':
            return 'wCOEN';
          default:
            throw new Error(`Unexpected read ${request.functionName}`);
        }
      },
      simulateContract: async (request: { functionName: string }) => {
        this.simulations.push(request.functionName);
        if (request.functionName === 'commitBid' && (this.stage !== 0 || this.liveCommit !== ZERO_HASH)) {
          throw new Error('commit simulation rejected current state');
        }
        if (this.options.simulationFailure === (request.functionName === 'approve' ? 'approval' : 'commit')) {
          throw new Error(`${request.functionName} simulation failed`);
        }
        return { request };
      },
      estimateContractGas: async (request: { functionName: string }) => {
        this.estimates.push(request.functionName);
        if (this.options.gasFailure === (request.functionName === 'approve' ? 'approval' : 'commit')) {
          throw new Error(`${request.functionName} gas failed`);
        }
        return 100_000n;
      },
      waitForTransactionReceipt: async (request: {
        hash: Hash;
        onReplaced?: (replacement: { reason: 'repriced'; transaction: { hash: Hash } }) => void;
      }) => {
        if (this.options.waitFailure)
          throw new Error(this.options.waitFailure === 'dropped' ? 'transaction dropped' : 'transport timeout');
        const approval = request.hash === APPROVAL_HASH;
        const replacement = approval ? this.options.approvalReplacement : this.options.commitReplacement;
        if (replacement) request.onReplaced?.({ reason: 'repriced', transaction: { hash: REPLACEMENT_HASH } });
        const reverted = approval ? this.options.approvalRevert : this.options.commitRevert;
        if (!reverted) {
          if (approval && !this.options.keepAllowanceInsufficient) this.allowance = this.pendingApproval;
          if (!approval) {
            this.liveCommit = this.pendingCommit;
            this.bidderBond = this.bond;
          }
        }
        return {
          status: reverted ? 'reverted' : 'success',
          transactionHash: replacement ? REPLACEMENT_HASH : request.hash,
          logs: [],
        } as unknown as TransactionReceipt;
      },
    } as unknown as PublicClient;
  }

  wallet(storage?: MemoryStorage): CommitWalletClient {
    return {
      signTypedData: async (request) =>
        TEST_ACCOUNT.signTypedData(request as Parameters<typeof TEST_ACCOUNT.signTypedData>[0]),
      writeContract: async (request) => {
        const typed = request as { functionName: string; args: readonly unknown[] };
        if (storage && ![...storage.data.keys()].some((key) => key.startsWith(RECEIPT_STORAGE_PREFIX))) {
          throw new Error('write occurred before reveal-material persistence');
        }
        this.writes.push(typed);
        if (typed.functionName === 'approve') {
          if (this.options.approvalReject) throw new Error('user rejected approval');
          this.pendingApproval = typed.args[1] as bigint;
          return APPROVAL_HASH;
        }
        if (this.options.commitReject) throw new Error('user rejected commit');
        this.pendingCommit = typed.args[1] as Hash;
        return COMMIT_HASH;
      },
    };
  }
}

class ReceiptWriteFailureStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (key.startsWith(RECEIPT_STORAGE_PREFIX)) throw new Error('receipt write failed');
    super.setItem(key, value);
  }
}

class AttemptWriteFailureStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (key.startsWith('itx-acn:transaction-attempt:v1:')) throw new Error('attempt write failed');
    super.setItem(key, value);
  }
}

const execute = async (chain: FakeChain, input: Partial<Parameters<typeof executeCommitTransaction>[0]> = {}) => {
  const receiptStorage = (input.storage as MemoryStorage | undefined) ?? new MemoryStorage();
  const current = { value: true };
  const result = executeCommitTransaction({
    publicClient: chain.client(),
    walletClient: chain.wallet(receiptStorage),
    profile: profile(),
    context: {
      token: 'context',
      chainId: 31337,
      deploymentId: 'venue-v1',
      auctionProxy: TEST_AUCTION,
      bidder: TEST_ACCOUNT.address,
      worldwideDay: WORLDWIDE_DAY,
    },
    storage: receiptStorage,
    quantity: '2',
    bidRatePercent: '50',
    issuanceCurrency: 840,
    isContextCurrent: () => current.value,
    now: () => TEST_TIME,
    ...input,
  });
  return { result, storage: receiptStorage, current };
};

describe('commit transaction boundary', () => {
  it('persists before writes and requests the exact bond approval from the current escrow', async () => {
    const chain = new FakeChain({ bond: 17n, allowance: 0n });
    const { result, storage } = await execute(chain);
    const completed = await result;
    expect(chain.writes[0]).toMatchObject({ functionName: 'approve' });
    expect(chain.writes[0]?.args).toEqual([getAddress(ESCROW), 17n]);
    expect(chain.writes[1]?.functionName).toBe('commitBid');
    expect(completed.approvalTransactionHash).toBe(APPROVAL_HASH);
    expect(completed.reconciliation).toBe('confirmed');
    // The approval is recorded alongside the commit: it moves the bidder's allowance, so a
    // mined approval must stay visible even when the commit that follows it fails.
    expect(
      listTransactionAttempts(storage, completed.revealMaterialKey).map((attempt) => [attempt.kind, attempt.state]),
    ).toEqual([
      ['approval', 'confirmed'],
      ['commit', 'confirmed'],
    ]);
  });

  it('reuses the exact simulated and estimated request objects for wallet submission', async () => {
    const chain = new FakeChain({ bond: 17n, allowance: 0n });
    const client = chain.client();
    const wallet = chain.wallet();
    const simulated: unknown[] = [];
    const estimated: unknown[] = [];
    const written: unknown[] = [];
    const simulate = client.simulateContract.bind(client);
    const estimate = client.estimateContractGas.bind(client);
    const write = wallet.writeContract.bind(wallet);
    client.simulateContract = async (request) => {
      simulated.push(request);
      return simulate(request as never);
    };
    client.estimateContractGas = async (request) => {
      estimated.push(request);
      return estimate(request as never);
    };
    wallet.writeContract = async (request) => {
      written.push(request);
      return write(request);
    };

    await (await execute(chain, { publicClient: client, walletClient: wallet })).result;

    expect(simulated).toHaveLength(2);
    expect(estimated).toHaveLength(2);
    expect(written).toHaveLength(2);
    for (let index = 0; index < written.length; index += 1) {
      expect(estimated[index]).toBe(simulated[index]);
      expect(written[index]).toBe(simulated[index]);
    }
  });

  it.each([
    ['zero bond', { bond: 0n, allowance: 0n }],
    ['sufficient allowance', { bond: 10n, allowance: 10n }],
  ])('%s skips approval', async (_label, options) => {
    const chain = new FakeChain(options);
    await (await execute(chain)).result;
    expect(chain.writes.map((write) => write.functionName)).toEqual(['commitBid']);
  });

  it('blocks insufficient balance before approval', async () => {
    const chain = new FakeChain({ bond: 10n, balance: 9n });
    await expect((await execute(chain)).result).rejects.toThrow('balance is insufficient');
    expect(chain.writes).toHaveLength(0);
  });

  it.each([
    ['approval rejection', { approvalReject: true }, 'user rejected approval'],
    ['approval revert', { approvalRevert: true }, 'Approval transaction reverted'],
    ['allowance remains insufficient', { keepAllowanceInsufficient: true }, 'fresh payment-token allowance'],
  ])('handles %s without submitting commit', async (_label, options, message) => {
    const chain = new FakeChain(options);
    await expect((await execute(chain)).result).rejects.toThrow(message);
    expect(chain.writes.filter((write) => write.functionName === 'commitBid')).toHaveLength(0);
  });

  it('retains approval replacement attempts and continues with the replacement', async () => {
    const chain = new FakeChain({ approvalReplacement: true });
    const { result } = await execute(chain);
    const completed = await result;
    expect(completed.approvalTransactionHash).toBe(REPLACEMENT_HASH);
  });

  it('blocks commit when stage changes while approval confirms', async () => {
    const chain = new FakeChain();
    const client = chain.client();
    const original = client.waitForTransactionReceipt.bind(client);
    client.waitForTransactionReceipt = async (request) => {
      const receipt = await original(request as never);
      if ((request as { hash: Hash }).hash === APPROVAL_HASH) chain.stage = 1;
      return receipt;
    };
    const pending = execute(chain, { publicClient: client });
    await expect((await pending).result).rejects.toThrow('no longer accepting');
  });

  it('blocks commit when escrow wiring changes after approval', async () => {
    const chain = new FakeChain();
    const client = chain.client();
    const original = client.waitForTransactionReceipt.bind(client);
    client.waitForTransactionReceipt = async (request) => {
      const receipt = await original(request as never);
      if ((request as { hash: Hash }).hash === APPROVAL_HASH) chain.escrow = OTHER_ESCROW;
      return receipt;
    };
    await expect((await execute(chain, { publicClient: client })).result).rejects.toThrow('escrow wiring');
  });

  it('submits no chain write when receipt persistence fails', async () => {
    const chain = new FakeChain();
    const failedStorage = new ReceiptWriteFailureStorage();
    await expect(
      (await execute(chain, { storage: failedStorage, walletClient: chain.wallet(failedStorage) })).result,
    ).rejects.toThrow('not safely persisted');
    expect(chain.writes).toHaveLength(0);
  });

  it('retains the returned commit hash when post-broadcast attempt persistence fails', async () => {
    const chain = new FakeChain({ bond: 0n });
    const failedStorage = new AttemptWriteFailureStorage();
    const pending = await execute(chain, { storage: failedStorage, walletClient: chain.wallet(failedStorage) });

    try {
      await pending.result;
      throw new Error('Expected transaction attempt persistence to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionAttemptPersistenceError);
      const failure = error as TransactionAttemptPersistenceError;
      expect(failure.attempt.transactionHash).toBe(COMMIT_HASH);
      expect(failure.message).toContain(COMMIT_HASH);
      expect(failure.message).toContain('may already be submitted');
    }
    expect(chain.writes.map((write) => write.functionName)).toEqual(['commitBid']);
  });

  it.each([
    ['commit rejection', { commitReject: true }, 'user rejected commit'],
    ['simulation failure', { simulationFailure: 'commit' as const }, 'simulation failed'],
    ['gas-estimation failure', { gasFailure: 'commit' as const }, 'gas failed'],
    ['commit revert', { commitRevert: true }, 'Commit transaction reverted'],
  ])('handles %s', async (_label, options, message) => {
    const chain = new FakeChain({ allowance: 10n, ...options });
    await expect((await execute(chain)).result).rejects.toThrow(message);
  });

  it('reconciles a commit replacement and preserves both attempts after reload', async () => {
    const chain = new FakeChain({ allowance: 10n, commitReplacement: true });
    const { result, storage } = await execute(chain);
    const completed = await result;
    const attempts = listTransactionAttempts(storage, completed.revealMaterialKey);
    expect(attempts.map((attempt) => attempt.state)).toEqual(['replaced', 'confirmed']);
    expect(completed.commitTransactionHash).toBe(REPLACEMENT_HASH);
    expect(chain.liveCommit).toBe(completed.material.commitHash);
    expect(chain.bidderBond).toBe(10n);
    expect(listTransactionAttempts(storage, completed.revealMaterialKey)).toEqual(attempts);
  });

  it.each(['unknown', 'dropped'] as const)(
    'records a %s commit without inventing confirmation',
    async (waitFailure) => {
      const chain = new FakeChain({ allowance: 10n, waitFailure });
      const { result, storage } = await execute(chain);
      await expect(result).rejects.toThrow();
      const attemptKey = [...storage.data.keys()].find((key) => key.includes('transaction-attempt'));
      expect(attemptKey).toBeTruthy();
      const attempt = JSON.parse(storage.data.get(attemptKey!)!) as { state: string };
      expect(attempt.state).toBe(waitFailure);
    },
  );

  it('blocks when the stage changes before commit simulation', async () => {
    const chain = new FakeChain({ bond: 0n });
    const client = chain.client();
    const original = client.readContract.bind(client);
    let stageReads = 0;
    client.readContract = async (request) => {
      if ((request as { functionName: string }).functionName === 'getAuctionStage' && ++stageReads === 3) {
        chain.stage = 1;
      }
      return original(request as never);
    };
    await expect((await execute(chain, { publicClient: client })).result).rejects.toThrow('no longer accepting');
    expect(chain.simulations.filter((name) => name === 'commitBid')).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
  });

  it('blocks when a live commitment appears before submission', async () => {
    const chain = new FakeChain({ bond: 0n });
    const client = chain.client();
    const original = client.readContract.bind(client);
    let commitmentReads = 0;
    client.readContract = async (request) => {
      if ((request as { functionName: string }).functionName === 'committedBidsByHash' && ++commitmentReads === 3) {
        chain.liveCommit = `0x${'d'.repeat(64)}` as Hash;
      }
      return original(request as never);
    };
    await expect((await execute(chain, { publicClient: client })).result).rejects.toThrow(
      'already has a live commitment',
    );
    expect(chain.simulations.filter((name) => name === 'commitBid')).toHaveLength(0);
    expect(chain.writes).toHaveLength(0);
  });

  it('retains confirmed transaction evidence when reconciliation RPC is unavailable without claiming economic reconciliation', async () => {
    const chain = new FakeChain({ bond: 0n });
    const client = chain.client();
    const original = client.readContract.bind(client);
    const progress: string[] = [];
    let stageReads = 0;
    client.readContract = async (request) => {
      if ((request as { functionName: string }).functionName === 'getAuctionStage' && ++stageReads === 4) {
        throw new Error('reconciliation RPC unavailable');
      }
      return original(request as never);
    };
    const { result, storage } = await execute(chain, {
      publicClient: client,
      onProgress: (value) => progress.push(value.kind),
    });
    const completed = await result;
    expect(completed.reconciliation).toBe('unavailable');
    expect(completed).not.toHaveProperty('backupStatus');
    expect(listTransactionAttempts(storage, completed.revealMaterialKey).at(-1)?.state).toBe('confirmed');
    expect(progress).not.toContain('confirmed');
  });

  it('invalidates signed material when the form changes after signature', async () => {
    const chain = new FakeChain({ allowance: 10n });
    let formGeneration = 0;
    const wallet = chain.wallet();
    const originalSign = wallet.signTypedData;
    wallet.signTypedData = async (request) => {
      const signature = await originalSign(request);
      formGeneration += 1;
      return signature;
    };
    const pending = execute(chain, {
      walletClient: wallet,
      isContextCurrent: () => formGeneration === 0,
    });
    await expect((await pending).result).rejects.toBeInstanceOf(StaleCommitContextError);
    expect(chain.writes).toHaveLength(0);
  });

  it.each(['route', 'account', 'chain'])('rejects a late result after %s context change', async () => {
    const chain = new FakeChain({ allowance: 10n });
    let current = true;
    const wallet = chain.wallet();
    const originalSign = wallet.signTypedData;
    wallet.signTypedData = async (request) => {
      const signature = await originalSign(request);
      current = false;
      return signature;
    };
    const pending = execute(chain, { walletClient: wallet, isContextCurrent: () => current });
    await expect((await pending).result).rejects.toBeInstanceOf(StaleCommitContextError);
    expect(chain.writes).toHaveLength(0);
  });

  it('invalidates the prepared operation after approval context change', async () => {
    const chain = new FakeChain();
    let current = true;
    const client = chain.client();
    const original = client.waitForTransactionReceipt.bind(client);
    client.waitForTransactionReceipt = async (request) => {
      const receipt = await original(request as never);
      current = false;
      return receipt;
    };
    await expect(
      (await execute(chain, { publicClient: client, isContextCurrent: () => current })).result,
    ).rejects.toBeInstanceOf(StaleCommitContextError);
    expect(chain.writes.filter((write) => write.functionName === 'commitBid')).toHaveLength(0);
  });

  it('reuses identical immutable material and blocks corrupt stored material', async () => {
    const chain = new FakeChain({ allowance: 10n });
    const receiptStorage = new MemoryStorage();
    const material = await createTestMaterial({
      deploymentId: 'venue-v1',
      chainId: 31337,
      auctionProxy: TEST_AUCTION,
      bidder: TEST_ACCOUNT.address,
      worldwideDay: 20260804,
      quantity: 2,
      bidRate: 500_000,
      issuanceCurrency: 840,
      referenceCurrency: 840,
    });
    const persisted = await persistRevealMaterial({
      storage: receiptStorage,
      material,
      authoritativeParameters: { promisLoadMinor: 1_000n },
    });
    if (!persisted.ok) throw new CommitPreflightError(persisted.message);
    let signatures = 0;
    const wallet = chain.wallet(receiptStorage);
    wallet.signTypedData = async () => {
      signatures += 1;
      throw new Error('must not sign');
    };
    await (await execute(chain, { storage: receiptStorage, walletClient: wallet })).result;
    expect(signatures).toBe(0);

    const corrupt = new MemoryStorage();
    corrupt.data.set(persisted.key, '{"broken":true}');
    const otherChain = new FakeChain({ allowance: 10n });
    await expect(
      (await execute(otherChain, { storage: corrupt, walletClient: otherChain.wallet(corrupt) })).result,
    ).rejects.toThrow();
    expect(otherChain.writes).toHaveLength(0);
  });

  it('does not automatically download a receipt after a confirmed commit', async () => {
    const chain = new FakeChain({ bond: 0n });
    const { result } = await execute(chain);
    const completed = await result;
    expect(completed.reconciliation).toBe('confirmed');
    expect(completed).not.toHaveProperty('backupStatus');
    expect(chain.bidderBond).toBe(0n);
  });

  it('commits the bidder-selected issuance currency under the canonical upstream profile', async () => {
    const chain = new FakeChain({ allowance: 10n });
    const client = chain.client();
    const original = client.readContract.bind(client);
    client.readContract = async (request) => {
      if ((request as { functionName: string }).functionName === 'getAuctionInfo') {
        return {
          schedule: { commitEnd: 2_000_000_000n, revealEnd: 2_000_003_600n, issuanceEnd: 2_000_007_200n },
          params: {
            promisLoadMinor: 1_000n,
            minIntexBidRate: 500_000,
            minIntexBidQuantity: 2,
            commitBondMinor: chain.bond,
            prices: [
              {
                isoCode: 840,
                entryPriceMinor: 1_000_000_000_000_000_000n,
                floorPriceMinor: 1_080_000_000_000_000_000n,
                callPriceMinor: 2_280_000_000_000_000_000n,
              },
              {
                isoCode: 949,
                entryPriceMinor: 34_000_000_000_000_000_000n,
                floorPriceMinor: 34_000_000_000_000_000_000n,
                callPriceMinor: 34_000_000_000_000_000_000n,
              },
              {
                isoCode: 978,
                entryPriceMinor: 920_000_000_000_000_000n,
                floorPriceMinor: 920_000_000_000_000_000n,
                callPriceMinor: 920_000_000_000_000_000n,
              },
            ],
          },
        } as never;
      }
      return original(request as never);
    };
    const upstreamProfile = { ...profile(), adapterProfile: 'multi-issuance-usd-reference' as const };
    const { result } = await execute(chain, { publicClient: client, profile: upstreamProfile, issuanceCurrency: 949 });
    const completed = await result;
    if (completed.material.adapterProfile !== 'multi-issuance-usd-reference')
      throw new Error('Expected upstream material.');
    expect(completed.material.issuanceCurrency).toBe(949);
    expect(completed.material.referenceCurrency).toBe(840);
  });
});
