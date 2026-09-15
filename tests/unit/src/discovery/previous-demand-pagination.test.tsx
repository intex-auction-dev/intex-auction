import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CalendarRangeRead } from '@/discovery/calendar-evidence';
import type { WorldwideDayKey } from '@/domain/protocol-time';
import {
  DemandPopover,
  previousDemandPage,
  previousDemandPoints,
  type PreviousDemandPoint,
} from '@/discovery/public-discovery-view';

const demandPoint = (day: number): PreviousDemandPoint => ({
  cancelled: false,
  date: `202607${String(day).padStart(2, '0')}` as WorldwideDayKey,
  ratio: 1 + day / 100,
});

describe('previous demand pagination', () => {
  it('pages backward from the latest seven auctions even when the total is not a multiple of seven', () => {
    const points = Array.from({ length: 15 }, (_, index) => demandPoint(index + 1));

    expect(previousDemandPage(points, 0).data.map((point) => point.date)).toEqual(
      points.slice(8).map((point) => point.date),
    );
    expect(previousDemandPage(points, 1).data.map((point) => point.date)).toEqual(
      points.slice(1, 8).map((point) => point.date),
    );
    expect(previousDemandPage(points, 2).data.map((point) => point.date)).toEqual([points[0]!.date]);
  });

  it('keeps the earlier arrow enabled when older demand can be loaded on demand', () => {
    const html = renderToStaticMarkup(
      <DemandPopover
        data={Array.from({ length: 6 }, (_, index) => demandPoint(index + 1))}
        canLoadEarlier
        onLoadEarlier={async () => true}
      />,
    );

    expect(html).toContain('aria-label="Earlier auctions"');
    expect(html).not.toContain('aria-label="Earlier auctions" disabled=""');
    expect(html).toContain('aria-label="Later auctions" disabled=""');
  });

  it('disables both chevrons when there is no data and no earlier data can be loaded', () => {
    const html = renderToStaticMarkup(<DemandPopover data={[]} canLoadEarlier={false} />);

    expect(html).toContain('aria-label="Earlier auctions" disabled=""');
    expect(html).toContain('aria-label="Later auctions" disabled=""');
  });

  it('disables both chevrons when data fits on one page and no earlier loading available', () => {
    const html = renderToStaticMarkup(
      <DemandPopover data={Array.from({ length: 5 }, (_, index) => demandPoint(index + 1))} canLoadEarlier={false} />,
    );

    expect(html).toContain('aria-label="Earlier auctions" disabled=""');
    expect(html).toContain('aria-label="Later auctions" disabled=""');
  });

  it('disables earlier chevron when data is empty even if load callback is available', () => {
    const html = renderToStaticMarkup(<DemandPopover data={[]} canLoadEarlier onLoadEarlier={async () => true} />);

    expect(html).toContain('aria-label="Earlier auctions" disabled=""');
    expect(html).toContain('aria-label="Later auctions" disabled=""');
  });

  it('extracts demand from an older range that does not contain the selected auction day', () => {
    const range = {
      start: '20260701' as WorldwideDayKey,
      end: '20260702' as WorldwideDayKey,
      failures: [],
      days: [
        {
          worldwideDay: '20260701' as WorldwideDayKey,
          dayType: 'green',
          lifecycle: 'completed',
          globalAuction: { grossIncludedDemand: 15n, offeredQuantity: 10n },
        },
        {
          worldwideDay: '20260702' as WorldwideDayKey,
          dayType: 'red',
          lifecycle: 'failed',
          globalAuction: { grossIncludedDemand: null, offeredQuantity: null },
        },
      ],
    } as unknown as CalendarRangeRead;

    expect(previousDemandPoints(range, '20260803' as WorldwideDayKey)).toEqual([
      { cancelled: false, date: '20260701', ratio: 1.5 },
      { cancelled: true, date: '20260702', ratio: 0 },
    ]);
  });
});
