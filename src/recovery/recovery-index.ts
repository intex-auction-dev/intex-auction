import { getAddress, type Address, type PublicClient } from 'viem';
import type { WorldwideDayKey } from '../domain/protocol-time';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import { fromViemPublicClient } from '../protocol/read-client';
import { VenueAuctionAdapter } from '../protocol/venue-adapter';
import { VenueAuctionNotFoundError } from '../chain/revert-classify';
import type { VenueEscrowRecoveryState } from '../protocol/profile-types';
import {
  projectAbandonedCommitBondRecovery,
  projectAuctionCommitBondRecovery,
  projectEscrowRefundRecovery,
  type RecoveryItem,
} from './recovery-domain';
import {
  loadWalletRecoveryHistory,
  type RecoveryEscrowHistoryContract,
  type WalletRecoveryHistory,
} from './wallet-recovery-history';

export type RecoveryIndexIssueKind = 'read-failure' | 'incompatible-historical-contract';

export interface RecoveryIndexIssue {
  readonly key: string;
  readonly kind: RecoveryIndexIssueKind;
  readonly worldwideDay: WorldwideDayKey | null;
  readonly escrowContract: Address | null;
  readonly message: string;
}

export interface WalletRecoveryIndex {
  readonly history: WalletRecoveryHistory;
  readonly items: readonly RecoveryItem[];
  readonly issues: readonly RecoveryIndexIssue[];
}

type EscrowSnapshot = VenueEscrowRecoveryState;

