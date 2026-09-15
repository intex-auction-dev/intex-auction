import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, decodeFunctionData, getAddress, http, type Abi, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { MemoryStorage } from '../../unit/src/receipts/test-fixtures';
import { listStoredRevealMaterials, listTransactionAttempts } from '@/receipts/receipt-store';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider, Eip1193RequestArguments } from '@/wallet/eip1193';
import { executeCommitTransaction, readFreshCommitState } from '@/bidding/commit-transaction';
import { formatContractBidRatePercent } from '@/domain/commit-domain';
import { parseWorldwideDayKey } from '@/domain/protocol-time';

const enabled = process.env.ITX_PHASE7_LOCAL === '1';
const localTest = enabled ? it : it.skip;
const MNEMONIC = 'test test test test test test test test test test test junk';
const manualBidder = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

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
    private readonly bidder: Address,
  ) {}

  async request(args: Eip1193RequestArguments): Promise<unknown> {
    this.requests.push(args);
    if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [this.bidder];
    if (args.method === 'eth_chainId') return '0x7a69';
    if (args.method === 'eth_signTypedData_v4') {
      const params = args.params as readonly [Address, string];
      if (getAddress(params[0]) !== this.bidder) throw new Error('Unexpected signing account.');
      const typed = JSON.parse(params[1]) as Parameters<typeof manualBidder.signTypedData>[0];
      return manualBidder.signTypedData(typed);
    }
    return this.rpc.request(args as never);
  }
}

const sentTransaction = (request: Eip1193RequestArguments): { to: Address; data: Hex } => {
  const params = request.params as readonly [{ to: Address; data?: Hex; input?: Hex }];
  const transaction = params[0];
  const data = transaction.data ?? transaction.input;
  if (!data) throw new Error('Submitted transaction has no calldata.');
  return { to: getAddress(transaction.to), data };
};

describe('Phase 7 local Anvil integration', () => {
  localTest('commits through an injected EIP-1193 provider and reconstructs after reload', async () => {
    const deployment = await json<LocalDeployment>(resolve('.local/deployment.json'));
    const scenario = await json<{ name: string; worldwideDay: number }>(resolve('.local/scenario.json'));
    expect(scenario.name).toBe('commit-open');
    expect(getAddress(deployment.bidder)).toBe(manualBidder.address);
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
    const bidder = getAddress(deployment.bidder);
    const initial = await readFreshCommitState({
      publicClient,
      profile,
      bidder,
      worldwideDay: parsedDay.value,
    });
    expect(initial.liveCommitHash).toBe(`0x${'0'.repeat(64)}`);
    expect(initial.allowance).toBe(0n);
    expect(initial.params.commitBondMinor).toBeGreaterThan(0n);

    const browserStorage = new MemoryStorage();
    const provider = new InjectedAnvilProvider(publicClient, bidder);
    const result = await executeCommitTransaction({
      publicClient,
      walletProvider: provider,
      profile,
      context: {
        token: 'local-phase-7',
        chainId: profile.chainId,
        deploymentId: profile.deploymentId,
        auctionProxy: profile.addresses.intexAuction,
        bidder,
        worldwideDay: parsedDay.value,
      },
      storage: browserStorage,
      quantity: String(initial.params.minIntexBidQuantity),
      issuanceCurrency: initial.params.issuanceCurrencies[0],
      bidRatePercent: formatContractBidRatePercent(initial.params.minIntexBidRate).replace('%', ''),
      isContextCurrent: (token) => token === 'local-phase-7',
    });

    const writes = provider.requests.filter((request) => request.method === 'eth_sendTransaction');
    expect(writes).toHaveLength(2);
    const approval = sentTransaction(writes[0]!);
    expect(approval.to).toBe(profile.addresses.paymentToken);
    expect(decodeFunctionData({ abi: paymentToken, data: approval.data })).toEqual({
      functionName: 'approve',
      args: [profile.addresses.escrowAdapter, initial.params.commitBondMinor],
    });
    const commit = sentTransaction(writes[1]!);
    expect(commit.to).toBe(profile.addresses.intexAuction);
    expect(decodeFunctionData({ abi: intexAuction, data: commit.data })).toEqual({
      functionName: 'commitBid',
      args: [scenario.worldwideDay, result.material.commitHash],
    });

    const reconciled = await readFreshCommitState({
      publicClient,
      profile,
      bidder,
      worldwideDay: parsedDay.value,
    });
    expect(reconciled.liveCommitHash).toBe(result.material.commitHash);
    expect(reconciled.bidderBondAmount).toBe(initial.params.commitBondMinor);
    expect(result.reconciliation).toBe('confirmed');
    expect(result.bidCommittedEventObserved).toBe(true);
    expect(result).not.toHaveProperty('backupStatus');

    const restored = await listStoredRevealMaterials(browserStorage);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.stored.material.commitHash).toBe(result.material.commitHash);
    expect(
      listTransactionAttempts(browserStorage, result.revealMaterialKey).map((attempt) => [attempt.kind, attempt.state]),
    ).toEqual([
      ['approval', 'confirmed'],
      ['commit', 'confirmed'],
    ]);
    expect([...browserStorage.data.keys()].some((key) => key.startsWith('itx-acn:receipt-backup:v1:'))).toBe(false);
  });
});
