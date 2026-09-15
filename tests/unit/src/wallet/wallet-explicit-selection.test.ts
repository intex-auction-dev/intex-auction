import { describe, expect, it, vi } from 'vitest';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider } from '@/wallet/eip1193';
import { createWalletController } from '@/wallet/wallet-controller';

class StorageStub {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

class ProviderStub implements Eip1193Provider {
  readonly calls: string[] = [];
  constructor(readonly account: string) {}
  async request({ method }: { method: string }) {
    this.calls.push(method);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [this.account];
    if (method === 'eth_chainId') return '0x7a69';
    throw new Error(`Unexpected method ${method}`);
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

const announce = (target: EventTarget, provider: Eip1193Provider, uuid: string, name: string, rdns: string) => {
  target.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid, name, rdns }, provider },
    }),
  );
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('explicit wallet selection', () => {
  it('wins over a deferred silent restore', async () => {
    const target = new EventTarget();
    const storage = new StorageStub();
    storage.setItem(
      'itx-acn:wallet-session:v1',
      JSON.stringify({
        providerSessionId: 'eip6963-rdns:io.restore.wallet',
        providerType: 'injected',
      }),
    );
    const restoreProvider = new ProviderStub('0x00000000000000000000000000000000000000aa');
    const selectedProvider = new ProviderStub('0x00000000000000000000000000000000000000bb');
    const controller = createWalletController({ target, venues: [venue], storage });
    announce(target, restoreProvider, '11111111-1111-4111-8111-111111111111', 'Restore', 'io.restore.wallet');
    announce(target, selectedProvider, '22222222-2222-4222-8222-222222222222', 'Selected', 'io.selected.wallet');

    await controller.connect('eip6963:22222222-2222-4222-8222-222222222222');
    await flush();

    const state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.address).toMatch(/00bb$/i);
      expect(state.connection.provider.name).toBe('Selected');
    }
    expect(selectedProvider.calls).toContain('eth_requestAccounts');
    expect(restoreProvider.calls).toEqual([]);
    controller.stop();
  });

  it('keeps injected connection independent when WalletConnect infrastructure fails', async () => {
    const target = new EventTarget();
    const injectedProvider = new ProviderStub('0x00000000000000000000000000000000000000cc');
    const walletConnectLoader = vi.fn().mockRejectedValue(new Error('relay unavailable'));
    const controller = createWalletController({
      target,
      venues: [venue],
      storage: new StorageStub(),
      walletConnectLoader,
    });
    announce(target, injectedProvider, '33333333-3333-4333-8333-333333333333', 'Injected', 'io.injected.wallet');

    await controller.connectWalletConnect();
    expect(controller.getState().kind).toBe('failed');
    await controller.connect('eip6963:33333333-3333-4333-8333-333333333333');

    const state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.provider.type).toBe('injected');
      expect(state.connection.address).toMatch(/00cc$/i);
    }
    expect(walletConnectLoader).toHaveBeenCalledTimes(1);
    expect(injectedProvider.calls).toContain('eth_requestAccounts');
    controller.stop();
  });
});
