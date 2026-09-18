import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CHART_CALL_ANCHOR_HEADROOM,
  chartCallLabelTop,
  chartLevelLabelTops,
  chartPriceMarkerRect,
  chartYPanDelta,
  chartYPannedRange,
  chartYRange,
  chartYRangeAtZoom,
  chartYRanges,
  chartYRangeWithHeadroom,
  OraclePriceChart,
  priceFlowParts,
  toAlignedChartData,
} from '@/oracle/oracle-price-chart';
import type { OracleChartModel } from '@/oracle/oracle-chart-model';

const model: OracleChartModel = {
  pair: { base: '0x0000000000000000000000000000000000000000', quote: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  retainedCount: 1,
  points: [{ time: 1, value: 1, rawRate: 1_000_000_000_000_000_000n, rawVolume: 0n }],
  latest: { time: 1, value: 1, rawRate: 1_000_000_000_000_000_000n, rawVolume: 0n },
  levels: [],
};

describe('OraclePriceChart', () => {
  it('uses customer-facing COEN terminology without protocol diagnostics', () => {
    const html = renderToStaticMarkup(<OraclePriceChart model={model} quoteDenomination="USD" />);

    expect(html).toContain('COEN Price');
    expect(html).toContain('COEN price history');
    expect(html).toContain('data-chart-library="uplot"');
    expect(html).toContain('data-number-flow="coen-price"');
    expect(html).toContain('$1');
    expect(html).not.toContain('œ Price');
    expect(html).not.toContain('chronological Oracle price history');
    expect(html).not.toContain('retained snapshots');
  });

  it('distinguishes the plotted snapshot series from the frozen auction entry price', () => {
    const html = renderToStaticMarkup(<OraclePriceChart model={model} quoteDenomination="USD" />);

    // The plotted line is recorded price snapshots, a different quantity from the frozen
    // contract entry price. This fails if the caption is relabelled to imply the line is
    // the entry-price series (F3: entry-price source divergence).
    expect(html).toContain('recorded price snapshots');
    expect(html).toContain('not the frozen auction entry price');
  });

  it('prefixes the price only when the quote denomination is USD', () => {
    const usd = renderToStaticMarkup(<OraclePriceChart model={model} quoteDenomination="USD" />);
    expect(usd).toContain('$1');

    const eur = renderToStaticMarkup(<OraclePriceChart model={model} quoteDenomination="EUR" />);
    expect(eur).not.toContain('$1');
    expect(eur).toContain('>1<');

    const unknown = renderToStaticMarkup(<OraclePriceChart model={model} quoteDenomination="" />);
    expect(unknown).not.toContain('$1');
  });

  it('keeps unchanged digit positions stable for 1.23 to 1.26', () => {
    const before = new Map(priceFlowParts('1.23').map((part) => [part.key, part.text]));
    const changedDigits = priceFlowParts('1.26')
      .filter((part) => part.digit && before.get(part.key) !== part.text)
      .map((part) => ({ position: part.position, digit: part.text }));

    expect(changedDigits).toEqual([{ position: -2, digit: '6' }]);
  });
});

describe('uPlot chart helpers', () => {
  it('builds aligned data and includes external auction levels in the y range', () => {
    expect(toAlignedChartData(model.points)).toEqual([[1], [1]]);
    const [min, max] = chartYRange(model.points, [{ label: 'Call', value: 5, rawValue: 5n }]);
    expect(min).toBeLessThan(1);
    expect(max).toBeGreaterThan(5);
  });

  it('keeps Call outside the default viewport but available in the full zoom range', () => {
    const levels = [
      { label: 'Entry' as const, value: 1, rawValue: 1n },
      { label: 'Floor' as const, value: 1.08, rawValue: 108n },
      { label: 'Call' as const, value: 2.25, rawValue: 225n },
    ];
    const { defaultRange, fullRange } = chartYRanges(model.points, levels);

    expect(defaultRange[1]).toBeLessThan(2.25);
    expect(fullRange[1]).toBeGreaterThan(2.25);
    expect(chartYRangeAtZoom(defaultRange, fullRange, 0)).toEqual(defaultRange);
    expect(chartYRangeAtZoom(defaultRange, fullRange, 1)).toEqual(fullRange);
    const halfway = chartYRangeAtZoom(defaultRange, fullRange, 0.5);
    expect(halfway[0]).toBeGreaterThanOrEqual(fullRange[0]);
    expect(halfway[1]).toBeGreaterThan(defaultRange[1]);
    expect(halfway[1]).toBeLessThan(fullRange[1]);
  });

  it('pans a zoomed viewport toward Call without changing its scale', () => {
    const baseRange: [number, number] = [0.95, 1.12];
    const fullRange: [number, number] = [0.9, 2.35];
    const panned = chartYPannedRange(baseRange, fullRange, 1.5);

    expect(panned[1]).toBe(2.35);
    expect(panned[1] - panned[0]).toBeCloseTo(baseRange[1] - baseRange[0]);
    expect(chartYPannedRange(baseRange, fullRange, -1.5)[0]).toBe(0.9);
    expect(chartYPannedRange(fullRange, fullRange, 1)).toEqual(fullRange);
  });

  it('moves the y viewport at twice the pointer-to-plot ratio', () => {
    expect(chartYPanDelta(25, 100, 0.4)).toBeCloseTo(0.2);
    expect(chartYPanDelta(-25, 100, 0.4)).toBeCloseTo(-0.2);
    expect(chartYPanDelta(25, 0, 0.4)).toBe(0);
  });

  it('creates enough Call anchor headroom to clear a top level label', () => {
    const range: [number, number] = [0.95, 1.08];
    const above = chartYRangeWithHeadroom(range, 'above', CHART_CALL_ANCHOR_HEADROOM, 260);
    const below = chartYRangeWithHeadroom(range, 'below', CHART_CALL_ANCHOR_HEADROOM, 260);
    const originalSpan = range[1] - range[0];

    expect(CHART_CALL_ANCHOR_HEADROOM).toBeGreaterThanOrEqual(64);
    expect(above[0]).toBe(range[0]);
    expect(above[1]).toBeGreaterThan(range[1]);
    expect(below[0]).toBeLessThan(range[0]);
    expect(below[1]).toBe(range[1]);
    expect(originalSpan / (above[1] - above[0])).toBeCloseTo((260 - CHART_CALL_ANCHOR_HEADROOM) / 260);
  });

  it('returns a finite non-zero range for empty and single-value data', () => {
    expect(chartYRange([], [])).toEqual([0, 1]);
    const [min, max] = chartYRange(model.points, []);
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);
  });

  it('keeps close level-label backdrops separated and inside the plot', () => {
    const labelHeight = 24;
    const gap = 4;
    const tops = chartLevelLabelTops([180, 174, 30], 8, 220, labelHeight, gap);
    const sorted = [...tops].sort((a, b) => a - b);
    const [first, second, third] = sorted;

    expect(Math.min(...tops)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...tops) + labelHeight).toBeLessThanOrEqual(220);
    expect(second! - first!).toBeGreaterThanOrEqual(labelHeight + gap);
    expect(third! - second!).toBeGreaterThanOrEqual(labelHeight + gap);
  });

  it('places the Call label above the current-price marker with its own gap', () => {
    const marker = { x: 320, y: 104, width: 60, height: 22 };

    expect(chartCallLabelTop(115, marker, 8, 24, 4)).toBe(76);
  });

  it('anchors the current-price marker above the line at the point, horizontally centered', () => {
    const rect = chartPriceMarkerRect(200, 60, 8, 208, 0, 400, 60, 22, 4, 10);

    expect(rect).toEqual({ x: 200 - 30, y: 60 - 10 - 22, width: 60, height: 22 });
  });

  it('clamps the current-price marker inside the plot when the line is near an edge', () => {
    const plotTop = 8;
    const plotBottom = 208;
    const atTop = chartPriceMarkerRect(200, 0, plotTop, plotBottom, 0, 400, 60, 22, 4, 10);
    const atBottom = chartPriceMarkerRect(200, 300, plotTop, plotBottom, 0, 400, 60, 22, 4, 10);
    const atLeft = chartPriceMarkerRect(0, 30, plotTop, plotBottom, 0, 400, 60, 22, 4, 10);
    const atRight = chartPriceMarkerRect(400, 30, plotTop, plotBottom, 0, 400, 60, 22, 4, 10);

    expect(atTop.y).toBe(plotTop);
    expect(atTop.y + atTop.height / 2).toBe(plotTop + 11);
    expect(atBottom.y + atBottom.height).toBe(plotBottom);
    expect(atBottom.y + atBottom.height / 2).toBe(plotBottom - 11);
    expect(atLeft.x).toBe(4);
    expect(atRight.x + atRight.width).toBe(400 - 4);
  });
});
