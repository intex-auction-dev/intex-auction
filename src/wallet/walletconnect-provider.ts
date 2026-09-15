import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { WalletConnectEvaluation, WalletConnectMetadata } from '../runtime-config/runtime-config';
import { currentTheme, type Theme } from '../domain/theme';
import { isEip1193Provider } from './eip1193';
import type { WalletProviderDescriptor } from './injected-providers';

export interface WalletConnectInitOptions {
  projectId: string;
  metadata: WalletConnectMetadata;
  optionalChains: [number, ...number[]];
  rpcMap: Record<number, string>;
  telemetryEnabled: false;
  logger: 'silent';
  showQrModal: true;
  qrModalOptions: {
    themeMode: Theme;
    themeVariables: {
      '--wcm-font-family': string;
    };
  };
}

export type WalletConnectInit = (options: WalletConnectInitOptions) => Promise<unknown>;

const MODAL_FONT_STACK = "'Geist Variable', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

interface WalletConnectModalLike {
  setThemeMode?(mode: Theme): void;
  open?(): Promise<void>;
  updateFeatures?(features: { readonly analytics: false }): void;
}

let activeWalletConnectModal: WalletConnectModalLike | undefined;

export const registerWalletConnectModal = (modal: unknown): void => {
  if (typeof modal !== 'object' || modal === null) {
    activeWalletConnectModal = undefined;
    return;
  }
  const candidate = modal as { setThemeMode?: unknown; updateFeatures?: unknown; open?: unknown };
  if (typeof candidate.updateFeatures === 'function') {
    candidate.updateFeatures({ analytics: false });
  }
  if (typeof candidate.setThemeMode === 'function' || typeof candidate.open === 'function') {
    activeWalletConnectModal = candidate as WalletConnectModalLike;
  } else {
    activeWalletConnectModal = undefined;
  }
};

export const openWalletConnectModal = (): boolean => {
  if (activeWalletConnectModal?.open) {
    void activeWalletConnectModal.open();
    return true;
  }
  return false;
};

export const syncWalletConnectTheme = (): void => {
  activeWalletConnectModal?.setThemeMode?.(currentTheme());
};

const defaultWalletConnectInit: WalletConnectInit = async (options) => {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  return EthereumProvider.init(options);
};

export const loadWalletConnectProvider = async (
  config: WalletConnectEvaluation,
  venues: readonly ResolvedVenueReadProfile[],
  init: WalletConnectInit = defaultWalletConnectInit,
): Promise<WalletProviderDescriptor> => {
  if (!config.usable || !config.projectId || !config.metadata) {
    throw new Error('WalletConnect is not configured.');
  }

  const chainIds: number[] = [];
  const rpcMap: Record<number, string> = {};
  const seenChainIds = new Set<number>();
  for (const venue of venues) {
    if (seenChainIds.has(venue.chainId)) continue;
    const rpcUrl = venue.walletConnectRpcUrl ?? venue.rpcUrls[0];
    if (!rpcUrl) {
      throw new Error(`WalletConnect requires an RPC endpoint for chain ${venue.chainId}.`);
    }
    seenChainIds.add(venue.chainId);
    chainIds.push(venue.chainId);
    rpcMap[venue.chainId] = rpcUrl;
  }

  if (chainIds.length === 0) throw new Error('WalletConnect requires at least one configured venue chain.');
  const optionalChains = chainIds as [number, ...number[]];
  const provider = await init({
    projectId: config.projectId,
    metadata: config.metadata,
    optionalChains,
    rpcMap,
    telemetryEnabled: false,
    logger: 'silent',
    showQrModal: true,
    qrModalOptions: {
      themeMode: currentTheme(),
      themeVariables: {
        '--wcm-font-family': MODAL_FONT_STACK,
      },
    },
  });
  if (!isEip1193Provider(provider)) throw new Error('WalletConnect did not return an EIP-1193 provider.');
  registerWalletConnectModal((provider as { modal?: unknown }).modal);
  return {
    id: 'walletconnect',
    sessionId: 'walletconnect',
    type: 'walletconnect',
    name: 'WalletConnect',
    provider,
  };
};
