import type { Abi, Address } from 'viem';
import type { OutbeDeploymentProfile, VenueDeploymentProfile } from '../chain/deployment-profile';
import { diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import {
  loadRuntimeConfigData,
  type RuntimeConfigEvaluation,
  type RuntimeConfigFetch,
  type RuntimeProfileEvaluation,
  type RuntimeTiming,
  type VenueAdapterProfile,
} from './runtime-config';

export interface ResolvedRpcReadProfile {
  id: string;
  name: string;
  deploymentId: string;
  deploymentBlock: bigint;
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number } | null;
  walletConnectRpcUrl: string | null;
  rpcUrls: readonly string[];
  explorerUrl: string | null;
  confirmationDepth: number;
  logBatchSize: number;
  requestTimeoutMs: number;
  readRetryCount: number;
}

export interface ResolvedOutbeReadProfile extends ResolvedRpcReadProfile, OutbeDeploymentProfile {
  oraclePair: { base: Address; quote: Address };
}

export interface ResolvedVenueReadProfile extends ResolvedRpcReadProfile, VenueDeploymentProfile {
  adapterProfile?: VenueAdapterProfile;
}

export interface ReviewedRuntime {
  evaluation: RuntimeConfigEvaluation;
  origin: ResolvedOutbeReadProfile | null;
  venues: ResolvedVenueReadProfile[];
  selectedVenue: ResolvedVenueReadProfile | null;
  timing: RuntimeTiming | null;
}

const required = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`Missing validated ${label}.`);
  return value;
};

const address = (profile: RuntimeProfileEvaluation, key: string): Address =>
  required(profile.addresses[key], `${profile.id}.${key} address`);

const abi = (profile: RuntimeProfileEvaluation, key: string, abiDocuments: ReadonlyMap<string, Abi>): Abi => {
  const file = required(profile.abiFiles[key], `${profile.id}.${key} ABI reference`);
  return required(abiDocuments.get(file), `${profile.id}.${key} ABI document`);
};

const rpcBase = (profile: RuntimeProfileEvaluation): ResolvedRpcReadProfile => ({
  id: profile.id,
  name: profile.name,
  deploymentId: required(profile.deploymentId, `${profile.id} deployment identity`),
  deploymentBlock: BigInt(required(profile.deploymentBlock, `${profile.id} deployment block`)),
  chainId: required(profile.chainId, `${profile.id} chain identity`),
  nativeCurrency: profile.nativeCurrency,
  walletConnectRpcUrl: profile.walletConnectRpcUrl,
  rpcUrls: [...profile.rpcUrls],
  explorerUrl: profile.explorerUrl,
  confirmationDepth: required(profile.confirmationDepth, `${profile.id} confirmation depth`),
  logBatchSize: required(profile.logBatchSize, `${profile.id} log batch size`),
  requestTimeoutMs: required(profile.requestTimeoutMs, `${profile.id} request timeout`),
  readRetryCount: required(profile.readRetryCount, `${profile.id} read retry count`),
});

const resolveOrigin = (
  profile: RuntimeProfileEvaluation,
  abiDocuments: ReadonlyMap<string, Abi>,
): ResolvedOutbeReadProfile => ({
  ...rpcBase(profile),
  addresses: {
    metadosis: address(profile, 'metadosis'),
    desis: address(profile, 'desis'),
    originRouter: address(profile, 'originRouter'),
    oracle: address(profile, 'oracle'),
    intex: address(profile, 'intex'),
  },
  abis: {
    metadosis: abi(profile, 'metadosis', abiDocuments),
    desis: abi(profile, 'desis', abiDocuments),
    originRouter: abi(profile, 'originRouter', abiDocuments),
    oracle: abi(profile, 'oracle', abiDocuments),
    intex: abi(profile, 'intex', abiDocuments),
  },
  oraclePair: required(profile.oraclePair, `${profile.id} Oracle pair`),
});

const resolveVenue = (
  profile: RuntimeProfileEvaluation,
  abiDocuments: ReadonlyMap<string, Abi>,
): ResolvedVenueReadProfile => ({
  ...rpcBase(profile),
  adapterProfile: required(profile.adapterProfile, `${profile.id} adapter profile`),
  addresses: {
    intexAuction: address(profile, 'intexAuction'),
    ...(profile.addresses.intexAuctionImplementation
      ? { intexAuctionImplementation: profile.addresses.intexAuctionImplementation }
      : {}),
    escrowAdapter: address(profile, 'escrowAdapter'),
    theCompact: address(profile, 'theCompact'),
    targetRouter: address(profile, 'targetRouter'),
    intexNFT1155: address(profile, 'intexNFT1155'),
    paymentToken: address(profile, 'paymentToken'),
  },
  abis: {
    intexAuction: abi(profile, 'intexAuction', abiDocuments),
    escrowAdapter: abi(profile, 'escrowAdapter', abiDocuments),
    targetRouter: abi(profile, 'targetRouter', abiDocuments),
    intexNFT1155: abi(profile, 'intexNFT1155', abiDocuments),
    paymentToken: abi(profile, 'paymentToken', abiDocuments),
  },
});

const defaultFetch: RuntimeConfigFetch = (input, init) => globalThis.fetch(input, init);

const journalRuntime = (runtime: ReviewedRuntime): void => {
  emitDiagnostic({
    category: 'runtime',
    event: 'loaded',
    originProfileId: runtime.origin?.id ?? null,
    venueProfileId: runtime.selectedVenue?.id ?? null,
    originDeploymentId: runtime.origin?.deploymentId ?? null,
    venueDeploymentId: runtime.selectedVenue?.deploymentId ?? null,
    originChainId: runtime.origin?.chainId ?? null,
    venueChainId: runtime.selectedVenue?.chainId ?? null,
  });
};

export const loadReviewedRuntimeConfig = async (
  fetcher: RuntimeConfigFetch = defaultFetch,
): Promise<ReviewedRuntime> => {
  try {
    const { evaluation, abiDocuments } = await loadRuntimeConfigData(fetcher);
    if (evaluation.state !== 'ready') {
      const runtime: ReviewedRuntime = {
        evaluation,
        origin: null,
        venues: [],
        selectedVenue: null,
        timing:
          evaluation.timing.bidsFanInTimeoutSeconds === null
            ? null
            : { bidsFanInTimeoutSeconds: evaluation.timing.bidsFanInTimeoutSeconds },
      };
      journalRuntime(runtime);
      return runtime;
    }

    const originEvaluation = required(
      evaluation.originProfile?.readCapable ? evaluation.originProfile : null,
      'Outbe origin profile',
    );
    const origin = resolveOrigin(originEvaluation, abiDocuments);
    const venues = evaluation.venueProfiles
      .filter((profile) => profile.readCapable)
      .map((profile) => resolveVenue(profile, abiDocuments));
    const selectedVenue = venues.find((venue) => venue.chainId === evaluation.defaultDisconnectedVenueChainId) ?? null;

    if (!selectedVenue) throw new Error('The configured disconnected venue could not be resolved.');
    const runtime: ReviewedRuntime = {
      evaluation,
      origin,
      venues,
      selectedVenue,
      timing:
        evaluation.timing.bidsFanInTimeoutSeconds === null
          ? null
          : { bidsFanInTimeoutSeconds: evaluation.timing.bidsFanInTimeoutSeconds },
    };
    journalRuntime(runtime);
    return runtime;
  } catch (error) {
    emitDiagnostic({
      category: 'error',
      event: 'runtime',
      component: 'runtime-config',
      operation: 'load',
      ...diagnosticError(error),
    });
    throw error;
  }
};
