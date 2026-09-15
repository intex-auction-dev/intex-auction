import { describe, expect, it } from 'vitest';
import type { CalendarRangeRead } from '@/discovery/calendar-evidence';
import type { VenueAuctionStage } from '@/protocol/read-model';
import { toUtcTimestamp, type WorldwideDayKey } from '@/domain/protocol-time';
import {
  defaultFirstMonth,
  discoveryPageFromHash,
  mostCurrentAuctionWorldwideDay,
  usesCompletionActionRail,
} from '@/app/public-discovery-controller';

const DAY_A = '20260817' as WorldwideDayKey;
const DAY_B = '20260818' as WorldwideDayKey;
const DAY_C = '20260819' as WorldwideDayKey;

const calendar = (
  ...auctions: readonly {
    worldwideDay: WorldwideDayKey;
    stage: VenueAuctionStage;
    commitEnd: bigint;
  }[]
): CalendarRangeRead => ({
  start: DAY_A,
  end: DAY_C,
  failures: [],
  days: auctions.map(
    ({ worldwideDay, stage, commitEnd }) =>
      ({
        worldwideDay,
        venueAuction: {
          stage,
          schedule: {
            commitEnd: toUtcTimestamp(commitEnd),
            revealEnd: toUtcTimestamp(commitEnd + 1n),
            issuanceEnd: toUtcTimestamp(commitEnd + 2n),
          },
        },
      }) as unknown as CalendarRangeRead['days'][number],
  ),
});

describe('public discovery routing', () => {
  it('maps the Portfolio hash to the distinct portfolio page', () => {
    expect(discoveryPageFromHash('#portfolio')).toBe('portfolio');
    expect(discoveryPageFromHash('')).toBe('auctions');
    expect(discoveryPageFromHash('#other')).toBe('auctions');
  });

  it('routes only completed and cancelled venue stages to the bidder result surface', () => {
    expect(usesCompletionActionRail('completed')).toBe(true);
    expect(usesCompletionActionRail('cancelled')).toBe(true);
    expect(usesCompletionActionRail('issuance')).toBe(false);
    expect(usesCompletionActionRail('revealing-bids')).toBe(false);
    expect(usesCompletionActionRail(null)).toBe(false);
  });

  it('defaults the calendar to the month before the selected day so recent history is visible', () => {
    expect(defaultFirstMonth('20260804' as WorldwideDayKey)).toEqual({ year: 2026, month: 7 });
    expect(defaultFirstMonth('20260815' as WorldwideDayKey)).toEqual({ year: 2026, month: 7 });
    expect(defaultFirstMonth('20260110' as WorldwideDayKey)).toEqual({ year: 2025, month: 12 });
  });
});

describe('startup auction selection', () => {
  it('prefers the latest live venue auction over terminal auctions', () => {
    expect(
      mostCurrentAuctionWorldwideDay(
        calendar(
          { worldwideDay: DAY_A, stage: 'revealing-bids', commitEnd: 100n },
          { worldwideDay: DAY_B, stage: 'committing-bids', commitEnd: 200n },
          { worldwideDay: DAY_C, stage: 'completed', commitEnd: 300n },
        ),
      ),
    ).toBe(DAY_B);
  });

  it('falls back to the latest delivered terminal auction when none is live', () => {
    expect(
      mostCurrentAuctionWorldwideDay(
        calendar(
          { worldwideDay: DAY_A, stage: 'completed', commitEnd: 100n },
          { worldwideDay: DAY_B, stage: 'cancelled', commitEnd: 300n },
          { worldwideDay: DAY_C, stage: 'completed', commitEnd: 200n },
        ),
      ),
    ).toBe(DAY_B);
  });

  it('returns null until venue auction evidence exists', () => {
    expect(
      mostCurrentAuctionWorldwideDay({
        ...calendar(),
        days: [
          {
            worldwideDay: DAY_A,
            venueAuction: null,
          } as unknown as CalendarRangeRead['days'][number],
        ],
      }),
    ).toBeNull();
  });
});
