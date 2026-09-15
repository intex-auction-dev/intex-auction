import { describe, expect, it } from 'vitest';
import type { CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { authoritativeStage, venueStatusPresentation } from '@/discovery/public-auction-view';

const staleCalendarDay = {
  venueParticipation: 'included',
  venueReceipt: 'delivered',
  venueStage: 'revealing-bids',
  failures: [],
  globalAuction: { terminalDisposition: 'active' },
} as unknown as CalendarWorldwideDay;

const freshIssuanceAuction = {
  venue: { kind: 'delivered', auction: { stage: 'issuance' } },
} as unknown as PublicAuctionRead;

describe('live auction reconciliation', () => {
  it('prefers the fresh selected-auction read over the cached calendar stage', () => {
    expect(authoritativeStage(freshIssuanceAuction, staleCalendarDay)).toBe('issuance');
    expect(venueStatusPresentation(freshIssuanceAuction, staleCalendarDay)).toMatchObject({
      kind: 'ended',
      label: 'ENDED',
    });
  });
});
