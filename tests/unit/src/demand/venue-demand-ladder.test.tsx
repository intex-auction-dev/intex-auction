import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { toUtcTimestamp, type WorldwideDayKey } from '@/domain/protocol-time';
import type { VenueDemandModel, VenueDemandRow } from '@/demand/venue-demand-model';
import {
  buildBidRateAxis,
  buildDisplaySegments,
  buildLadderBidDetail,
  ladderDetailText,
  resolveLadderLabelOverlaps,
  VenueDemandLadder,
  type VenueLadderViewState,
} from '@/demand/venue-demand-ladder';

const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const OTHER_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hex;
const DAY = '20260804' as WorldwideDayKey;

const row = (
  quantity: number,
  bidRate: number,
  cumulativeQuantity = quantity,
  originalEventIndex = 0,
  bidder = ADDRESS,
): VenueDemandRow => ({
  worldwideDay: DAY,
  bidder,
  quantity,
  bidRate,
  cumulativeQuantity,
  revealTimestamp: toUtcTimestamp(1_700_000_000n + BigInt(originalEventIndex)),
  provenance: {
    originalEventIndex,
    blockNumber: 10n + BigInt(originalEventIndex),
    blockHash: HASH,
    transactionHash: HASH,
    transactionIndex: 0,
    logIndex: originalEventIndex + 1,
  },
});

const model = (overrides: Partial<VenueDemandModel> = {}): VenueDemandModel => ({
  label: 'Active-venue revealed demand',
  state: 'live-reconciled',
  stage: 'revealing-bids',
  rows: [row(2, 800_000)],
  eventOrder: [],
  issues: [],
  reapStatus: 'not-observed',
  confirmedThroughBlock: 20n,
  authoritativeClearingRate: null,
  cacheStatus: { BidRevealed: 'cache-hit', AuctionReaped: 'cache-hit' },
  unconfirmedLiveCount: 0,
  confirmationPending: 'none',
  ...overrides,
});

const markup = (state: VenueLadderViewState): string => renderToStaticMarkup(<VenueDemandLadder state={state} />);

