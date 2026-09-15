import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, getAddress, http, type Abi, type Address } from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { executeRecoveryTransaction } from '@/recovery/recovery-transaction';
import { loadWalletRecoveryIndex } from '@/recovery/recovery-index';
import { listRecoveryAttempts, type RecoveryAttemptStorage } from '@/recovery/recovery-attempt';
import type { RecoveryPath } from '@/recovery/recovery-domain';
import { parseWorldwideDayKey } from '@/domain/protocol-time';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider, Eip1193RequestArguments } from '@/wallet/eip1193';

const enabled = process.env.ITX_PHASE9_LOCAL === '1';
const localTest = enabled ? it : it.skip;
const MNEMONIC = 'test test test test test test test test test test test junk';
const accounts = Array.from({ length: 6 }, (_, addressIndex) => mnemonicToAccount(MNEMONIC, { addressIndex }));
const BURN_ADDRESS = getAddress('0x000000000000000000000000000000000000dEaD');

interface LocalDeployment {
  readonly chainId: number;
  readonly deploymentBlock: number;
  readonly rpcUrl: string;
  readonly intexAuction: Address;
  readonly escrowAdapter: Address;
  readonly targetRouter: Address;
  readonly intexNFT1155: Address;
  readonly wcoen: Address;
}

interface LocalScenario {
  readonly name: string;
  readonly worldwideDay: number;
  readonly bidder: Address;
  readonly caller?: Address;
  readonly claimableAt?: number;
  readonly expectedReturnedMinor?: string;
  readonly expectedBurnedMinor?: string;
  readonly commitBondMinor?: string;
  readonly assertions?: Readonly<Record<string, unknown>>;
}

class MemoryStorage implements RecoveryAttemptStorage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class InjectedAnvilProvider implements Eip1193Provider {
  constructor(
    private readonly rpc: ReturnType<typeof createPublicClient>,
    private readonly account: HDAccount,
  ) {}

  async request(args: Eip1193RequestArguments): Promise<unknown> {
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [this.account.address];
    if (args.method === 'eth_chainId') return '0x7a69';
    return this.rpc.request(args as never);
  }
}

const json = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const abi = (name: string): Promise<Abi> => json<Abi>(resolve('.local/config/abi', name));

