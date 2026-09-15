import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CalendarWorldwideDay } from '@/discovery/calendar-evidence';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import { venueStatusPresentation } from '@/discovery/public-auction-view';
import { CalendarSelectionSummary } from '@/discovery/public-discovery-view';

const completedDay = {
  worldwideDay: '20260803',
  dayType: 'green',
  venueParticipation: 'included',
  venueReceipt: 'result-received',
  venueStage: 'completed',
  failures: [],
  globalAuction: { terminalDisposition: 'cleared-sale' },
} as unknown as CalendarWorldwideDay;

const completedAuction = {
  venue: {
    kind: 'delivered',
    auction: {
      stage: 'completed',
      runningCounts: { revealedBids: 3 },
      result: { issuedIntexCount: 2 },
    },
  },
} as unknown as PublicAuctionRead;

describe('auction status consistency', () => {
  it('presents a successful target-completed auction as Complete in both detail and calendar UI', () => {
    expect(venueStatusPresentation(completedAuction, completedDay).label).toBe('COMPLETE');
    expect(renderToStaticMarkup(<CalendarSelectionSummary day={completedDay} />)).toContain('>Complete</span>');
  });

  it('does not present global clearing as completion while the target result is still pending', () => {
    const pendingTarget = {
      ...completedDay,
      venueReceipt: 'delivery-pending',
      venueStage: null,
    } as unknown as CalendarWorldwideDay;

    const markup = renderToStaticMarkup(<CalendarSelectionSummary day={pendingTarget} />);
    expect(markup).toContain('>Pending</span>');
    expect(markup).not.toContain('>Cleared</span>');
  });
});
