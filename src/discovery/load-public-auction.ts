import { HttpRequestError, TimeoutError } from 'viem';
import type { WorldwideDayKey } from '../domain/protocol-time';
import { createPublicReadClient, RpcEndpointSelectionError } from '../chain/create-public-read-client';
import { diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import type {
  ResolvedOutbeReadProfile,
  ResolvedVenueReadProfile,
} from '../runtime-config/load-reviewed-runtime-config';
import { fromViemPublicClient } from '../protocol/read-client';
import { OutbeAuctionAdapter } from '../protocol/origin-adapter';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import {
  IncompatibleDeploymentError,
  IncompatibleWiringError,
  VenueAuctionNotFoundError,
} from '../chain/revert-classify';
import type {
  CanonicalSeriesSnapshot,
  GlobalAuctionSnapshot,
  OriginTerminalEvidence,
  VenueAuctionSnapshot,
  WorldwideDaySnapshot,
} from '../protocol/profile-types';

export type PublicReadFailureKind =
  | 'rpc'
  | 'incompatible-deployment'
  | 'incompatible-wiring'
  | 'malformed-response'
  | 'contract-failure';

export interface PublicReadFailure {
  kind: PublicReadFailureKind;
  message: string;
}

export type OriginReadState =
  | {
      kind: 'retained';
      worldwideDay: WorldwideDaySnapshot;
      terminal: OriginTerminalEvidence | null;
      globalAuction: GlobalAuctionSnapshot;
      canonicalSeries: CanonicalSeriesSnapshot | null;
    }
  | { kind: 'not-found' }
  | {
      kind: 'history-unavailable';
      terminal: OriginTerminalEvidence | null;
      cleanedFinalLifecycle: 'completed' | 'failed' | null;
    }
  | { kind: 'failure'; failure: PublicReadFailure };

export type VenueReadState =
  | { kind: 'delivered'; auction: VenueAuctionSnapshot }
  | { kind: 'delivery-pending' }
  | { kind: 'not-applicable'; reason: 'terminal-origin-no-auction' }
  | { kind: 'failure'; failure: PublicReadFailure };

export interface PublicAuctionRead {
  worldwideDay: WorldwideDayKey;
  originIdentity: { name: string; chainId: number };
  venueIdentity: { name: string; chainId: number };
  origin: OriginReadState;
  venue: VenueReadState;
}

export interface PublicAuctionAdapters {
  origin: Pick<
    OutbeAuctionAdapter,
    'validateDeployment' | 'readWorldwideDayState' | 'readGlobalAuction' | 'readCanonicalSeries'
  >;
  venue: Pick<VenueAuctionAdapter, 'validateDeployment' | 'readAuction'>;
}

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
};

export const classifyPublicReadFailure = (error: unknown): PublicReadFailure => {
  const chain = errorChain(error);
  const message =
    chain.find((candidate): candidate is Error => candidate instanceof Error)?.message ??
    'Unknown contract read failure.';
  if (
    error instanceof RpcEndpointSelectionError ||
    chain.some((candidate) => candidate instanceof HttpRequestError || candidate instanceof TimeoutError)
  ) {
    return { kind: 'rpc', message };
  }
  if (error instanceof IncompatibleDeploymentError) {
    return { kind: 'incompatible-deployment', message: error.message };
  }
  if (error instanceof IncompatibleWiringError) {
    return { kind: 'incompatible-wiring', message: error.message };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { kind: 'malformed-response', message: error.message };
  }
  return {
    kind: 'contract-failure',
    message,
  };
};

const readOrigin = async (
  adapter: PublicAuctionAdapters['origin'],
  worldwideDay: WorldwideDayKey,
  venueChainId: number,
): Promise<OriginReadState> => {
  try {
    await adapter.validateDeployment();
    const day = await adapter.readWorldwideDayState(worldwideDay);
    if (day.kind !== 'retained') return day;
    const [globalAuction, canonicalSeries] = await Promise.all([
      adapter.readGlobalAuction(worldwideDay, venueChainId),
      Promise.resolve(null),
    ]);
    return {
      kind: 'retained',
      worldwideDay: day.snapshot,
      terminal: day.terminal,
      globalAuction,
      canonicalSeries,
    };
  } catch (error) {
    return { kind: 'failure', failure: classifyPublicReadFailure(error) };
  }
};

