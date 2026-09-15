import { useEffect, useRef, useState } from 'react';
import { diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import type { ReviewedRuntime } from '../runtime-config/load-reviewed-runtime-config';
import { createWalletController, type WalletController } from './wallet-controller';
import { initialWalletState, isWalletConnected, type WalletState } from './wallet-state';
import { loadWalletConnectProvider, openWalletConnectModal } from './walletconnect-provider';
import { showErrorToast } from '../ui/toast';

export interface WalletUiController {
  state: WalletState;
  connect(providerId: string): void;
  connectWalletConnect(): void;
  openWalletConnectModal(): boolean;
  disconnect(): void;
  switchChain(chainId: number): void;
}

const browserStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch (error) {
    emitDiagnostic({
      category: 'error',
      event: 'runtime',
      component: 'storage',
      operation: 'localStorage-access',
      ...diagnosticError(error),
    });
    return undefined;
  }
};

const journalWalletState = (state: WalletState): void => {
  const connection = isWalletConnected(state) ? state.connection : state.kind === 'failed' ? state.connection : null;
  const venue = state.kind === 'connected-supported' ? state.activeVenue : null;
  emitDiagnostic({
    category: 'wallet',
    event: 'state',
    providerType: connection?.provider.type ?? null,
    chainId: connection?.chainId ?? null,
    venueProfileId: venue?.id ?? null,
    venueDeploymentId: venue?.deploymentId ?? null,
    connected: connection !== null,
  });
};

export function useWalletController(runtime: ReviewedRuntime | null): WalletUiController {
  const controllerRef = useRef<WalletController | null>(null);
  const [state, setState] = useState<WalletState>(() => initialWalletState());
  const previousStateRef = useRef<WalletState>(state);

  useEffect(() => {
    journalWalletState(state);
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (state.kind === 'failed' && previous.kind !== 'failed') {
      emitDiagnostic({
        category: 'error',
        event: 'runtime',
        component: 'wallet',
        operation: 'connection',
        ...diagnosticError(state.failure),
      });
      showErrorToast(state.failure.message, 'Wallet connection failed');
    }
    if (isWalletConnected(state) && state.networkSwitch.kind === 'failed') {
      const alreadyFailed = isWalletConnected(previous) && previous.networkSwitch.kind === 'failed';
      if (!alreadyFailed) {
        emitDiagnostic({
          category: 'error',
          event: 'runtime',
          component: 'wallet',
          operation: 'switch-chain',
          ...diagnosticError(state.networkSwitch.failure),
        });
        showErrorToast(state.networkSwitch.failure.message, 'Network switch failed');
      }
    }
  }, [state]);

  useEffect(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    if (!runtime) {
      setState(initialWalletState());
      return undefined;
    }
    const browserGlobal = globalThis as typeof globalThis & { ethereum?: unknown };
    const storage = browserStorage();
    const controller = createWalletController({
      venues: runtime.venues,
      target: globalThis as unknown as EventTarget,
      ...(browserGlobal.ethereum === undefined ? {} : { legacyProvider: browserGlobal.ethereum }),
      ...(storage ? { storage } : {}),
      ...(runtime.evaluation.walletConnect.usable
        ? { walletConnectLoader: () => loadWalletConnectProvider(runtime.evaluation.walletConnect, runtime.venues) }
        : {}),
    });
    controllerRef.current = controller;
    setState(controller.getState());
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    return () => {
      unsubscribe();
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [runtime]);

  return {
    state,
    connect: (providerId) => {
      void controllerRef.current?.connect(providerId);
    },
    connectWalletConnect: () => {
      void controllerRef.current?.connectWalletConnect();
    },
    openWalletConnectModal,
    disconnect: () => controllerRef.current?.disconnect(),
    switchChain: (chainId) => {
      void controllerRef.current?.switchChain(chainId);
    },
  };
}
