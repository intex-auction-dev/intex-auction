import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemandPopover } from '@/discovery/public-discovery-view';
import type { WorldwideDayKey } from '@/domain/protocol-time';

describe('DemandPopover legend', () => {
  it('reuses the calendar legend marker for red days', () => {
    const html = renderToStaticMarkup(
      <DemandPopover data={[{ cancelled: true, date: '20260801' as WorldwideDayKey, ratio: 0 }]} />,
    );

    expect(html).toContain('calendar-legend demand-popover__legend');
    expect(html).toContain('background:var(--color-danger)');
    expect(html).toContain('>Red day</span>');
    expect(html).not.toContain('DD.MM');
  });
});