const readVenue = async (
  adapter: PublicAuctionAdapters['venue'],
  worldwideDay: WorldwideDayKey,
): Promise<VenueReadState> => {
  try {
    await adapter.validateDeployment();
    return { kind: 'delivered', auction: await adapter.readAuction(worldwideDay) };
  } catch (error) {
    if (error instanceof VenueAuctionNotFoundError) return { kind: 'delivery-pending' };
    return { kind: 'failure', failure: classifyPublicReadFailure(error) };
  }
};

const journalReadFailure = (component: 'origin' | 'venue', failure: PublicReadFailure): void => {
  const sanitized = diagnosticError(failure);
  emitDiagnostic({
    category: 'error',
    event: 'runtime',
    component: `auction-${component}`,
    operation: failure.kind,
    name: `PublicReadFailure:${failure.kind}`,
    message: sanitized.message,
  });
};

export const loadPublicAuctionWithAdapters = async (
  originProfile: Pick<ResolvedOutbeReadProfile, 'name' | 'chainId'>,
  venueProfile: Pick<ResolvedVenueReadProfile, 'name' | 'chainId'>,
  adapters: PublicAuctionAdapters,
  worldwideDay: WorldwideDayKey,
): Promise<PublicAuctionRead> => {
  const [origin, rawVenue] = await Promise.all([
    readOrigin(adapters.origin, worldwideDay, venueProfile.chainId),
    readVenue(adapters.venue, worldwideDay),
  ]);
  const publicVenue: VenueReadState =
    rawVenue.kind === 'delivered'
      ? {
          kind: 'delivered',
          auction: {
            ...rawVenue.auction,
            params: {
              ...rawVenue.auction.params,
              issuanceCurrency: 0,
              issuanceCurrencies: [],
              issuanceEntryPrices: [],
              strikeAmountsMinor: [],
              oraclePairIds: [],
            },
          },
        }
      : rawVenue;
  const originProvesNoAuction =
    (origin.kind === 'retained' &&
      (origin.terminal !== null ||
        ((origin.worldwideDay.lifecycle === 'completed' || origin.worldwideDay.lifecycle === 'failed') &&
          origin.globalAuction.stage === 'none'))) ||
    (origin.kind === 'history-unavailable' && origin.terminal !== null);
  const venue =
    publicVenue.kind === 'delivery-pending' && originProvesNoAuction
      ? ({ kind: 'not-applicable', reason: 'terminal-origin-no-auction' } as const)
      : publicVenue;

  if (origin.kind === 'failure') journalReadFailure('origin', origin.failure);
  if (venue.kind === 'failure') journalReadFailure('venue', venue.failure);
  emitDiagnostic({
    category: 'auction',
    event: 'context',
    worldwideDay,
    stage: venue.kind === 'delivered' ? venue.auction.stage : venue.kind,
    readState: `${origin.kind}/${venue.kind}`,
  });

  return {
    worldwideDay,
    originIdentity: { name: originProfile.name, chainId: originProfile.chainId },
    venueIdentity: { name: venueProfile.name, chainId: venueProfile.chainId },
    origin,
    venue,
  };
};

export const loadPublicAuction = async (
  originProfile: ResolvedOutbeReadProfile,
  venueProfile: ResolvedVenueReadProfile,
  worldwideDay: WorldwideDayKey,
): Promise<PublicAuctionRead> => {
  const [originClient, venueClient] = await Promise.allSettled([
    createPublicReadClient(originProfile),
    createPublicReadClient(venueProfile),
  ]);

  const originAdapter =
    originClient.status === 'fulfilled'
      ? new OutbeAuctionAdapter(fromViemPublicClient(originClient.value.client), originProfile)
      : {
          validateDeployment: async () => {
            throw originClient.reason;
          },
          readWorldwideDayState: async () => {
            throw originClient.reason;
          },
          readGlobalAuction: async () => {
            throw originClient.reason;
          },
          readCanonicalSeries: async () => {
            throw originClient.reason;
          },
        };
  const venueAdapter =
    venueClient.status === 'fulfilled'
      ? new VenueAuctionAdapter(fromViemPublicClient(venueClient.value.client), venueProfile)
      : {
          validateDeployment: async () => {
            throw venueClient.reason;
          },
          readAuction: async () => {
            throw venueClient.reason;
          },
        };

  return loadPublicAuctionWithAdapters(
    originProfile,
    venueProfile,
    { origin: originAdapter, venue: venueAdapter },
    worldwideDay,
  );
};
