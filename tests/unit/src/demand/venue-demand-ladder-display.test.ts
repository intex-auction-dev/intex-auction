import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { toUtcTimestamp, type WorldwideDayKey } from '@/domain/protocol-time';
import {
  buildBidRateAxis,
  buildDisplaySegments,
  buildLadderBidDetail,
  ladderDetailText,
  resolveLadderLabelOverlaps,
  type VenueDemandRow,
} from '@/demand/venue-demand-model';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hex;
const DAY = '20260804' as WorldwideDayKey;

const row = (
  quantity: number,
  bidRate: number,
  cumulativeQuantity: number,
  index: number,
  bidder: Address,
): VenueDemandRow => ({
  worldwideDay: DAY,
  bidder,
  quantity,
  bidRate,
  cumulativeQuantity,
  revealTimestamp: toUtcTimestamp(1_700_000_000n + BigInt(index)),
  provenance: {
    originalEventIndex: index,
    blockNumber: 10n + BigInt(index),
    blockHash: HASH,
    transactionHash: HASH,
    transactionIndex: 0,
    logIndex: index + 1,
  },
});

// This module was extracted verbatim out of the venue-demand-ladder component; the
// ladder render spec covers rendered output, this pins the pure domain contract directly.
describe('extracted ladder display domain', () => {
  it('reconstructs fills bounded by supply, honouring the authoritative allocation', () => {
    const rows = [row(10, 700_000, 10, 0, B), row(10, 500_000, 20, 1, A)];
    const segments = buildDisplaySegments(rows, 500_000, {
      supply: 24,
      loadedPromis: 1n,
      bidder: { address: A, wonCount: 6n },
    });
    expect(segments.map((segment) => segment.won)).toEqual([10, 6]);
    expect(buildLadderBidDetail(segments[1]!, 500_000)).toEqual([
      { label: 'Your bid', value: null },
      { label: 'Quantity', value: '10 Intexes' },
      { label: 'Bid rate', value: '50% strike' },
      { label: 'Filled', value: '6 of 10' },
      { label: 'Clearing rate', value: '50% strike' },
    ]);
    expect(ladderDetailText(buildLadderBidDetail(segments[0]!, null))).toBe(
      'Bid 0xbbbb…bbbb · Quantity 10 Intexes · Bid rate 70% strike',
    );
  });

  it('throws a RangeError when the authoritative allocation exceeds the revealed quantity', () => {
    const rows = [row(3, 500_000, 3, 0, A)];
    expect(() =>
      buildDisplaySegments(rows, 500_000, { supply: 3, loadedPromis: 1n, bidder: { address: A, wonCount: 4n } }),
    ).toThrow(RangeError);
    expect(() =>
      buildDisplaySegments(rows, 500_000, { supply: 3, loadedPromis: 1n, bidder: { address: A, wonCount: -1n } }),
    ).toThrow('Authoritative bidder allocation is outside the revealed bid quantity.');
  });

  it('keeps the approved dynamic axis and separates overlapping same-line labels', () => {
    expect(buildBidRateAxis([5, 5], 182)).toEqual({ min: 4, max: 6, ticks: [4, 5, 6] });
    const labels = [
      { x: 60, y: 100, width: 120, height: 42 },
      { x: 140, y: 100, width: 120, height: 42 },
    ];
    resolveLadderLabelOverlaps(labels, { minX: 0, maxX: 620 });
    expect(labels[0]!.x + labels[0]!.width).toBeLessThanOrEqual(labels[1]!.x - 8);
  });
});