describe('venue demand ladder presentation', () => {
  it('uses the approved dynamic percentage axis for a low single-rate outcome', () => {
    expect(buildBidRateAxis([5, 5], 182)).toEqual({ min: 4, max: 6, ticks: [4, 5, 6] });
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [row(10, 50_000, 10)],
        authoritativeClearingRate: 50_000n,
      }),
    });
    expect(html).toContain('>4%</text>');
    expect(html).toContain('>5%</text>');
    expect(html).toContain('>6%</text>');
    expect(html).not.toContain('>50%</text>');
    expect(html).not.toContain('>100%</text>');
  });

  it('renders the approved staircase, axes, and clearing badge for a spread outcome', () => {
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [row(2, 800_000, 2), row(4, 500_000, 6, 1), row(4, 200_000, 10, 2)],
        authoritativeClearingRate: 500_000n,
      }),
    });
    expect(html).toContain('Final Bid Ladder');
    expect(html).toContain('public record · sorted by % of strike');
    expect(html).toContain('% Strike');
    expect(html).toContain('class="venue-demand-curve__line"');
    expect(html).toContain('class="venue-demand-curve__clearing"');
    expect(html).toContain('class="venue-demand-curve__clearing-badge"');
    expect(html).toContain('>50%</text>');
    expect(html).toContain('>10 Intexes</text>');
    expect(html).toContain('10 Intexes demand');
    expect(html).toContain('Demand Curve (all bids)');
    expect(html).not.toContain('Accepted reveals');
    expect(html).not.toContain('Final auction rate');
  });

  it('keeps ladder axis and tooltip typography at chart-standard scale', () => {
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [row(2, 800_000, 2, 0, OTHER_ADDRESS), row(3, 500_000, 5, 1, ADDRESS)],
        authoritativeClearingRate: 500_000n,
      }),
      outcome: {
        supply: 5,
        loadedPromis: 500_000n * 10n ** 18n,
        bidder: { address: ADDRESS, wonCount: 3n },
      },
    });
    expect(html).toContain('style="height:288px"');
    expect(html).toContain('class="venue-demand-curve__axis-tick"');
    expect(html).toContain('class="venue-demand-curve__quantity-tick"');
    expect(html).toContain('class="venue-demand-curve__tooltip-title"');
    expect(html).toContain('class="venue-demand-curve__tooltip-subtitle"');
  });

  it('matches the approved final ladder with supply, clearing fills, refunds, and a lost wallet bid', () => {
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [
          row(12, 800_000, 12, 0, OTHER_ADDRESS),
          row(12, 600_000, 24, 1, OTHER_ADDRESS),
          row(10, 480_000, 34, 2, OTHER_ADDRESS),
          row(33, 350_000, 67, 3, OTHER_ADDRESS),
          row(3, 50_000, 70, 4, ADDRESS),
        ],
        authoritativeClearingRate: 480_000n,
      }),
      outcome: {
        supply: 24,
        loadedPromis: 2_400_000n * 10n ** 18n,
        bidder: { address: ADDRESS, wonCount: 0n },
      },
    });
    expect(html).toContain('70 Intexes demand · 24 Intexes supply (2,400,000 Promis)');
    expect(html).toContain('Total Supply');
    expect(html).toContain('Filled At Clearing');
    expect(html).toContain('Above Clearing · Refunded');
    expect(html).toContain('Clearing Rate (you pay)');
    expect(html).toContain('Demand Curve (all bids)');
    expect(html).toContain('Your Bid · Not Filled');
    expect(html).toContain('Not filled');
    expect(html).toContain('venue-lost-hatch');
  });

  it('uses authoritative bidder allocation for the user partial-fill pill', () => {
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [row(18, 700_000, 18, 0, OTHER_ADDRESS), row(10, 500_000, 28, 1, ADDRESS)],
        authoritativeClearingRate: 500_000n,
      }),
      outcome: {
        supply: 24,
        loadedPromis: 24_000_000n * 10n ** 18n,
        bidder: { address: ADDRESS, wonCount: 6n },
      },
    });
    expect(html).toContain('Your bid');
    expect(html).toContain('6/10 filled');
  });

  it('pushes a lost-wallet pill away from the supply badge when both share the line below the baseline', () => {
    const html = markup({
      kind: 'loaded',
      model: model({
        stage: 'completed',
        rows: [row(5, 800_000, 5, 0, OTHER_ADDRESS), row(5, 500_000, 10, 1, ADDRESS)],
        authoritativeClearingRate: 600_000n,
      }),
      outcome: {
        supply: 8,
        loadedPromis: 8_000_000n * 10n ** 18n,
        bidder: { address: ADDRESS, wonCount: 0n },
      },
    });
    expect(html).toContain('Not filled');
    const supplyBadge = html.match(/<rect x="([0-9.]+)"[^>]*width="([0-9.]+)"[^>]*fill="var\(--color-badge\)"/);
    const lostPill = html.match(/<rect x="([0-9.]+)"[^>]*width="([0-9.]+)"[^>]*fill="var\(--color-danger\)"/);
    expect(supplyBadge).not.toBeNull();
    expect(lostPill).not.toBeNull();
    const lostRight = Number(lostPill![1]) + Number(lostPill![2]);
    const supplyLeft = Number(supplyBadge![1]);
    expect(lostRight).toBeLessThanOrEqual(supplyLeft);
  });

  it('bounds fills to the delivered supply and resolves equal-rate marginals in model tie-break order', () => {
    const rows = [
      row(10, 700_000, 10, 0, OTHER_ADDRESS),
      row(10, 500_000, 20, 1, OTHER_ADDRESS),
      row(10, 500_000, 30, 2, ADDRESS),
    ];
    const segments = buildDisplaySegments(rows, 500_000, {
      supply: 15,
      loadedPromis: 15n,
      bidder: null,
    });
    expect(segments.map((segment) => segment.won)).toEqual([10, 5, 0]);
  });

  it('honors the connected bidder authoritative fill even beyond the local supply mark', () => {
    const rows = [
      row(24, 398_509, 24, 0, OTHER_ADDRESS),
      row(18, 385_000, 42, 1, OTHER_ADDRESS),
      row(13, 378_400, 55, 2, OTHER_ADDRESS),
      row(10, 50_000, 65, 3, ADDRESS),
    ];
    const segments = buildDisplaySegments(rows, 50_000, {
      supply: 10,
      loadedPromis: 10n,
      bidder: { address: ADDRESS, wonCount: 10n },
    });
    expect(segments.map((segment) => segment.won)).toEqual([10, 0, 0, 10]);
    expect(segments.find((segment) => segment.mine)?.won).toBe(10);
  });

  it('retains confirmed rows while a later refresh is temporarily unavailable', () => {
    const html = markup({ kind: 'loaded', model: model(), warning: 'RPC page failed.' });
    expect(html).toContain('Latest confirmed ladder retained while refresh failed');
    expect(html).toContain('RPC page failed.');
    expect(html).toContain('2 Intexes demand');
  });

  it('keeps reveal-open empty and reconstructed history customer-readable', () => {
    expect(markup({ kind: 'loaded', model: model({ rows: [], eventOrder: [] }) })).toContain('No revealed bids yet');
    const reaped = markup({
      kind: 'loaded',
      model: model({
        state: 'reaped-reconstructed',
        stage: 'completed',
        reapStatus: 'complete',
      }),
    });
    expect(reaped).toContain('Final Bid Ladder');
    expect(reaped).toContain('public record · sorted by % of strike');
    expect(reaped).not.toContain('Reconstructed after reaping');
  });

  it('distinguishes unavailable venue states', () => {
    expect(markup({ kind: 'unavailable', reason: 'no-venue-auction' })).toContain('No active-venue auction record');
    expect(markup({ kind: 'unavailable', reason: 'delivery-pending' })).toContain('has not received it yet');
    expect(markup({ kind: 'unavailable', reason: 'venue-skipped' })).toContain('explicitly skipped');
    expect(markup({ kind: 'unavailable', reason: 'not-applicable' })).toContain('no applicable active-venue auction');
  });

  it('shows the authoritative clearing rate without claiming allocation when result evidence is absent', () => {
    const html = markup({ kind: 'loaded', model: model({ stage: 'completed', authoritativeClearingRate: 750_000n }) });
    expect(html).toContain('75% clearing rate');
    expect(html).toContain('Clearing Rate');
    expect(html).not.toContain('Your Bid');
    expect(html).not.toContain('Filled At Clearing');
    expect(html).not.toContain('Above Clearing');
  });
});

