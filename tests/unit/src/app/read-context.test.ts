import { describe, expect, it } from 'vitest';
import type { CalendarRangeRead } from '@/discovery/calendar-evidence';
import { activeVenueForWallet, retainOriginCalendarEvidence } from '@/app/read-context';

const range = {
  start: '20260801',
  end: '20261029',
  failures: [
    { authority: 'venue', kind: 'rpc', message: 'venue failed' },
    { authority: 'metadosis', kind: 'rpc', message: 'origin failed' },
  ],
  days: [
    {
      worldwideDay: '20260801',
      originRecord: { kind: 'not-found' },
      lifecycle: null,
      dayType: null,
      terminalDisposition: null,
      globalAuction: {
        stage: 'started',
        terminalDisposition: 'active',
        totalBids: 4n,
        venueBids: 2n,
        grossIncludedDemand: null,
        clearingRate: null,
        issuedIntexCount: null,
        offeredQuantity: null,
        offeredQuantityEvidence: 'unavailable',
      },
      venueParticipation: 'included',
      originDelivery: { stageStart: 'dispatched', clearing: 'not-observed', result: 'not-observed' },
      venueReceipt: 'stage-received',
      venueStage: 'committing-bids',
      scheduleAvailability: { kind: 'available', schedule: { commitEnd: 1n, revealEnd: 2n, issuanceEnd: 3n } },
      venueAuction: { stage: 'committing-bids' },
      canonicalSeries: null,
      failures: [{ authority: 'venue', kind: 'rpc', message: 'venue failed' }],
    },
  ],
} as unknown as CalendarRangeRead;

describe('read context isolation', () => {
  it('retains canonical origin evidence while clearing venue-derived state', () => {
    const retained = retainOriginCalendarEvidence(range);
    const day = retained.days[0]!;
    expect(day.globalAuction.totalBids).toBe(4n);
    expect(day.globalAuction.venueBids).toBeNull();
    expect(day.venueAuction).toBeNull();
    expect(day.venueStage).toBeNull();
    expect(day.originDelivery.stageStart).toBe('not-observed');
    expect(retained.failures.map((failure) => failure.authority)).toEqual(['metadosis']);
  });

  it('uses the disconnected default, wallet venue, or no venue without fallback leakage', () => {
    const configured = { chainId: 56, id: 'default' } as never;
    const active = { chainId: 31337, id: 'active' } as never;
    const runtime = { selectedVenue: configured };
    expect(activeVenueForWallet(runtime, { kind: 'disconnected', providers: [] })).toBe(configured);
    expect(
      activeVenueForWallet(runtime, {
        kind: 'connected-supported',
        providers: [],
        connection: {
          provider: { id: 'p', sessionId: 'p', type: 'injected', name: 'P', provider: { request: async () => null } },
          address: '0x0000000000000000000000000000000000000001',
          chainId: 31337,
        },
        activeVenue: active,
        networkSwitch: { kind: 'idle' },
      }),
    ).toBe(active);
    expect(
      activeVenueForWallet(runtime, {
        kind: 'connected-unsupported',
        providers: [],
        connection: {
          provider: { id: 'p', sessionId: 'p', type: 'injected', name: 'P', provider: { request: async () => null } },
          address: '0x0000000000000000000000000000000000000001',
          chainId: 1,
        },
        activeVenue: null,
        networkSwitch: { kind: 'idle' },
      }),
    ).toBeNull();
  });
});