const runScript = (path: string, args: readonly string[] = []): void => {
  const result = spawnSync(process.execPath, [resolve(path), ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
};

const seed = (scenario: string, advanceTarget?: string): void => {
  runScript('dev/local-chain/scripts/local/infrastructure/local-env.mjs', ['reset']);
  runScript('dev/local-chain/scripts/local/commands/local-scenario.mjs', [scenario]);
  if (advanceTarget) runScript('dev/local-chain/scripts/local/commands/local-advance.mjs', [advanceTarget]);
};

const callerAccount = (address: Address): HDAccount => {
  const normalized = getAddress(address);
  const account = accounts.find((candidate) => candidate.address === normalized);
  if (!account) throw new Error(`No deterministic Anvil account matches caller ${normalized}.`);
  return account;
};

const profileFromDeployment = async (deployment: LocalDeployment): Promise<ResolvedVenueReadProfile> => {
  const [intexAuction, escrowAdapter, targetRouter, intexNFT1155, paymentToken] = await Promise.all([
    abi('IntexAuction.json'),
    abi('EscrowAdapter.json'),
    abi('TargetRouter.json'),
    abi('IntexNFT1155.json'),
    abi('ERC20.json'),
  ]);
  return {
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
};

const balanceOf = (
  publicClient: ReturnType<typeof createPublicClient>,
  profile: ResolvedVenueReadProfile,
  account: Address,
): Promise<bigint> =>
  publicClient.readContract({
    address: profile.addresses.paymentToken,
    abi: profile.abis.paymentToken,
    functionName: 'balanceOf',
    args: [account],
  }) as Promise<bigint>;

const mineSkippedVenueToClaimable = async (
  publicClient: ReturnType<typeof createPublicClient>,
  profile: ResolvedVenueReadProfile,
  scenario: LocalScenario,
): Promise<void> => {
  const lock = (await publicClient.readContract({
    address: profile.addresses.escrowAdapter,
    abi: profile.abis.escrowAdapter,
    functionName: 'getBidLock',
    args: [scenario.worldwideDay, scenario.bidder],
  })) as unknown as { lockedAt: bigint };
  const delay = (await publicClient.readContract({
    address: profile.addresses.escrowAdapter,
    abi: profile.abis.escrowAdapter,
    functionName: 'UNFINALIZED_REFUND_DELAY',
  })) as bigint;
  const deadline = lock.lockedAt + delay;
  const testClient = createTestClient({ mode: 'anvil', transport: http(profile.rpcUrls[0]!) });
  const current = (await publicClient.getBlock()).timestamp;
  if (current < deadline) {
    await testClient.setNextBlockTimestamp({ timestamp: deadline });
    await testClient.mine({ blocks: 1 });
  }
};

const executeFixture = async (input: {
  readonly scenarioName: string;
  readonly advanceTarget?: string;
  readonly expectedPath: RecoveryPath;
  readonly expectHistorical?: boolean;
  readonly mineSkipped?: boolean;
  readonly sharedStorage?: MemoryStorage;
  readonly caller?: Address;
}) => {
  seed(input.scenarioName, input.advanceTarget);
  const [deployment, scenario] = await Promise.all([
    json<LocalDeployment>(resolve('.local/deployment.json')),
    json<LocalScenario>(resolve('.local/scenario.json')),
  ]);
  const profile = await profileFromDeployment(deployment);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  if (input.mineSkipped) await mineSkippedVenueToClaimable(publicClient, profile, scenario);
  const parsedDay = parseWorldwideDayKey(String(scenario.worldwideDay));
  if (!parsedDay.ok) throw new Error('Scenario WorldwideDay is invalid.');
  const bidder = getAddress(scenario.bidder);
  const caller = getAddress(input.caller ?? scenario.caller ?? accounts[1]!.address);
  expect(caller).not.toBe(bidder);

  const index = await loadWalletRecoveryIndex({ publicClient, profile, wallet: bidder });
  const item = index.items.find(
    (candidate) => candidate.path === input.expectedPath && candidate.worldwideDay === parsedDay.value,
  );
  if (!item) {
    throw new Error(`Recovery path ${input.expectedPath} was not projected. Issues: ${JSON.stringify(index.issues)}`);
  }
  if (input.expectHistorical) expect(item.custody).toBe('historical');
  expect(item.availability).toBe('claimable');
  if (scenario.expectedReturnedMinor !== undefined)
    expect(item.returnedAmount).toBe(BigInt(scenario.expectedReturnedMinor));
  if (scenario.expectedBurnedMinor !== undefined) expect(item.burnedAmount).toBe(BigInt(scenario.expectedBurnedMinor));
  if (scenario.commitBondMinor !== undefined) expect(item.returnedAmount).toBe(BigInt(scenario.commitBondMinor));

  const [bidderBefore, callerBefore, burnBefore] = await Promise.all([
    balanceOf(publicClient, profile, bidder),
    balanceOf(publicClient, profile, caller),
    balanceOf(publicClient, profile, BURN_ADDRESS),
  ]);
  const storage = input.sharedStorage ?? new MemoryStorage();
  const result = await executeRecoveryTransaction({
    publicClient,
    walletProvider: new InjectedAnvilProvider(publicClient, callerAccount(caller)),
    profile,
    caller,
    item,
    storage,
    contextToken: `${input.scenarioName}:${parsedDay.value}`,
    isContextCurrent: () => true,
  });
  expect(result.reconciliation).toBe('confirmed');
  const [bidderAfter, callerAfter, burnAfter] = await Promise.all([
    balanceOf(publicClient, profile, bidder),
    balanceOf(publicClient, profile, caller),
    balanceOf(publicClient, profile, BURN_ADDRESS),
  ]);
  expect(bidderAfter - bidderBefore).toBe(item.returnedAmount);
  expect(burnAfter - burnBefore).toBe(item.burnedAmount);
  expect(callerAfter).toBe(callerBefore);
  const restoredAttempts = listRecoveryAttempts(storage, {
    chainId: profile.chainId,
    deploymentId: profile.deploymentId,
    bidder,
  });
  expect(restoredAttempts.at(-1)).toMatchObject({
    path: input.expectedPath,
    state: 'confirmed',
    expectedReturnedAmount: item.returnedAmount,
    expectedBurnedAmount: item.burnedAmount,
  });
  const after = await loadWalletRecoveryIndex({ publicClient, profile, wallet: bidder });
  expect(after.items.some((candidate) => candidate.key === item.key)).toBe(false);
  return { result, item, scenario, storage, restoredAttempts };
};

describe('Phase 9 local Anvil recovery integration', () => {
  localTest(
    'executes all bidder-state-derived recovery paths at their exact boundaries',
    async () => {
      const auctionBond = await executeFixture({
        scenarioName: 'unrevealed-bond-waiting',
        advanceTarget: 'unrevealed-bond-claimable',
        expectedPath: 'auction-commit-bond',
      });
      expect(auctionBond.scenario.assertions?.earlyRevealEndSnap).toBe(true);
      expect(auctionBond.result.commitBondReleasedEventObserved).toBe(true);

      const historicalBond = await executeFixture({
        scenarioName: 'abandoned-commit-bond-waiting',
        advanceTarget: 'abandoned-bond-claimable',
        expectedPath: 'escrow-abandoned-commit-bond',
        expectHistorical: true,
      });
      expect(historicalBond.result.commitBondReleasedEventObserved).toBe(true);

      const storage = new MemoryStorage();
      const unfinalized = await executeFixture({
        scenarioName: 'unfinalized-escrow-waiting',
        advanceTarget: 'unfinalized-refund-claimable',
        expectedPath: 'escrow-unfinalized-refund',
        sharedStorage: storage,
      });
      expect(unfinalized.result.fundsRefundedEventObserved).toBe(true);
      expect(listRecoveryAttempts(storage)).toHaveLength(1);

      const failedSplit = await executeFixture({
        scenarioName: 'finalized-failed-split',
        advanceTarget: 'failed-split-claimable',
        expectedPath: 'escrow-failed-split-refund',
      });
      expect(failedSplit.result.fundsRefundedEventObserved).toBe(true);
      expect(failedSplit.result.proceedsBurnedEventObserved).toBe(true);

      const noSplit = await executeFixture({
        scenarioName: 'finalized-without-split',
        advanceTarget: 'no-split-claimable',
        expectedPath: 'escrow-no-split-refund',
      });
      expect(noSplit.result.fundsRefundedEventObserved).toBe(true);
      expect(noSplit.item.burnedAmount).toBe(0n);

      const noOp = await executeFixture({
        scenarioName: 'finalization-no-op',
        advanceTarget: 'no-split-claimable',
        expectedPath: 'escrow-no-split-refund',
      });
      expect(noOp.scenario.assertions?.finalizationNoOp).toBe(true);
      expect(noOp.result.fundsRefundedEventObserved).toBe(true);

      const skipped = await executeFixture({
        scenarioName: 'venue-chain-skipped',
        expectedPath: 'escrow-unfinalized-refund',
        mineSkipped: true,
        caller: accounts[1]!.address,
      });
      expect(skipped.scenario.assertions?.chainSkipped).toBe(true);
      expect(skipped.item.burnedAmount).toBe(0n);
    },
    180_000,
  );
});