describe('per-bid ladder hover detail', () => {
  const finalLadder = {
    rows: [
      row(12, 800_000, 12, 0, OTHER_ADDRESS),
      row(12, 600_000, 24, 1, OTHER_ADDRESS),
      row(10, 480_000, 34, 2, OTHER_ADDRESS),
      row(1, 398_509, 35, 3, OTHER_ADDRESS),
      row(3, 50_000, 38, 4, ADDRESS),
    ],
    outcome: { supply: 24, loadedPromis: 2_400_000n * 10n ** 18n, bidder: { address: ADDRESS, wonCount: 0n } },
  };

  it('states quantity, exact bid rate, and reconstructed fill as labelled tooltip rows', () => {
    const segments = buildDisplaySegments(finalLadder.rows, 480_000, finalLadder.outcome);
    expect(buildLadderBidDetail(segments[0]!, 480_000)).toEqual([
      { label: 'Bid 0xbbbb…bbbb', value: null },
      { label: 'Quantity', value: '12 Intexes' },
      { label: 'Bid rate', value: '80% strike' },
      { label: 'Filled', value: '12 of 12' },
      { label: 'Clearing rate', value: '48% strike' },
    ]);
    expect(segments.map((segment) => ladderDetailText(buildLadderBidDetail(segment, 480_000)))).toEqual([
      'Bid 0xbbbb…bbbb · Quantity 12 Intexes · Bid rate 80% strike · Filled 12 of 12 · Clearing rate 48% strike',
      'Bid 0xbbbb…bbbb · Quantity 12 Intexes · Bid rate 60% strike · Filled 12 of 12 · Clearing rate 48% strike',
      'Bid 0xbbbb…bbbb · Quantity 10 Intexes · Bid rate 48% strike · Filled 0 of 10 · Clearing rate 48% strike',
      'Bid 0xbbbb…bbbb · Quantity 1 Intex · Bid rate 39.8509% strike · Filled 0 of 1 · Clearing rate 48% strike',
      'Your bid · Quantity 3 Intexes · Bid rate 5% strike · Filled 0 of 3 · Clearing rate 48% strike',
    ]);
  });

  it('omits the fill rows while no clearing rate has been delivered', () => {
    const segments = buildDisplaySegments([row(4, 250_000, 4)], null);
    expect(buildLadderBidDetail(segments[0]!, null)).toEqual([
      { label: 'Bid 0xaaaa…aaaa', value: null },
      { label: 'Quantity', value: '4 Intexes' },
      { label: 'Bid rate', value: '25% strike' },
    ]);
  });

  it('gives every bid a hover target and a non-hover accessible equivalent', () => {
    const html = markup({
      kind: 'loaded',
      model: model({ stage: 'completed', rows: finalLadder.rows, authoritativeClearingRate: 480_000n }),
      outcome: finalLadder.outcome,
    });
    expect(html.match(/fill="transparent"/g)).toHaveLength(finalLadder.rows.length);
    expect(html).toContain('<ul class="visually-hidden" aria-label="Revealed bid detail">');
    expect(html).toContain(
      '<li>Bid 0xbbbb…bbbb · Quantity 12 Intexes · Bid rate 80% strike · Filled 12 of 12 · Clearing rate 48% strike</li>',
    );
    expect(html).toContain(
      '<li>Your bid · Quantity 3 Intexes · Bid rate 5% strike · Filled 0 of 3 · Clearing rate 48% strike</li>',
    );
    expect(html).toContain('Per-bid fills are reconstructed from the delivered clearing rate and venue supply');
  });
  it('links every bid to its reveal transaction when the venue has a reviewed explorer', () => {
    const state: VenueLadderViewState = {
      kind: 'loaded',
      explorerUrl: 'https://explorer.example',
      model: model({ stage: 'completed', rows: finalLadder.rows, authoritativeClearingRate: 480_000n }),
      outcome: finalLadder.outcome,
    };
    const html = markup(state);
    expect(html.match(new RegExp(`href="https://explorer.example/tx/${HASH}"`, 'g'))).toHaveLength(
      finalLadder.rows.length,
    );
    expect(html).toContain('Open reveal transaction in explorer');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(markup({ ...state, explorerUrl: null })).not.toContain('<a href');
  });

  it('reuses the shared tooltip enter motion for the hover tooltip and highlight', () => {
    const uiCss = readFileSync(new URL('../../../../src/ui/ui.css', import.meta.url), 'utf8');
    const appCss = readFileSync(new URL('../../../../src/demand/venue-demand-ladder.css', import.meta.url), 'utf8');
    const shared = uiCss.match(
      /\.tooltip__content\s*\{[^}]*transition:\s*opacity (var\(--motion-[a-z]+\)) ease,\s*transform \1 (var\(--ease-[a-z-]+\))/s,
    );
    expect(shared).not.toBeNull();
    const [, duration, easing] = shared!;
    for (const rule of [
      'venue-demand-curve__tooltip--hover',
      'venue-demand-curve__hover-band',
      'venue-demand-curve__hover-step',
    ]) {
      const declaration = appCss.match(new RegExp(`\\.${rule}\\b[^{]*\\{[^}]*animation:[^;]*;`, 's'))?.[0] ?? '';
      expect(declaration, rule).toContain(duration);
      expect(declaration, rule).toContain(easing);
    }
    expect(appCss).toMatch(/transform:\s*translateY\(4px\) scale\(0?\.95\)/);
    expect(appCss).toMatch(/transform:\s*translateY\(-4px\) scale\(0?\.95\)/);
  });
});

