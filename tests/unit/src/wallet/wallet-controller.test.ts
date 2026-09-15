import { describe, expect, it } from 'vitest';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { Eip1193Provider } from '@/wallet/eip1193';
import type { WalletProviderDescriptor } from '@/wallet/injected-providers';
import { createWalletController } from '@/wallet/wallet-controller';

class FakeStorage {
  readonly values = new Map<string, string>();
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

class FakeProvider implements Eip1193Provider {
  readonly calls: string[] = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  accounts = ['0x00000000000000000000000000000000000000aa'];
  chainId = '0x7a69';
  switchFailure: Error | null = null;
  ignoreSwitch = false;
  malformedAccounts = false;
  malformedChain = false;
  disconnectCalls = 0;
  disconnectFailure: Error | null = null;
  connectCalls = 0;
  enableCalls = 0;

  async connect() {
    this.connectCalls += 1;
  }

  async enable() {
    this.enableCalls += 1;
    return this.malformedAccounts ? 'not-an-account-array' : this.accounts;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnectFailure) throw this.disconnectFailure;
  }

  async request({ method, params }: { method: string; params?: readonly unknown[] | Record<string, unknown> }) {
    this.calls.push(method);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
      return this.malformedAccounts ? 'not-an-account-array' : this.accounts;
    }
    if (method === 'eth_chainId') return this.malformedChain ? 'not-a-chain' : this.chainId;
    if (method === 'wallet_switchEthereumChain') {
      if (this.switchFailure) throw this.switchFailure;
      const target = Array.isArray(params) ? (params[0] as { chainId?: unknown }) : null;
      if (!target || typeof target.chainId !== 'string') throw new Error('missing chain');
      if (!this.ignoreSwitch) {
        this.chainId = target.chainId;
        this.emit('chainChanged', this.chainId);
      }
      return null;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, value?: unknown) {
    this.listeners.get(event)?.forEach((listener) => {
      listener(value);
    });
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, bucket) => total + bucket.size, 0);
  }
}

class SynchronousDisconnectProvider extends FakeProvider {
  override disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    throw new Error('disconnect failed synchronously');
  }
}

class DeferredProvider extends FakeProvider {
  private releaseAccounts: ((accounts: string[]) => void) | null = null;
  private readonly pendingAccounts = new Promise<string[]>((resolve) => {
    this.releaseAccounts = resolve;
  });

  override async request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }) {
    if (args.method === 'eth_requestAccounts') {
      this.calls.push(args.method);
      return this.pendingAccounts;
    }
    return super.request(args);
  }

  resolve(accounts = this.accounts) {
    this.releaseAccounts?.(accounts);
    this.releaseAccounts = null;
  }
}

const venue = (chainId: number, name = `Venue ${chainId}`): ResolvedVenueReadProfile => ({
  id: `venue-${chainId}`,
  name,
  deploymentId: `deployment-${chainId}`,
  deploymentBlock: 0n,
  chainId,
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
});

const announce = (
  target: EventTarget,
  provider: Eip1193Provider,
  uuid: string,
  name: string,
  rdns = 'io.example.wallet',
) => {
  target.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid, name, rdns }, provider },
    }),
  );
};

