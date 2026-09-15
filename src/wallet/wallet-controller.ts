import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import {
  normalizeProviderError,
  parseWalletAccounts,
  parseWalletChainId,
  walletChainIdHex,
  type Eip1193Provider,
} from './eip1193';
import { startInjectedProviderDiscovery, type WalletProviderDescriptor } from './injected-providers';
import {
  initialWalletState,
  isWalletConnected,
  walletReducer,
  type WalletConnection,
  type WalletState,
} from './wallet-state';

const SESSION_KEY = 'itx-acn:wallet-session:v1';

interface WalletSession {
  providerSessionId: string;
  providerType: WalletProviderDescriptor['type'];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WalletControllerOptions {
  venues: readonly ResolvedVenueReadProfile[];
  target: EventTarget;
  legacyProvider?: unknown;
  storage?: StorageLike;
  walletConnectLoader?: () => Promise<WalletProviderDescriptor>;
}

export interface WalletController {
  getState(): WalletState;
  subscribe(listener: () => void): () => void;
  connect(providerId: string): Promise<void>;
  connectWalletConnect(): Promise<void>;
  disconnect(): void;
  switchChain(chainId: number): Promise<void>;
  stop(): void;
}

const parseSession = (value: string | null): WalletSession | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      providerSessionId?: unknown;
      providerId?: unknown;
      providerType?: unknown;
    };
    if (parsed.providerType !== 'injected' && parsed.providerType !== 'walletconnect') return null;
    if (typeof parsed.providerSessionId === 'string' && parsed.providerSessionId.length > 0) {
      return { providerSessionId: parsed.providerSessionId, providerType: parsed.providerType };
    }
    if (parsed.providerId === 'legacy-injected' || parsed.providerId === 'walletconnect') {
      return { providerSessionId: parsed.providerId, providerType: parsed.providerType };
    }
    return null;
  } catch {
    return null;
  }
};