describe('ladder label overlap resolution', () => {
  const bounds = { minX: 0, maxX: 620 };
  it('pushes labels sharing a horizontal line apart so each owns horizontal space', () => {
    const labels = [
      { x: 60, y: 100, width: 120, height: 42 },
      { x: 140, y: 100, width: 120, height: 42 },
    ];
    resolveLadderLabelOverlaps(labels, bounds);
    expect(labels[0]!.x + labels[0]!.width).toBeLessThanOrEqual(labels[1]!.x - 8);
  });

  it('leaves labels on different horizontal lines untouched', () => {
    const labels = [
      { x: 100, y: 40, width: 120, height: 42 },
      { x: 110, y: 200, width: 120, height: 42 },
    ];
    const before = labels.map((label) => ({ ...label }));
    resolveLadderLabelOverlaps(labels, bounds);
    expect(labels).toEqual(before);
  });

  it('lets a pinned edge label absorb the whole push when its partner cannot move', () => {
    const labels = [
      { x: 0, y: 90, width: 100, height: 42 },
      { x: 60, y: 90, width: 100, height: 42 },
    ];
    resolveLadderLabelOverlaps(labels, bounds);
    expect(labels[0]!.x).toBe(0);
    expect(labels[1]!.x).toBeGreaterThanOrEqual(labels[0]!.x + labels[0]!.width + 8);
  });

  it('stays inside the plot bounds even when the right edge is full', () => {
    const labels = [
      { x: 420, y: 80, width: 120, height: 42 },
      { x: 500, y: 80, width: 120, height: 42 },
    ];
    resolveLadderLabelOverlaps(labels, bounds);
    expect(labels[0]!.x).toBeGreaterThanOrEqual(0);
    expect(labels[1]!.x + labels[1]!.width).toBeLessThanOrEqual(620);
    expect(labels[0]!.x + labels[0]!.width).toBeLessThanOrEqual(labels[1]!.x - 8);
  });

  it('leaves non-overlapping same-line labels in place', () => {
    const labels = [
      { x: 40, y: 80, width: 100, height: 42 },
      { x: 300, y: 80, width: 100, height: 42 },
    ];
    const before = labels.map((label) => ({ ...label }));
    resolveLadderLabelOverlaps(labels, bounds);
    expect(labels).toEqual(before);
  });
});
