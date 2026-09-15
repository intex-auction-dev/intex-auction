import { describe, expect, it } from 'vitest';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider, Eip1193RequestArguments } from '@/wallet/eip1193';
import { createWalletController } from '@/wallet/wallet-controller';

class OverlappingEventProvider implements Eip1193Provider {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private releaseFirstRefresh: ((accounts: string[]) => void) | null = null;
  private readonly firstRefresh = new Promise<string[]>((resolve) => {
    this.releaseFirstRefresh = resolve;
  });
  private refreshReads = 0;
  overlapMode = false;
  readonly account = '0x00000000000000000000000000000000000000aa';

  async request({ method }: Eip1193RequestArguments): Promise<unknown> {
    if (method === 'eth_requestAccounts') return [this.account];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_accounts') {
      if (!this.overlapMode) return [this.account];
      this.refreshReads += 1;
      if (this.refreshReads === 1) return this.firstRefresh;
      if (this.refreshReads === 2) throw new Error('transient account refresh failure');
      return [this.account];
    }
    throw new Error(`Unexpected method ${method}`);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach((listener) => {
      listener();
    });
  }

  release(): void {
    this.releaseFirstRefresh?.([this.account]);
    this.releaseFirstRefresh = null;
  }
}

const venue: ResolvedVenueReadProfile = {
  id: 'local',
  name: 'Local',
  deploymentId: 'local-v1',
  deploymentBlock: 0n,
  chainId: 31_337,
  nativeCurrency: null,
  walletConnectRpcUrl: null,
  rpcUrls: ['http://127.0.0.1:8545'],
  explorerUrl: null,
  confirmationDepth: 1,
  logBatchSize: 100,
  requestTimeoutMs: 1_000,
  readRetryCount: 0,
  addresses: {
    intexAuction: '0x0000000000000000000000000000000000000001',
    escrowAdapter: '0x0000000000000000000000000000000000000002',
    targetRouter: '0x0000000000000000000000000000000000000003',
    intexNFT1155: '0x0000000000000000000000000000000000000004',
    paymentToken: '0x0000000000000000000000000000000000000005',
  },
  abis: { intexAuction: [], escrowAdapter: [], targetRouter: [], intexNFT1155: [], paymentToken: [] },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('overlapping wallet events', () => {
  it('retains a connected marker when a later refresh fails', async () => {
    const target = new EventTarget();
    const provider = new OverlappingEventProvider();
    const controller = createWalletController({ target, venues: [venue], legacyProvider: provider });
    await controller.connect('legacy-injected');
    expect(controller.getState().kind).toBe('connected-supported');

    provider.overlapMode = true;
    provider.emit('accountsChanged');
    provider.emit('chainChanged');
    await flush();

    const failed = controller.getState();
    expect(failed.kind).toBe('failed');
    if (failed.kind === 'failed') {
      expect(failed.connection?.address).toMatch(/00aa$/i);
      expect(failed.connection?.chainId).toBe(31_337);
    }

    provider.release();
    await flush();
    expect(controller.getState().kind).toBe('failed');
    controller.stop();
  });
});