const createWalletControllerCore = (options: WalletControllerOptions): WalletController => {
  let state = initialWalletState();
  let stopped = false;
  let discoveryCleanup: (() => void) | null = null;
  let providerCleanup: (() => void) | null = null;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let walletConnectProvider: WalletProviderDescriptor | null = null;
  let restoreAttempted = false;
  let restoredSessionId: string | null = null;
  let restoredProviderId: string | null = null;
  let connectionGeneration = 0;
  const listeners = new Set<() => void>();
  const announcedProviders = new Map<string, WalletProviderDescriptor>();

  const emit = () =>
    listeners.forEach((listener) => {
      listener();
    });
  const dispatch = (action: Parameters<typeof walletReducer>[1]) => {
    if (stopped) return;
    state = walletReducer(state, action);
    emit();
  };
  const allProviders = (): readonly WalletProviderDescriptor[] => {
    const providers = [...announcedProviders.values()];
    if (walletConnectProvider && !announcedProviders.has(walletConnectProvider.id))
      providers.push(walletConnectProvider);
    return providers.sort((left, right) => left.name.localeCompare(right.name));
  };
  const publishProviders = () => dispatch({ type: 'providers', providers: allProviders() });
  const venueForChain = (chainId: number) => options.venues.find((venue) => venue.chainId === chainId) ?? null;
  const saveSession = (provider: WalletProviderDescriptor) => {
    try {
      options.storage?.setItem(
        SESSION_KEY,
        JSON.stringify({
          providerSessionId: provider.sessionId,
          providerType: provider.type,
        }),
      );
    } catch {}
  };
  const clearSession = () => {
    try {
      options.storage?.removeItem(SESSION_KEY);
    } catch {}
  };
  const readStoredSession = (): WalletSession | null => {
    try {
      return parseSession(options.storage?.getItem(SESSION_KEY) ?? null);
    } catch {
      return null;
    }
  };
  const clearRestoreTimer = () => {
    if (restoreTimer !== null) clearTimeout(restoreTimer);
    restoreTimer = null;
  };
  const clearRestoredIdentity = () => {
    restoredSessionId = null;
    restoredProviderId = null;
  };
  const detachProvider = () => {
    providerCleanup?.();
    providerCleanup = null;
  };
  const sameConnection = (connection: WalletConnection): boolean =>
    isWalletConnected(state) &&
    state.connection.provider.id === connection.provider.id &&
    state.connection.address === connection.address;
  const commitConnection = (connection: WalletConnection) => {
    dispatch({ type: 'connected', connection, venue: venueForChain(connection.chainId) });
    saveSession(connection.provider);
  };

  const connectWalletConnect = async (descriptor: WalletProviderDescriptor): Promise<unknown> => {
    const interactive = descriptor.provider as Eip1193Provider & { enable?(): Promise<unknown> };
    if (typeof interactive.enable !== 'function') {
      throw new Error('WalletConnect did not expose an interactive enable() method.');
    }
    return interactive.enable();
  };

  const buildConnection = (
    descriptor: WalletProviderDescriptor,
    rawAccounts: unknown,
    rawChainId: unknown,
  ): WalletConnection | null => {
    const accounts = parseWalletAccounts(rawAccounts);
    if (accounts.length === 0) return null;
    const address = accounts[0];
    if (!address) return null;
    return { provider: descriptor, address, chainId: parseWalletChainId(rawChainId) };
  };

  const readConnection = async (
    descriptor: WalletProviderDescriptor,
    interactive: boolean,
    chainIdOverride?: number,
  ): Promise<WalletConnection | null> => {
    if (descriptor.type === 'walletconnect' && interactive) {
      const rawAccounts = await connectWalletConnect(descriptor);
      const rawChainId = await descriptor.provider.request({ method: 'eth_chainId' });
      return buildConnection(descriptor, rawAccounts, rawChainId);
    }
    if (interactive && descriptor.type === 'injected') {
      const rawChainId = await descriptor.provider.request({ method: 'eth_chainId' });
      const rawAccounts = await descriptor.provider.request({ method: 'eth_requestAccounts' });
      return buildConnection(descriptor, rawAccounts, rawChainId);
    }
    const rawAccounts = await descriptor.provider.request({ method: 'eth_accounts' });
    const rawChainId = chainIdOverride ?? (await descriptor.provider.request({ method: 'eth_chainId' }));
    return buildConnection(descriptor, rawAccounts, rawChainId);
  };

  const currentProviderConnection = (provider: WalletProviderDescriptor): WalletConnection | null => {
    if (isWalletConnected(state) && state.connection.provider.id === provider.id) return state.connection;
    if (state.kind === 'failed' && state.connection?.provider.id === provider.id) return state.connection;
    return null;
  };

  const attachProvider = (provider: WalletProviderDescriptor) => {
    detachProvider();
    const refreshFromProvider = () => {
      const previousConnection = currentProviderConnection(provider);
      const generation = ++connectionGeneration;
      dispatch({ type: 'connecting', providerId: provider.id, reconnecting: true });
      void readConnection(provider, false).then(
        (connection) => {
          if (generation !== connectionGeneration || stopped) return;
          if (!connection) {
            clearSession();
            clearRestoredIdentity();
            detachProvider();
            dispatch({ type: 'disconnected' });
            return;
          }
          commitConnection(connection);
        },
        (error) => {
          if (generation !== connectionGeneration || stopped) return;
          dispatch({
            type: 'failed',
            providerId: provider.id,
            connection: previousConnection,
            failure: normalizeProviderError(error),
          });
        },
      );
    };
    const onAccountsChanged = () => refreshFromProvider();
    const onChainChanged = () => refreshFromProvider();
    const onDisconnect = () => {
      connectionGeneration += 1;
      clearSession();
      clearRestoredIdentity();
      detachProvider();
      dispatch({ type: 'disconnected' });
    };
    provider.provider.on?.('accountsChanged', onAccountsChanged);
    provider.provider.on?.('chainChanged', onChainChanged);
    provider.provider.on?.('disconnect', onDisconnect);
    providerCleanup = () => {
      provider.provider.removeListener?.('accountsChanged', onAccountsChanged);
      provider.provider.removeListener?.('chainChanged', onChainChanged);
      provider.provider.removeListener?.('disconnect', onDisconnect);
    };
  };

  const connectDescriptor = async (descriptor: WalletProviderDescriptor, reconnecting: boolean) => {
    const generation = ++connectionGeneration;
    detachProvider();
    if (!reconnecting) clearRestoredIdentity();
    dispatch({ type: 'connecting', providerId: descriptor.id, reconnecting });
    try {
      const initialConnection = await readConnection(descriptor, !reconnecting);
      if (generation !== connectionGeneration || stopped) return;
      if (!initialConnection) {
        clearSession();
        clearRestoredIdentity();
        dispatch({ type: 'disconnected' });
        return;
      }

      // Read wallet state around listener installation so connection transitions cannot be missed.
      attachProvider(descriptor);
      const confirmedConnection = await readConnection(
        descriptor,
        false,
        !reconnecting && descriptor.type === 'injected' ? initialConnection.chainId : undefined,
      );
      if (generation !== connectionGeneration || stopped) return;
      if (!confirmedConnection) {
        clearSession();
        clearRestoredIdentity();
        detachProvider();
        dispatch({ type: 'disconnected' });
        return;
      }
      commitConnection(confirmedConnection);
    } catch (error) {
      if (generation !== connectionGeneration || stopped) return;
      detachProvider();
      clearRestoredIdentity();
      dispatch({
        type: 'failed',
        providerId: descriptor.id,
        connection: null,
        failure: normalizeProviderError(error),
      });
    }
  };

  const invalidateAmbiguousRestoration = () => {
    if (!restoredSessionId) return;
    const matches = allProviders().filter((provider) => provider.sessionId === restoredSessionId);
    const selectedStillPresent =
      restoredProviderId === null || matches.some((provider) => provider.id === restoredProviderId);
    if (matches.length <= 1 && selectedStillPresent) return;
    connectionGeneration += 1;
    clearSession();
    clearRestoredIdentity();
    detachProvider();
    dispatch({ type: 'disconnected' });
  };

  const attemptRestore = () => {
    restoreTimer = null;
    if (restoreAttempted || stopped) return;
    const session = readStoredSession();
    if (!session) {
      restoreAttempted = true;
      return;
    }
    const matches = allProviders().filter(
      (provider) => provider.type === session.providerType && provider.sessionId === session.providerSessionId,
    );
    if (matches.length > 1) {
      restoreAttempted = true;
      clearSession();
      dispatch({ type: 'disconnected' });
      return;
    }
    const descriptor = matches[0];
    if (descriptor) {
      restoreAttempted = true;
      restoredSessionId = descriptor.sessionId;
      restoredProviderId = descriptor.id;
      void connectDescriptor(descriptor, true);
      return;
    }
    if (session.providerType !== 'walletconnect' || !options.walletConnectLoader) return;
    restoreAttempted = true;
    restoredSessionId = session.providerSessionId;
    restoredProviderId = 'walletconnect';
    const generation = ++connectionGeneration;
    detachProvider();
    dispatch({ type: 'connecting', providerId: 'walletconnect', reconnecting: true });
    void options.walletConnectLoader().then(
      (loaded) => {
        if (generation !== connectionGeneration || stopped) return;
        walletConnectProvider = loaded;
        publishProviders();
        return connectDescriptor(loaded, true);
      },
      () => {
        if (generation !== connectionGeneration || stopped) return;
        clearSession();
        clearRestoredIdentity();
        dispatch({ type: 'disconnected' });
      },
    );
  };

  const scheduleRestore = () => {
    if (restoreAttempted || stopped) return;
    clearRestoreTimer();
    restoreTimer = setTimeout(attemptRestore, 0);
  };

  discoveryCleanup = startInjectedProviderDiscovery({
    target: options.target,
    ...(options.legacyProvider === undefined ? {} : { legacyProvider: options.legacyProvider }),
    onProviders: (providers) => {
      announcedProviders.clear();
      providers.forEach((provider) => {
        announcedProviders.set(provider.id, provider);
      });
      publishProviders();
      invalidateAmbiguousRestoration();
      scheduleRestore();
    },
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: async (providerId) => {
      const descriptor = allProviders().find((provider) => provider.id === providerId);
      if (descriptor?.type !== 'injected') {
        dispatch({
          type: 'failed',
          providerId,
          connection: null,
          failure: { code: null, message: 'The selected injected wallet is unavailable.' },
        });
        return;
      }
      await connectDescriptor(descriptor, false);
    },
    connectWalletConnect: async () => {
      clearRestoredIdentity();
      if (!options.walletConnectLoader) {
        dispatch({
          type: 'failed',
          providerId: null,
          connection: null,
          failure: { code: null, message: 'WalletConnect is not configured.' },
        });
        return;
      }
      const generation = ++connectionGeneration;
      detachProvider();
      dispatch({ type: 'connecting', providerId: 'walletconnect', reconnecting: false });
      try {
        const loaded = walletConnectProvider ?? (await options.walletConnectLoader());
        if (generation !== connectionGeneration || stopped) return;
        walletConnectProvider = loaded;
        publishProviders();
        await connectDescriptor(loaded, false);
      } catch (error) {
        if (generation !== connectionGeneration || stopped) return;
        dispatch({
          type: 'failed',
          providerId: 'walletconnect',
          connection: null,
          failure: normalizeProviderError(error),
        });
      }
    },
    disconnect: () => {
      const connection = isWalletConnected(state) ? state.connection : null;
      if (connection?.provider.type === 'walletconnect') {
        void Promise.resolve()
          .then(() => connection.provider.provider.disconnect?.())
          .catch(() => undefined);
      }
      connectionGeneration += 1;
      clearRestoreTimer();
      clearSession();
      clearRestoredIdentity();
      detachProvider();
      dispatch({ type: 'disconnected' });
    },
    switchChain: async (chainId) => {
      if (!isWalletConnected(state)) return;
      if (!venueForChain(chainId)) {
        dispatch({
          type: 'switch-failed',
          chainId,
          failure: { code: null, message: 'The requested chain is not a configured venue.' },
        });
        return;
      }
      const connection = state.connection;
      dispatch({ type: 'switch-pending', chainId });
      try {
        const venue = venueForChain(chainId)!;
        try {
          await connection.provider.provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: walletChainIdHex(chainId) }],
          });
        } catch (switchError: unknown) {
          const errorCode = (switchError as { code?: number })?.code;
          if (errorCode !== 4902) throw switchError;
          // Add remote chains only with an HTTPS RPC URL accepted by mobile wallets.
          const candidateRpcUrls = [
            ...(venue.walletConnectRpcUrl ? [venue.walletConnectRpcUrl] : []),
            ...venue.rpcUrls,
          ].filter((url) => url.startsWith('https://'));
          if (candidateRpcUrls.length === 0) {
            throw new Error(
              `Chain ${chainId} is not configured in your wallet. ` +
                'Add it manually in your wallet settings with RPC URL: ' +
                (venue.walletConnectRpcUrl ?? venue.rpcUrls[0] ?? 'unknown') +
                `, chain ID: ${chainId}.`,
            );
          }
          const addChainParams: Record<string, unknown> = {
            chainId: walletChainIdHex(chainId),
            chainName: venue.name,
            rpcUrls: candidateRpcUrls,
          };
          if (venue.nativeCurrency) {
            addChainParams.nativeCurrency = venue.nativeCurrency;
          }
          if (venue.explorerUrl) {
            addChainParams.blockExplorerUrls = [venue.explorerUrl];
          }
          await connection.provider.provider.request({
            method: 'wallet_addEthereumChain',
            params: [addChainParams],
          });
        }
        if (!sameConnection(connection)) return;
        const actualChainId = parseWalletChainId(await connection.provider.provider.request({ method: 'eth_chainId' }));
        if (actualChainId !== chainId) throw new Error(`Wallet remained on chain ${actualChainId}.`);
        if (!sameConnection(connection)) return;
        const next = { ...connection, chainId: actualChainId };
        attachProvider(connection.provider);
        commitConnection(next);
      } catch (error) {
        if (!sameConnection(connection)) return;
        connectionGeneration += 1;
        dispatch({ type: 'switch-failed', chainId, failure: normalizeProviderError(error) });
      }
    },
    stop: () => {
      connectionGeneration += 1;
      stopped = true;
      clearRestoreTimer();
      discoveryCleanup?.();
      discoveryCleanup = null;
      detachProvider();
      listeners.clear();
    },
  };
};

