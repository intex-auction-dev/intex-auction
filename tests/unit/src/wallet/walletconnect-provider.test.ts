import { describe, expect, it, vi } from 'vitest';
import { EthereumProvider } from '@walletconnect/ethereum-provider';
import {
  loadWalletConnectProvider,
  registerWalletConnectModal,
  syncWalletConnectTheme,
  type WalletConnectInit,
} from '@/wallet/walletconnect-provider';
import type { WalletConnectEvaluation } from '@/runtime-config/runtime-config';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';

vi.mock('@walletconnect/ethereum-provider', () => ({
  EthereumProvider: {
    init: vi.fn(async () => ({ request: vi.fn() })),
  },
}));

const config: WalletConnectEvaluation = {
  enabled: true,
  usable: true,
  projectId: 'project-id',
  metadata: {
    name: 'Intex Auction',
    description: 'Local bidder application',
    url: 'http://127.0.0.1:4173',
    icons: [],
  },
  issues: [],
};

const venue = (chainId: number, rpcUrls: readonly string[]): ResolvedVenueReadProfile =>
  ({
    chainId,
    rpcUrls,
  }) as ResolvedVenueReadProfile;

describe('loadWalletConnectProvider', () => {
  it('rejects unusable configuration before initialization', async () => {
    const init = vi.fn<WalletConnectInit>();
    const invalidConfig = { ...config, usable: false };

    await expect(loadWalletConnectProvider(invalidConfig, [venue(56, ['https://rpc.example'])], init)).rejects.toThrow(
      'WalletConnect is not configured.',
    );
    expect(init).not.toHaveBeenCalled();
  });

  it('rejects when no venue chains are configured', async () => {
    const init = vi.fn<WalletConnectInit>();

    await expect(loadWalletConnectProvider(config, [], init)).rejects.toThrow(
      'WalletConnect requires at least one configured venue chain.',
    );
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes with unique venue chains, first RPC endpoints, private SDK defaults, and the package QR modal', async () => {
    const provider = { request: vi.fn() };
    const init = vi.fn<WalletConnectInit>().mockResolvedValue(provider);

    const descriptor = await loadWalletConnectProvider(
      config,
      [
        venue(56, ['https://first-bsc.example', 'https://second-bsc.example']),
        venue(56, ['https://later-bsc.example']),
        venue(97, ['https://first-testnet.example']),
      ],
      init,
    );

    expect(init).toHaveBeenCalledWith({
      projectId: 'project-id',
      metadata: config.metadata,
      optionalChains: [56, 97],
      rpcMap: {
        56: 'https://first-bsc.example',
        97: 'https://first-testnet.example',
      },
      telemetryEnabled: false,
      logger: 'silent',
      showQrModal: true,
      qrModalOptions: {
        themeMode: 'light',
        themeVariables: {
          '--wcm-font-family': "'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
      },
    });
    expect(descriptor).toEqual({
      id: 'walletconnect',
      sessionId: 'walletconnect',
      type: 'walletconnect',
      name: 'WalletConnect',
      provider,
    });
  });

  it('uses the default lazy initializer with telemetry and SDK logging disabled', async () => {
    const init = vi.mocked(EthereumProvider.init);
    init.mockClear();

    await loadWalletConnectProvider(config, [
      venue(56, ['https://first-bsc.example']),
      venue(97, ['https://first-testnet.example']),
    ]);

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      projectId: 'project-id',
      metadata: config.metadata,
      optionalChains: [56, 97],
      rpcMap: {
        56: 'https://first-bsc.example',
        97: 'https://first-testnet.example',
      },
      telemetryEnabled: false,
      logger: 'silent',
      showQrModal: true,
      qrModalOptions: {
        themeMode: 'light',
        themeVariables: {
          '--wcm-font-family': "'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
      },
    });
  });

  it('rejects an initialized object that is not an EIP-1193 provider', async () => {
    const init = vi.fn<WalletConnectInit>().mockResolvedValue({});

    await expect(loadWalletConnectProvider(config, [venue(56, ['https://rpc.example'])], init)).rejects.toThrow(
      'WalletConnect did not return an EIP-1193 provider.',
    );
  });
});

describe('walletconnect overlay theme', () => {
  const withDocumentTheme = (dark: boolean, run: () => void | Promise<void>) => {
    const previous = (globalThis as Record<string, unknown>).document;
    const classList = { contains: (token: string) => token === 'dark' && dark };
    (globalThis as Record<string, unknown>).document = { documentElement: { classList } };
    try {
      return run();
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = previous;
    }
  };

  it('passes the active application theme to the modal at init', async () => {
    await withDocumentTheme(true, async () => {
      const init = vi.fn<WalletConnectInit>().mockResolvedValue({ request: vi.fn(), modal: undefined });
      await loadWalletConnectProvider(config, [venue(56, ['https://rpc.example'])], init);

      expect(init).toHaveBeenCalledWith(
        expect.objectContaining({
          qrModalOptions: expect.objectContaining({ themeMode: 'dark' }),
        }),
      );
    });
  });

  it('registers the provider modal, disables optional analytics, and syncs runtime theme changes to it', async () => {
    const setThemeMode = vi.fn();
    const updateFeatures = vi.fn();
    const init = vi
      .fn<WalletConnectInit>()
      .mockResolvedValue({ request: vi.fn(), modal: { setThemeMode, updateFeatures } });

    await withDocumentTheme(false, async () => {
      await loadWalletConnectProvider(config, [venue(56, ['https://rpc.example'])], init);
      expect(updateFeatures).toHaveBeenCalledWith({ analytics: false });
      syncWalletConnectTheme();
      expect(setThemeMode).toHaveBeenLastCalledWith('light');
    });

    await withDocumentTheme(true, async () => {
      syncWalletConnectTheme();
      expect(setThemeMode).toHaveBeenLastCalledWith('dark');
    });
  });

  it('ignores a modal without a theme controller and keeps sync safe', () => {
    expect(() => registerWalletConnectModal({ greeting: 'hello' })).not.toThrow();
    expect(() => syncWalletConnectTheme()).not.toThrow();
  });
});
