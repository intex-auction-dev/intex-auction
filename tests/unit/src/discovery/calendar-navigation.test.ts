import { describe, expect, it } from 'vitest';
import type { CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import { calendarDayOpensAuction } from '@/discovery/public-discovery-view';
import type { WorldwideDayKey } from '@/domain/protocol-time';

const day = (overrides: Partial<CalendarWorldwideDay> = {}): CalendarWorldwideDay => ({
  worldwideDay: '20260803' as WorldwideDayKey,
  originRecord: { kind: 'not-found' },
  lifecycle: null,
  dayType: null,
  terminalDisposition: null,
  globalAuction: {
    stage: null,
    terminalDisposition: 'none',
    totalBids: null,
    venueBids: null,
    grossIncludedDemand: null,
    clearingRate: null,
    issuedIntexCount: null,
    offeredQuantity: null,
    offeredQuantityEvidence: 'unavailable',
  },
  venueParticipation: 'unknown',
  originDelivery: { stageStart: 'not-observed', clearing: 'not-observed', result: 'not-observed' },
  venueReceipt: 'not-observed',
  venueStage: null,
  scheduleAvailability: { kind: 'unavailable' },
  venueAuction: null,
  canonicalSeries: null,
  failures: [],
  ...overrides,
});

describe('calendar auction navigation', () => {
  it('opens days backed by canonical, global, router, or venue evidence', () => {
    expect(calendarDayOpensAuction(day({ originRecord: { kind: 'retained', snapshot: {} as never } }))).toBe(true);
    expect(
      calendarDayOpensAuction(
        day({ originRecord: { kind: 'cleaned-history-unavailable', finalLifecycle: 'completed' } }),
      ),
    ).toBe(true);
    expect(
      calendarDayOpensAuction(day({ globalAuction: { ...day().globalAuction, terminalDisposition: 'cleared-sale' } })),
    ).toBe(true);
    expect(
      calendarDayOpensAuction(
        day({ originDelivery: { stageStart: 'not-observed', clearing: 'dispatched', result: 'not-observed' } }),
      ),
    ).toBe(true);
    expect(calendarDayOpensAuction(day({ venueStage: 'committing-bids' }))).toBe(true);
  });

  it('does not invent navigation from missing or failure-only evidence', () => {
    expect(calendarDayOpensAuction(undefined)).toBe(false);
    expect(calendarDayOpensAuction(day())).toBe(false);
    expect(calendarDayOpensAuction(day({ venueReceipt: 'not-applicable', venueParticipation: 'not-applicable' }))).toBe(
      false,
    );
    expect(
      calendarDayOpensAuction(
        day({
          originRecord: { kind: 'failure', failure: { authority: 'metadosis', kind: 'rpc', message: 'offline' } },
          failures: [{ authority: 'metadosis', kind: 'rpc', message: 'offline' }],
        }),
      ),
    ).toBe(false);
  });
});