const walletConnectDescriptor = (provider: Eip1193Provider): WalletProviderDescriptor => ({
  id: 'walletconnect',
  sessionId: 'walletconnect',
  type: 'walletconnect',
  name: 'WalletConnect',
  provider,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('wallet controller', () => {
  it('discovers and deduplicates EIP-6963 providers while ignoring malformed announcements', () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({ target, venues: [venue(31337)] });
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { nope: true } }));
    announce(target, provider, '11111111-1111-4111-8111-111111111111', 'Wallet A');
    announce(target, provider, '22222222-2222-4222-8222-222222222222', 'Wallet A duplicate');
    expect(controller.getState().providers).toHaveLength(1);
    expect(controller.getState().providers[0]?.name).toBe('Wallet A duplicate');
    expect(controller.getState().providers[0]?.sessionId).toBe('eip6963-rdns:io.example.wallet');
    controller.stop();
  });

  it('keeps multiple injected providers and connects only after explicit selection', async () => {
    const target = new EventTarget();
    const first = new FakeProvider();
    const second = new FakeProvider();
    second.accounts = ['0x00000000000000000000000000000000000000bb'];
    const controller = createWalletController({ target, venues: [venue(31337)] });
    announce(target, first, '11111111-1111-4111-8111-111111111111', 'Alpha', 'io.alpha.wallet');
    announce(target, second, '22222222-2222-4222-8222-222222222222', 'Beta', 'io.beta.wallet');
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([]);
    await controller.connect('eip6963:22222222-2222-4222-8222-222222222222');
    expect(second.calls).toContain('eth_requestAccounts');
    expect(first.calls).toEqual([]);
    expect(controller.getState().kind).toBe('connected-supported');
    controller.stop();
  });

  it('ignores a late provider-A connection after provider B becomes active', async () => {
    const target = new EventTarget();
    const first = new DeferredProvider();
    const second = new FakeProvider();
    second.accounts = ['0x00000000000000000000000000000000000000bb'];
    const controller = createWalletController({ target, venues: [venue(31337)] });
    announce(target, first, '11111111-1111-4111-8111-111111111111', 'Alpha', 'io.alpha.wallet');
    announce(target, second, '22222222-2222-4222-8222-222222222222', 'Beta', 'io.beta.wallet');

    const firstAttempt = controller.connect('eip6963:11111111-1111-4111-8111-111111111111');
    await flush();
    await controller.connect('eip6963:22222222-2222-4222-8222-222222222222');
    first.resolve();
    await firstAttempt;

    const state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.provider.name).toBe('Beta');
      expect(state.connection.address).toMatch(/00bb$/i);
    }
    controller.stop();
  });

  it('restores EIP-6963 sessions by stable rdns after the page UUID changes', async () => {
    const storage = new FakeStorage();
    const firstTarget = new EventTarget();
    const firstProvider = new FakeProvider();
    const firstController = createWalletController({ target: firstTarget, venues: [venue(31337)], storage });
    announce(firstTarget, firstProvider, '11111111-1111-4111-8111-111111111111', 'Wallet', 'io.wallet.stable');
    await firstController.connect('eip6963:11111111-1111-4111-8111-111111111111');
    firstController.stop();

    const secondTarget = new EventTarget();
    const secondProvider = new FakeProvider();
    const secondController = createWalletController({ target: secondTarget, venues: [venue(31337)], storage });
    announce(secondTarget, secondProvider, '22222222-2222-4222-8222-222222222222', 'Wallet', 'io.wallet.stable');
    await flush();
    await flush();

    expect(secondProvider.calls).toContain('eth_accounts');
    expect(secondProvider.calls).not.toContain('eth_requestAccounts');
    expect(secondController.getState().kind).toBe('connected-supported');
    secondController.stop();
  });

  it('requires explicit selection when multiple providers claim the restored rdns', async () => {
    const storage = new FakeStorage();
    storage.setItem(
      'itx-acn:wallet-session:v1',
      JSON.stringify({
        providerSessionId: 'eip6963-rdns:io.wallet.shared',
        providerType: 'injected',
      }),
    );
    const target = new EventTarget();
    const first = new FakeProvider();
    const second = new FakeProvider();
    const controller = createWalletController({ target, venues: [venue(31337)], storage });
    announce(target, first, '11111111-1111-4111-8111-111111111111', 'First', 'io.wallet.shared');
    announce(target, second, '22222222-2222-4222-8222-222222222222', 'Second', 'io.wallet.shared');
    await flush();

    expect(controller.getState().kind).toBe('disconnected');
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([]);
    expect(storage.getItem('itx-acn:wallet-session:v1')).toBeNull();
    controller.stop();
  });

  it('restores legacy sessions silently without eth_requestAccounts', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const storage = new FakeStorage();
    storage.setItem(
      'itx-acn:wallet-session:v1',
      JSON.stringify({
        providerId: 'legacy-injected',
        providerType: 'injected',
      }),
    );
    const controller = createWalletController({ target, venues: [venue(31337)], legacyProvider: provider, storage });
    await flush();
    expect(provider.calls).toContain('eth_accounts');
    expect(provider.calls).not.toContain('eth_requestAccounts');
    expect(controller.getState().kind).toBe('connected-supported');
    controller.stop();
  });

  it('confirms account again after listeners are attached and updates chain through the listener', async () => {
    const target = new EventTarget();
    const chainProvider = new DeferredProvider();
    const chainController = createWalletController({
      target,
      venues: [venue(31337), venue(56)],
      legacyProvider: chainProvider,
    });
    const chainAttempt = chainController.connect('legacy-injected');
    await flush();
    chainProvider.resolve();
    await chainAttempt;
    let state = chainController.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.chainId).toBe(31337);
    chainProvider.chainId = '0x38';
    chainProvider.emit('chainChanged', '0x38');
    await flush();
    state = chainController.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.chainId).toBe(56);
    chainController.stop();

    const accountTarget = new EventTarget();
    const accountProvider = new DeferredProvider();
    const accountController = createWalletController({
      target: accountTarget,
      venues: [venue(31337)],
      legacyProvider: accountProvider,
    });
    const accountAttempt = accountController.connect('legacy-injected');
    await flush();
    accountProvider.accounts = ['0x00000000000000000000000000000000000000bb'];
    accountProvider.resolve(['0x00000000000000000000000000000000000000aa']);
    await accountAttempt;
    state = accountController.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.address).toMatch(/00bb$/i);
    accountController.stop();
  });

  it('rereads both authoritative values for account and chain events', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({
      target,
      venues: [venue(31337), venue(56)],
      legacyProvider: provider,
    });
    await controller.connect('legacy-injected');

    provider.accounts = ['0x00000000000000000000000000000000000000cc'];
    provider.emit('accountsChanged', ['malformed-event-payload']);
    await flush();
    let state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.address).toMatch(/00cc$/i);

    provider.chainId = '0x38';
    provider.emit('chainChanged', 'malformed-event-payload');
    await flush();
    state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.chainId).toBe(56);
    controller.stop();
  });

  it('retains listeners after a malformed reread and recovers on the next valid event', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({ target, venues: [venue(31337)], legacyProvider: provider });
    await controller.connect('legacy-injected');
    provider.malformedAccounts = true;
    provider.emit('accountsChanged', []);
    await flush();
    expect(controller.getState().kind).toBe('failed');
    expect(provider.listenerCount()).toBe(3);

    provider.malformedAccounts = false;
    provider.accounts = ['0x00000000000000000000000000000000000000dd'];
    provider.emit('accountsChanged', provider.accounts);
    await flush();
    const state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.address).toMatch(/00dd$/i);
    controller.stop();
  });

  it('represents unsupported chains without selecting another venue', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    provider.chainId = '0x1';
    const controller = createWalletController({ target, venues: [venue(31337)], legacyProvider: provider });
    await controller.connect('legacy-injected');
    const state = controller.getState();
    expect(state.kind).toBe('connected-unsupported');
    if (state.kind === 'connected-unsupported') expect(state.activeVenue).toBeNull();
    controller.stop();
  });

  it('updates account and chain identities and disconnects on empty accounts', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({ target, venues: [venue(31337), venue(56)], legacyProvider: provider });
    await controller.connect('legacy-injected');
    provider.accounts = ['0x00000000000000000000000000000000000000cc'];
    provider.emit('accountsChanged', provider.accounts);
    await flush();
    let state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.address).toMatch(/00cc$/i);
    provider.chainId = '0x38';
    provider.emit('chainChanged', provider.chainId);
    await flush();
    state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.activeVenue.chainId).toBe(56);
    provider.accounts = [];
    provider.emit('accountsChanged', []);
    await flush();
    expect(controller.getState().kind).toBe('disconnected');
    controller.stop();
  });

  it('restores the configured chain after disconnect and cleans provider listeners', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const storage = new FakeStorage();
    const controller = createWalletController({ target, venues: [venue(31337)], legacyProvider: provider, storage });
    await controller.connect('legacy-injected');
    expect(provider.listenerCount()).toBe(3);
    controller.disconnect();
    expect(controller.getState().kind).toBe('disconnected');
    expect(storage.getItem('itx-acn:wallet-session:v1')).toBeNull();
    expect(provider.listenerCount()).toBe(0);
    controller.stop();
  });

  it('offers switch actions only for configured venue chains and reports wallet failure', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({ target, venues: [venue(31337), venue(56)], legacyProvider: provider });
    await controller.connect('legacy-injected');
    await controller.switchChain(56);
    await flush();
    let state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.connection.chainId).toBe(56);
    await controller.switchChain(1);
    state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') expect(state.networkSwitch.kind).toBe('failed');
    controller.stop();
  });

  it('reports a switch failure when the wallet remains on the previous chain', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    provider.ignoreSwitch = true;
    const controller = createWalletController({ target, venues: [venue(31337), venue(56)], legacyProvider: provider });
    await controller.connect('legacy-injected');
    await controller.switchChain(56);
    const state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.chainId).toBe(31337);
      expect(state.networkSwitch.kind).toBe('failed');
    }
    controller.stop();
  });

  it('explicitly connects WalletConnect through enable() followed by authoritative rereads', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const descriptor = walletConnectDescriptor(provider);
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      walletConnectLoader: async () => descriptor,
    });

    await controller.connectWalletConnect();

    expect(provider.calls).toEqual(['eth_chainId', 'eth_accounts', 'eth_chainId']);
    expect(provider.connectCalls).toBe(0);
    expect(provider.enableCalls).toBe(1);
    expect(provider.calls).not.toContain('eth_requestAccounts');
    expect(controller.getState().kind).toBe('connected-supported');
    controller.stop();
  });

  it('silently restores WalletConnect without interactive connection methods', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const storage = new FakeStorage();
    storage.setItem(
      'itx-acn:wallet-session:v1',
      JSON.stringify({
        providerSessionId: 'walletconnect',
        providerType: 'walletconnect',
      }),
    );
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      storage,
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });

    await flush();
    await flush();

    expect(provider.calls).toEqual(['eth_accounts', 'eth_chainId', 'eth_accounts', 'eth_chainId']);
    expect(provider.connectCalls).toBe(0);
    expect(provider.enableCalls).toBe(0);
    expect(provider.calls).not.toContain('eth_requestAccounts');
    expect(controller.getState().kind).toBe('connected-supported');
    controller.stop();
  });

  it('clears an existing WalletConnect session when silent restoration has no accounts', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    provider.accounts = [];
    const storage = new FakeStorage();
    storage.setItem(
      'itx-acn:wallet-session:v1',
      JSON.stringify({
        providerSessionId: 'walletconnect',
        providerType: 'walletconnect',
      }),
    );
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      storage,
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });

    await flush();
    await flush();

    expect(controller.getState().kind).toBe('disconnected');
    expect(storage.getItem('itx-acn:wallet-session:v1')).toBeNull();
    expect(provider.calls).not.toContain('eth_requestAccounts');
    controller.stop();
  });

  it('explicitly disconnects WalletConnect after synchronous local cleanup', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const storage = new FakeStorage();
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      storage,
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });
    await controller.connectWalletConnect();

    controller.disconnect();

    expect(controller.getState().kind).toBe('disconnected');
    expect(storage.getItem('itx-acn:wallet-session:v1')).toBeNull();
    expect(provider.listenerCount()).toBe(0);
    await flush();
    expect(provider.disconnectCalls).toBe(1);
    controller.stop();
  });

  it('contains rejected and synchronous WalletConnect disconnect failures', async () => {
    const rejectedTarget = new EventTarget();
    const rejectedProvider = new FakeProvider();
    rejectedProvider.disconnectFailure = new Error('relay unavailable');
    const rejectedController = createWalletController({
      target: rejectedTarget,
      venues: [venue(31337)],
      walletConnectLoader: async () => walletConnectDescriptor(rejectedProvider),
    });
    await rejectedController.connectWalletConnect();
    expect(() => rejectedController.disconnect()).not.toThrow();
    expect(rejectedController.getState().kind).toBe('disconnected');
    await flush();
    expect(rejectedProvider.disconnectCalls).toBe(1);
    rejectedController.stop();

    const syncTarget = new EventTarget();
    const syncProvider = new SynchronousDisconnectProvider();
    const syncController = createWalletController({
      target: syncTarget,
      venues: [venue(31337)],
      walletConnectLoader: async () => walletConnectDescriptor(syncProvider),
    });
    await syncController.connectWalletConnect();
    expect(() => syncController.disconnect()).not.toThrow();
    expect(syncController.getState().kind).toBe('disconnected');
    await flush();
    expect(syncProvider.disconnectCalls).toBe(1);
    syncController.stop();
  });

  it('clears the WalletConnect session and listeners on a remote disconnect', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const storage = new FakeStorage();
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      storage,
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });
    await controller.connectWalletConnect();

    provider.emit('disconnect');

    expect(controller.getState().kind).toBe('disconnected');
    expect(storage.getItem('itx-acn:wallet-session:v1')).toBeNull();
    expect(provider.listenerCount()).toBe(0);
    controller.stop();
  });

  it('preserves the WalletConnect descriptor while replacing account and chain context', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const descriptor = walletConnectDescriptor(provider);
    const controller = createWalletController({
      target,
      venues: [venue(31337), venue(56)],
      walletConnectLoader: async () => descriptor,
    });
    await controller.connectWalletConnect();

    provider.accounts = ['0x00000000000000000000000000000000000000cc'];
    provider.emit('accountsChanged', provider.accounts);
    await flush();
    let state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.provider).toBe(descriptor);
      expect(state.connection.address).toMatch(/00cc$/i);
      expect(state.activeVenue.chainId).toBe(31337);
    }

    provider.chainId = '0x38';
    provider.emit('chainChanged', provider.chainId);
    await flush();
    state = controller.getState();
    expect(state.kind).toBe('connected-supported');
    if (state.kind === 'connected-supported') {
      expect(state.connection.provider).toBe(descriptor);
      expect(state.connection.address).toMatch(/00cc$/i);
      expect(state.activeVenue.chainId).toBe(56);
    }
    controller.stop();
  });

  it('keeps an unsupported WalletConnect chain isolated from configured venues', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    provider.chainId = '0x1';
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });

    await controller.connectWalletConnect();

    const state = controller.getState();
    expect(state.kind).toBe('connected-unsupported');
    if (state.kind === 'connected-unsupported') expect(state.activeVenue).toBeNull();
    controller.stop();
  });

  it('does not disconnect the WalletConnect provider when stopped', async () => {
    const target = new EventTarget();
    const provider = new FakeProvider();
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      walletConnectLoader: async () => walletConnectDescriptor(provider),
    });
    await controller.connectWalletConnect();

    controller.stop();
    await flush();

    expect(provider.disconnectCalls).toBe(0);
  });

  it('keeps injected wallets usable when WalletConnect initialization fails', async () => {
    const target = new EventTarget();
    const injected = new FakeProvider();
    const controller = createWalletController({
      target,
      venues: [venue(31337)],
      legacyProvider: injected,
      walletConnectLoader: async () => {
        throw new Error('relay unavailable');
      },
    });
    await controller.connectWalletConnect();
    expect(controller.getState().kind).toBe('failed');
    await controller.connect('legacy-injected');
    expect(controller.getState().kind).toBe('connected-supported');
    controller.stop();
  });
});