const WALLETCONNECT_MODAL_RESET = 'Connection request reset. Please try again.';

const isWalletConnectModalReset = (state: WalletState): boolean =>
  state.kind === 'failed' &&
  state.providerId === 'walletconnect' &&
  state.failure.message === WALLETCONNECT_MODAL_RESET;

export const createWalletController = (options: WalletControllerOptions): WalletController => {
  let explicitSelectionStarted = false;
  let lastConnection: WalletConnection | null = null;
  const storage =
    options.storage === undefined
      ? undefined
      : {
          getItem: (key: string) =>
            explicitSelectionStarted && key === SESSION_KEY ? null : options.storage!.getItem(key),
          setItem: (key: string, value: string) => options.storage!.setItem(key, value),
          removeItem: (key: string) => options.storage!.removeItem(key),
        };
  const controller = createWalletControllerCore({
    ...options,
    ...(storage === undefined ? {} : { storage }),
  });

  const state = (): WalletState => {
    const current = controller.getState();
    if (isWalletConnectModalReset(current)) {
      lastConnection = null;
      return { kind: 'disconnected', providers: current.providers };
    }
    if (current.kind === 'connected-supported' || current.kind === 'connected-unsupported') {
      lastConnection = current.connection;
      return current;
    }
    if (current.kind === 'disconnected' || current.kind === 'discovering') {
      lastConnection = null;
      return current;
    }
    if (current.kind === 'failed' && current.connection === null && lastConnection !== null) {
      return { ...current, connection: lastConnection };
    }
    return current;
  };

  return {
    ...controller,
    getState: state,
    subscribe: (listener) =>
      controller.subscribe(() => {
        state();
        listener();
      }),
    connect: async (providerId) => {
      explicitSelectionStarted = true;
      lastConnection = null;
      await controller.connect(providerId);
      state();
    },
    connectWalletConnect: async () => {
      explicitSelectionStarted = true;
      lastConnection = null;
      await controller.connectWalletConnect();
      if (isWalletConnectModalReset(controller.getState())) controller.disconnect();
      state();
    },
    disconnect: () => {
      lastConnection = null;
      controller.disconnect();
    },
    stop: () => {
      lastConnection = null;
      controller.stop();
    },
  };
};
