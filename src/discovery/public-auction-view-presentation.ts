import type { CalendarWorldwideDay } from './calendar-evidence';
import type { PublicAuctionRead } from './load-public-auction';
import type { VenueAuctionStage } from '../protocol/read-model';
import type { PresentationTone } from '../ui/primitives';

export type LifecycleStepState = 'complete' | 'active' | 'upcoming';

export interface VenueLifecyclePresentation {
  cancelled: boolean;
  label: string;
  steps: readonly LifecycleStepState[];
  tone: PresentationTone;
}

export const venueLifecyclePresentation = (stage: VenueAuctionStage | null): VenueLifecyclePresentation => {
  switch (stage) {
    case 'committing-bids':
      return {
        cancelled: false,
        label: 'Accepting sealed bids',
        steps: ['active', 'upcoming', 'upcoming', 'upcoming'],
        tone: 'success',
      };
    case 'revealing-bids':
      return {
        cancelled: false,
        label: 'Reveal open',
        steps: ['complete', 'active', 'upcoming', 'upcoming'],
        tone: 'success',
      };
    case 'issuance':
      return {
        cancelled: false,
        label: 'Awaiting auction results',
        steps: ['complete', 'complete', 'active', 'upcoming'],
        tone: 'info',
      };
    case 'completed':
      return {
        cancelled: false,
        label: 'Intex issued',
        steps: ['complete', 'complete', 'complete', 'complete'],
        tone: 'info',
      };
    case 'cancelled':
      return {
        cancelled: true,
        label: 'Venue auction cancelled',
        steps: ['upcoming', 'upcoming', 'upcoming', 'upcoming'],
        tone: 'danger',
      };
    default:
      return {
        cancelled: false,
        label: 'Lifecycle unavailable',
        steps: ['upcoming', 'upcoming', 'upcoming', 'upcoming'],
        tone: 'neutral',
      };
  }
};

export interface VenueStatusPresentation {
  animated: boolean;
  kind: 'live' | 'ended' | 'cancelled' | 'pending' | 'unavailable';
  label: string;
  tone: PresentationTone;
}

export type CompletedAuctionOutcome = 'sale' | 'no-bids' | 'no-sale' | null;

export const completedAuctionOutcome = (
  auction: PublicAuctionRead | null,
  stage: VenueAuctionStage | null,
  day: CalendarWorldwideDay | null = null,
): CompletedAuctionOutcome => {
  if (stage !== 'completed') return null;
  if (day?.globalAuction.terminalDisposition === 'cleared-sale') return 'sale';
  if (day?.globalAuction.terminalDisposition === 'cleared-no-sale') return 'no-sale';
  const venueAuction = auction?.venue.kind === 'delivered' ? auction.venue.auction : day?.venueAuction;
  if (!venueAuction) return null;
  if (venueAuction.result.issuedIntexCount > 0) return 'sale';
  return venueAuction.runningCounts.revealedBids === 0 ? 'no-bids' : 'no-sale';
};

export const venueStatusPresentation = (
  auction: PublicAuctionRead | null,
  day: CalendarWorldwideDay | null,
): VenueStatusPresentation => {
  if (day?.venueParticipation === 'skipped') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'danger' };
  }
  if (day?.venueParticipation === 'not-applicable' || auction?.venue.kind === 'not-applicable') {
    const redDay = day?.dayType === 'red' || day?.globalAuction.terminalDisposition === 'cancelled-red';
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: redDay ? 'danger' : 'neutral' };
  }
  if (day?.dayType === 'red' || day?.globalAuction.terminalDisposition === 'cancelled-red') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'danger' };
  }
  if (day?.globalAuction.terminalDisposition === 'cancelled-unpriced') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'neutral' };
  }
  if ((day?.venueReceipt === 'delivery-pending' || auction?.venue.kind === 'delivery-pending') && !day?.venueStage) {
    return { animated: false, kind: 'pending', label: 'PENDING', tone: 'warning' };
  }
  if (auction?.venue.kind === 'failure' || day?.failures.some((failure) => failure.authority === 'venue')) {
    return { animated: false, kind: 'unavailable', label: 'UNAVAILABLE', tone: 'danger' };
  }
  const stage = auction?.venue.kind === 'delivered' ? auction.venue.auction.stage : (day?.venueStage ?? null);
  const completed = completedAuctionOutcome(auction, stage, day);
  if (completed === 'no-bids') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'danger' };
  }
  if (completed === 'no-sale') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'warning' };
  }
  if (stage === 'committing-bids' || stage === 'revealing-bids') {
    return { animated: true, kind: 'live', label: 'LIVE', tone: 'success' };
  }
  if (completed === 'sale') {
    return { animated: false, kind: 'ended', label: 'COMPLETE', tone: 'neutral' };
  }
  if (stage === 'issuance') {
    return { animated: false, kind: 'ended', label: 'ENDED', tone: 'neutral' };
  }
  if (stage === 'cancelled') {
    return { animated: false, kind: 'cancelled', label: 'CANCELLED', tone: 'danger' };
  }
  return { animated: false, kind: 'unavailable', label: 'UNAVAILABLE', tone: 'neutral' };
};

export const venueStatusClassName = (status: VenueStatusPresentation): string =>
  `auction-page-heading__status auction-page-heading__status--${status.kind}`;

export const authoritativeStage = (
  auction: PublicAuctionRead,
  day: CalendarWorldwideDay | null,
): VenueAuctionStage | null => {
  if (
    day?.venueParticipation === 'skipped' ||
    day?.venueParticipation === 'not-applicable' ||
    day?.venueReceipt === 'delivery-pending'
  )
    return null;
  if (
    auction.venue.kind === 'not-applicable' ||
    auction.venue.kind === 'delivery-pending' ||
    auction.venue.kind === 'failure'
  )
    return null;
  return auction.venue.auction.stage;
};

export const authoritativeSchedule = (
  auction: PublicAuctionRead,
  day: CalendarWorldwideDay | null,
): { commitEnd: bigint; revealEnd: bigint; issuanceEnd: bigint } | null => {
  if (auction.venue.kind === 'delivered') return auction.venue.auction.schedule;
  if (day?.scheduleAvailability.kind === 'available') return day.scheduleAvailability.schedule;
  return null;
};
