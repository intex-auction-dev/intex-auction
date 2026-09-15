import type { Address } from 'viem';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import type { ProviderRequestFailure } from './eip1193';
import type { WalletProviderDescriptor } from './injected-providers';

export interface WalletConnection {
  provider: WalletProviderDescriptor;
  address: Address;
  chainId: number;
}

export type NetworkSwitchState =
  | { kind: 'idle' }
  | { kind: 'pending'; chainId: number }
  | { kind: 'failed'; chainId: number; failure: ProviderRequestFailure };

interface WalletStateBase {
  providers: readonly WalletProviderDescriptor[];
}

export type WalletState =
  | (WalletStateBase & { kind: 'discovering' })
  | (WalletStateBase & { kind: 'disconnected' })
  | (WalletStateBase & { kind: 'connecting'; providerId: string })
  | (WalletStateBase & { kind: 'reconnecting'; providerId: string })
  | (WalletStateBase & {
      kind: 'connected-supported';
      connection: WalletConnection;
      activeVenue: ResolvedVenueReadProfile;
      networkSwitch: NetworkSwitchState;
    })
  | (WalletStateBase & {
      kind: 'connected-unsupported';
      connection: WalletConnection;
      activeVenue: null;
      networkSwitch: NetworkSwitchState;
    })
  | (WalletStateBase & {
      kind: 'failed';
      providerId: string | null;
      connection: WalletConnection | null;
      failure: ProviderRequestFailure;
    });

export type WalletAction =
  | { type: 'providers'; providers: readonly WalletProviderDescriptor[] }
  | { type: 'connecting'; providerId: string; reconnecting: boolean }
  | { type: 'connected'; connection: WalletConnection; venue: ResolvedVenueReadProfile | null }
  | { type: 'disconnected' }
  | { type: 'failed'; providerId: string | null; connection: WalletConnection | null; failure: ProviderRequestFailure }
  | { type: 'switch-pending'; chainId: number }
  | { type: 'switch-failed'; chainId: number; failure: ProviderRequestFailure }
  | { type: 'switch-idle' };

export const initialWalletState = (): WalletState => ({ kind: 'discovering', providers: [] });

export const walletReducer = (state: WalletState, action: WalletAction): WalletState => {
  switch (action.type) {
    case 'providers':
      if (state.kind === 'discovering') return { kind: 'disconnected', providers: action.providers };
      return { ...state, providers: action.providers };
    case 'connecting':
      return {
        kind: action.reconnecting ? 'reconnecting' : 'connecting',
        providers: state.providers,
        providerId: action.providerId,
      };
    case 'connected':
      return action.venue
        ? {
            kind: 'connected-supported',
            providers: state.providers,
            connection: action.connection,
            activeVenue: action.venue,
            networkSwitch: { kind: 'idle' },
          }
        : {
            kind: 'connected-unsupported',
            providers: state.providers,
            connection: action.connection,
            activeVenue: null,
            networkSwitch: { kind: 'idle' },
          };
    case 'disconnected':
      return { kind: 'disconnected', providers: state.providers };
    case 'failed':
      return {
        kind: 'failed',
        providers: state.providers,
        providerId: action.providerId,
        connection: action.connection,
        failure: action.failure,
      };
    case 'switch-pending':
      if (state.kind !== 'connected-supported' && state.kind !== 'connected-unsupported') return state;
      return { ...state, networkSwitch: { kind: 'pending', chainId: action.chainId } };
    case 'switch-failed':
      if (state.kind !== 'connected-supported' && state.kind !== 'connected-unsupported') return state;
      return { ...state, networkSwitch: { kind: 'failed', chainId: action.chainId, failure: action.failure } };
    case 'switch-idle':
      if (state.kind !== 'connected-supported' && state.kind !== 'connected-unsupported') return state;
      return { ...state, networkSwitch: { kind: 'idle' } };
  }
};

export const isWalletConnected = (
  state: WalletState,
): state is Extract<
  WalletState,
  {
    kind: 'connected-supported' | 'connected-unsupported';
  }
> => state.kind === 'connected-supported' || state.kind === 'connected-unsupported';