const asUint = (value: unknown, bits: number, label: string): bigint => {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${label} must be an unsigned integer.`);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (parsed < 0n || parsed > maximum) throw new RangeError(`${label} exceeds uint${bits}.`);
  return parsed;
};

const venueAdapter = (publicClient: PublicClient, profile: ResolvedVenueReadProfile): VenueAuctionAdapter =>
  new VenueAuctionAdapter(fromViemPublicClient(publicClient), profile);

export const readLatestBlockTimestamp = async (client: PublicClient): Promise<bigint> => {
  const block = await client.getBlock({ blockTag: 'latest' });
  return asUint(block.timestamp, 256, 'Latest block timestamp');
};

export const readEscrowRecoverySnapshot = (input: {
  readonly publicClient: PublicClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly escrowContract: Address;
  readonly worldwideDay: WorldwideDayKey;
  readonly bidder: Address;
}): Promise<EscrowSnapshot> =>
  venueAdapter(input.publicClient, input.profile).readEscrowRecoveryState(
    input.escrowContract,
    input.worldwideDay,
    input.bidder,
  );

const readAuctionRecoverySnapshot = (input: {
  readonly publicClient: PublicClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly worldwideDay: WorldwideDayKey;
}) => venueAdapter(input.publicClient, input.profile).readAuctionRecoveryState(input.worldwideDay);

const issue = (input: {
  readonly kind: RecoveryIndexIssueKind;
  readonly worldwideDay: WorldwideDayKey | null;
  readonly escrowContract: Address | null;
  readonly message: string;
}): RecoveryIndexIssue => ({
  key: [input.kind, input.worldwideDay ?? 'all', input.escrowContract?.toLowerCase() ?? 'none', input.message].join(
    ':',
  ),
  ...input,
});

const candidateUsesEscrow = (
  history: WalletRecoveryHistory,
  worldwideDay: WorldwideDayKey,
  wallet: Address,
  escrow: RecoveryEscrowHistoryContract,
): boolean =>
  history.events.some(
    (event) =>
      event.worldwideDay === worldwideDay &&
      event.bidder === getAddress(wallet) &&
      event.contract === getAddress(escrow.escrowContract),
  );

const sortItems = (left: RecoveryItem, right: RecoveryItem): number => {
  if (left.worldwideDay !== right.worldwideDay) return left.worldwideDay.localeCompare(right.worldwideDay);
  if (left.availability !== right.availability) return left.availability === 'claimable' ? -1 : 1;
  return left.path.localeCompare(right.path);
};

export const loadWalletRecoveryIndex = async (input: {
  readonly publicClient: PublicClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly wallet: Address;
  readonly candidateWorldwideDays?: readonly WorldwideDayKey[];
  readonly signal?: AbortSignal;
}): Promise<WalletRecoveryIndex> => {
  const [history, latestBlockTimestamp] = await Promise.all([
    loadWalletRecoveryHistory({
      client: fromViemPublicClient(input.publicClient),
      profile: input.profile,
      wallet: input.wallet,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    readLatestBlockTimestamp(input.publicClient),
  ]);
  const items: RecoveryItem[] = [];
  const issues: RecoveryIndexIssue[] = [];
  const currentEscrow = history.escrows.find((escrow) => escrow.custody === 'current') ?? null;

  for (const escrow of history.escrows) {
    if (!escrow.compatible) {
      const tiedCandidates = history.candidates.filter((worldwideDay) =>
        candidateUsesEscrow(history, worldwideDay, input.wallet, escrow),
      );
      for (const worldwideDay of tiedCandidates) {
        issues.push(
          issue({
            kind: escrow.custody === 'historical' ? 'incompatible-historical-contract' : 'read-failure',
            worldwideDay,
            escrowContract: escrow.escrowContract,
            message: escrow.compatibilityError ?? 'Escrow compatibility could not be established.',
          }),
        );
      }
    }
  }

  const candidates = [...new Set([...history.candidates, ...(input.candidateWorldwideDays ?? [])])].sort();
  const { chainId, deploymentId } = input.profile;
  const bidder = input.wallet;
  for (const worldwideDay of candidates) {
    for (const escrow of history.escrows) {
      const { escrowContract, paymentToken, associatedAuction, custody, compatible } = escrow;
      const currentAuctionCandidate =
        custody === 'current' &&
        history.events.some(
          (event) =>
            event.worldwideDay === worldwideDay &&
            event.bidder === getAddress(bidder) &&
            event.contract === getAddress(input.profile.addresses.intexAuction),
        );
      if (!candidateUsesEscrow(history, worldwideDay, bidder, escrow) && !currentAuctionCandidate) continue;
      if (!compatible || !paymentToken || !associatedAuction) continue;
      try {
        const snapshot = await readEscrowRecoverySnapshot({
          publicClient: input.publicClient,
          profile: input.profile,
          escrowContract,
          worldwideDay,
          bidder,
        });
        if (snapshot.paymentToken !== getAddress(paymentToken)) {
          throw new Error('The escrow payment-token getter changed from its retained wiring epoch.');
        }
        if (custody === 'current' && snapshot.auctionContract !== getAddress(associatedAuction)) {
          throw new Error('The current escrow auction getter changed from the reviewed wiring.');
        }
        const abandoned = projectAbandonedCommitBondRecovery({
          chainId,
          deploymentId,
          worldwideDay,
          bidder,
          auctionContract: associatedAuction,
          escrowContract,
          paymentToken,
          paymentTokenDecimals: snapshot.paymentTokenDecimals,
          paymentTokenSymbol: snapshot.paymentTokenSymbol,
          custody,
          latestBlockTimestamp,
          bond: snapshot.bond,
          delay: snapshot.constants.abandonedCommitBondDelay,
        });
        if (abandoned) items.push(abandoned);
        const refund = projectEscrowRefundRecovery({
          chainId,
          deploymentId,
          worldwideDay,
          bidder,
          auctionContract: associatedAuction,
          escrowContract,
          paymentToken,
          paymentTokenDecimals: snapshot.paymentTokenDecimals,
          paymentTokenSymbol: snapshot.paymentTokenSymbol,
          custody,
          latestBlockTimestamp,
          lock: snapshot.bidLock,
          escrowState: snapshot.escrowState,
          constants: snapshot.constants,
        });
        if (refund) {
          const finalizationNoOp = history.events.some(
            (event) =>
              event.family === 'FinalizationNoOp' &&
              event.worldwideDay === worldwideDay &&
              event.contract === getAddress(escrowContract),
          );
          items.push(
            finalizationNoOp
              ? {
                  ...refund,
                  explanation: `${refund.explanation} The aggregate FinalizationNoOp event did not settle this bidder; the live bidder lock remains authoritative.`,
                }
              : refund,
          );
        }
      } catch (error) {
        issues.push(
          issue({
            kind: custody === 'historical' ? 'incompatible-historical-contract' : 'read-failure',
            worldwideDay,
            escrowContract,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (currentEscrow?.compatible && currentEscrow.paymentToken && currentEscrow.associatedAuction) {
      try {
        const auction = await readAuctionRecoverySnapshot({
          publicClient: input.publicClient,
          profile: input.profile,
          worldwideDay,
        });
        if (
          auction.escrowContract !== getAddress(currentEscrow.escrowContract) ||
          auction.escrowContract !== getAddress(input.profile.addresses.escrowAdapter)
        ) {
          throw new Error('Current auction-to-escrow wiring does not match the reviewed venue profile.');
        }
        const escrowSnapshot = await readEscrowRecoverySnapshot({
          publicClient: input.publicClient,
          profile: input.profile,
          escrowContract: currentEscrow.escrowContract,
          worldwideDay,
          bidder,
        });
        const auctionBond = projectAuctionCommitBondRecovery({
          chainId,
          deploymentId,
          worldwideDay,
          bidder,
          auctionContract: input.profile.addresses.intexAuction,
          escrowContract: currentEscrow.escrowContract,
          paymentToken: currentEscrow.paymentToken,
          paymentTokenDecimals: escrowSnapshot.paymentTokenDecimals,
          paymentTokenSymbol: escrowSnapshot.paymentTokenSymbol,
          custody: 'current',
          stage: auction.stage,
          revealEnd: auction.revealEnd,
          latestBlockTimestamp,
          bond: escrowSnapshot.bond,
          unrevealedBondLockPeriod: auction.unrevealedBondLockPeriod,
        });
        if (auctionBond) items.push(auctionBond);
      } catch (error) {
        if (error instanceof VenueAuctionNotFoundError) continue;
        issues.push(
          issue({
            kind: 'read-failure',
            worldwideDay,
            escrowContract: currentEscrow.escrowContract,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  const auctionBondAuthorities = new Set<string>();
  for (const item of items) {
    if (item.path === 'auction-commit-bond') {
      auctionBondAuthorities.add(
        `${item.worldwideDay}:${item.bidder.toLowerCase()}:${item.escrowContract.toLowerCase()}`,
      );
    }
  }
  const classifiedItems = items.filter(
    (item) =>
      item.path !== 'escrow-abandoned-commit-bond' ||
      !auctionBondAuthorities.has(
        `${item.worldwideDay}:${item.bidder.toLowerCase()}:${item.escrowContract.toLowerCase()}`,
      ),
  );
  const deduplicated = new Map<string, RecoveryItem>();
  for (const item of classifiedItems) deduplicated.set(item.key, item);
  return {
    history,
    items: [...deduplicated.values()].sort(sortItems),
    issues: [...new Map(issues.map((entry) => [entry.key, entry])).values()],
  };
};

export const refreshRecoveryItem = async (input: {
  readonly publicClient: PublicClient;
  readonly profile: ResolvedVenueReadProfile;
  readonly item: RecoveryItem;
}): Promise<RecoveryItem | null> => {
  const [latestBlockTimestamp, escrow] = await Promise.all([
    readLatestBlockTimestamp(input.publicClient),
    readEscrowRecoverySnapshot({
      publicClient: input.publicClient,
      profile: input.profile,
      escrowContract: input.item.escrowContract,
      worldwideDay: input.item.worldwideDay,
      bidder: input.item.bidder,
    }),
  ]);
  if (escrow.paymentToken !== input.item.paymentToken) {
    throw new Error('Recovery payment-token wiring changed.');
  }
  if (input.item.custody === 'current' && escrow.auctionContract !== input.item.auctionContract) {
    throw new Error('Recovery auction wiring changed.');
  }

  if (input.item.path === 'auction-commit-bond') {
    const auction = await readAuctionRecoverySnapshot({
      publicClient: input.publicClient,
      profile: input.profile,
      worldwideDay: input.item.worldwideDay,
    });
    if (
      auction.escrowContract !== input.item.escrowContract ||
      input.item.auctionContract !== getAddress(input.profile.addresses.intexAuction)
    ) {
      throw new Error('Auction-side recovery no longer targets the current reviewed escrow.');
    }
    return projectAuctionCommitBondRecovery({
      chainId: input.profile.chainId,
      deploymentId: input.profile.deploymentId,
      worldwideDay: input.item.worldwideDay,
      bidder: input.item.bidder,
      auctionContract: input.item.auctionContract,
      escrowContract: input.item.escrowContract,
      paymentToken: input.item.paymentToken,
      paymentTokenDecimals: escrow.paymentTokenDecimals,
      paymentTokenSymbol: escrow.paymentTokenSymbol,
      custody: input.item.custody,
      stage: auction.stage,
      revealEnd: auction.revealEnd,
      latestBlockTimestamp,
      bond: escrow.bond,
      unrevealedBondLockPeriod: auction.unrevealedBondLockPeriod,
    });
  }
  if (input.item.path === 'escrow-abandoned-commit-bond') {
    return projectAbandonedCommitBondRecovery({
      chainId: input.profile.chainId,
      deploymentId: input.profile.deploymentId,
      worldwideDay: input.item.worldwideDay,
      bidder: input.item.bidder,
      auctionContract: input.item.auctionContract,
      escrowContract: input.item.escrowContract,
      paymentToken: input.item.paymentToken,
      paymentTokenDecimals: escrow.paymentTokenDecimals,
      paymentTokenSymbol: escrow.paymentTokenSymbol,
      custody: input.item.custody,
      latestBlockTimestamp,
      bond: escrow.bond,
      delay: escrow.constants.abandonedCommitBondDelay,
    });
  }
  return projectEscrowRefundRecovery({
    chainId: input.profile.chainId,
    deploymentId: input.profile.deploymentId,
    worldwideDay: input.item.worldwideDay,
    bidder: input.item.bidder,
    auctionContract: input.item.auctionContract,
    escrowContract: input.item.escrowContract,
    paymentToken: input.item.paymentToken,
    paymentTokenDecimals: escrow.paymentTokenDecimals,
    paymentTokenSymbol: escrow.paymentTokenSymbol,
    custody: input.item.custody,
    latestBlockTimestamp,
    lock: escrow.bidLock,
    escrowState: escrow.escrowState,
    constants: escrow.constants,
  });
};

export const sameRecoveryEconomics = (left: RecoveryItem, right: RecoveryItem): boolean =>
  left.key === right.key &&
  left.returnedAmount === right.returnedAmount &&
  left.burnedAmount === right.burnedAmount &&
  left.claimableAt === right.claimableAt &&
  left.availability === right.availability;
