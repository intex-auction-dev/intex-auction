import type { Address } from 'viem';
import type { CalendarRangeRead } from '../discovery/calendar-evidence';
import type {
  ResolvedOutbeReadProfile,
  ResolvedVenueReadProfile,
} from '../runtime-config/load-reviewed-runtime-config';
import type { WalletState } from '../wallet/wallet-state';

export interface OriginContextIdentity {
  key: string;
}

export interface VenueContextIdentity {
  key: string;
}

export interface WalletContextIdentity {
  key: string;
  address: Address | null;
}

export const originContextIdentity = (profile: ResolvedOutbeReadProfile): OriginContextIdentity => ({
  key: [
    profile.id,
    profile.deploymentId,
    profile.chainId,
    profile.addresses.metadosis,
    profile.addresses.desis,
    profile.addresses.originRouter,
    profile.addresses.oracle,
    profile.addresses.intex,
  ].join(':'),
});

export const venueContextIdentity = (profile: ResolvedVenueReadProfile): VenueContextIdentity => ({
  key: [profile.id, profile.deploymentId, profile.chainId, profile.addresses.intexAuction].join(':'),
});

export const walletContextIdentity = (state: WalletState): WalletContextIdentity => {
  if (state.kind === 'connected-supported' || state.kind === 'connected-unsupported') {
    return {
      key: [
        state.connection.provider.type,
        state.connection.provider.id,
        state.connection.chainId,
        state.connection.address,
      ].join(':'),
      address: state.connection.address,
    };
  }
  return { key: `session:${state.kind}`, address: null };
};

export const retainOriginCalendarEvidence = (range: CalendarRangeRead): CalendarRangeRead => ({
  ...range,
  failures: range.failures.filter((failure) => failure.authority !== 'venue' && failure.authority !== 'origin-router'),
  days: range.days.map((day) => ({
    ...day,
    globalAuction: { ...day.globalAuction, venueBids: null },
    venueParticipation: day.terminalDisposition ? 'not-applicable' : 'unknown',
    originDelivery: { stageStart: 'not-observed', clearing: 'not-observed', result: 'not-observed' },
    venueReceipt: day.terminalDisposition ? 'not-applicable' : 'not-observed',
    venueStage: null,
    scheduleAvailability: day.terminalDisposition ? { kind: 'not-applicable' } : { kind: 'unavailable' },
    venueAuction: null,
    failures: day.failures.filter((failure) => failure.authority !== 'venue' && failure.authority !== 'origin-router'),
  })),
});

export const activeVenueForWallet = (
  runtime: { selectedVenue: ResolvedVenueReadProfile | null },
  state: WalletState,
): ResolvedVenueReadProfile | null => {
  if (state.kind === 'connected-supported') return state.activeVenue;
  if (state.kind === 'disconnected') return runtime.selectedVenue;
  if (state.kind === 'failed') return state.connection ? null : runtime.selectedVenue;
  return null;
};
