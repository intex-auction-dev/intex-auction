import type { Address, Hex } from 'viem';
import type { UtcTimestamp, WorldwideDayKey } from '../domain/protocol-time';
import { BID_RATE_SCALE } from '../domain/escrow-lock';
import { PROMIS_DECIMALS } from '../domain/protocol-constants';
import { formatLadderPromis, intexUnit } from '../ui/display-format';
import type { VenueBidRevealRecord, VenueDemandEvidence, VenueLiveBidRecord } from './venue-bid-history';
import type { VenueAuctionStage } from '../protocol/read-model';

export type VenueDemandEvidenceState =
  | 'active-empty'
  | 'live-reconciled'
  | 'live-confirmation-pending'
  | 'historical-reconciled'
  | 'partially-reaped-reconciled'
  | 'reaped-reconstructed'
  | 'reaped-empty'
  | 'empty-unreaped'
  | 'incompatible-evidence';

export interface VenueDemandProvenance {
  originalEventIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number | null;
  logIndex: number;
}

export interface VenueDemandRow {
  worldwideDay: WorldwideDayKey;
  bidder: Address;
  quantity: number;
  bidRate: number;
  cumulativeQuantity: number;
  revealTimestamp: UtcTimestamp;
  provenance: VenueDemandProvenance;
}

export interface VenueDemandModel {
  label: 'Active-venue revealed demand';
  state: VenueDemandEvidenceState;
  stage: VenueAuctionStage;
  rows: readonly VenueDemandRow[];
  eventOrder: readonly VenueBidRevealRecord[];
  issues: readonly string[];
  reapStatus: VenueDemandEvidence['logs']['reapStatus'];
  confirmedThroughBlock: bigint;
  authoritativeClearingRate: bigint | null;
  cacheStatus: VenueDemandEvidence['logs']['cacheStatus'];
  unconfirmedLiveCount: number;
  confirmationPending: 'none' | 'reveals' | 'reap';
}

const liveMatchesLog = (live: VenueLiveBidRecord, log: VenueBidRevealRecord): boolean =>
  live.bidder.toLowerCase() === log.bidder.toLowerCase() &&
  live.quantity === log.quantity &&
  live.bidRate === log.bidRate &&
  live.timestamp === log.timestamp;

const reconcileEvidence = (
  evidence: VenueDemandEvidence,
): {
  issues: readonly string[];
  confirmationPending: VenueDemandModel['confirmationPending'];
} => {
  const { bidReveals, reaps, reapStatus } = evidence.logs;
  const { bids, stage } = evidence.live;
  const issues: string[] = [];
  let expectedLiveLength = bidReveals.length;
  if (reapStatus !== 'not-observed') {
    const remaining = reaps.at(-1)?.remaining;
    if (remaining === undefined || remaining > BigInt(Number.MAX_SAFE_INTEGER)) {
      return {
        issues: ['AuctionReaped evidence has an invalid remaining count.'],
        confirmationPending: 'none',
      };
    }
    expectedLiveLength = Number(remaining);
  }
  if (expectedLiveLength > bidReveals.length) {
    issues.push('AuctionReaped remaining count exceeds durable BidRevealed history.');
  }
  const comparable = Math.min(bids.length, bidReveals.length, expectedLiveLength);
  for (let index = 0; index < comparable; index += 1) {
    const live = bids[index];
    const log = bidReveals[index];
    if (!live || !log || live.insertionIndex !== index || !liveMatchesLog(live, log)) {
      issues.push(`Live bid ${index} disagrees with durable BidRevealed evidence.`);
    }
  }
  if (issues.length > 0 || bids.length === expectedLiveLength) {
    return { issues, confirmationPending: 'none' };
  }
  if (bids.length > expectedLiveLength) {
    if (reapStatus === 'not-observed' && bids.length > bidReveals.length) {
      return { issues, confirmationPending: 'reveals' };
    }
  } else if (stage !== 'revealing-bids') {
    return { issues, confirmationPending: 'reap' };
  }
  issues.push(`Live bid array length ${bids.length} disagrees with expected retained length ${expectedLiveLength}.`);
  return { issues, confirmationPending: 'none' };
};

const evidenceState = (
  evidence: VenueDemandEvidence,
  issues: readonly string[],
  confirmationPending: VenueDemandModel['confirmationPending'],
): VenueDemandEvidenceState => {
  if (issues.length > 0) return 'incompatible-evidence';
  if (confirmationPending !== 'none') return 'live-confirmation-pending';
  const { bidReveals, reapStatus } = evidence.logs;
  if (reapStatus === 'complete') return bidReveals.length > 0 ? 'reaped-reconstructed' : 'reaped-empty';
  if (reapStatus === 'partial') return 'partially-reaped-reconciled';
  if (bidReveals.length === 0) {
    return evidence.live.stage === 'revealing-bids' ? 'active-empty' : 'empty-unreaped';
  }
  return evidence.live.stage === 'revealing-bids' ? 'live-reconciled' : 'historical-reconciled';
};

export const buildVenueDemandModel = (evidence: VenueDemandEvidence): VenueDemandModel => {
  const { issues, confirmationPending } = reconcileEvidence(evidence);
  const eventOrder = [...evidence.logs.bidReveals];
  const sorted = eventOrder
    .map((record, originalEventIndex) => ({ record, originalEventIndex }))
    .sort((left, right) => {
      if (left.record.bidRate !== right.record.bidRate) return right.record.bidRate - left.record.bidRate;
      if (left.record.timestamp !== right.record.timestamp) {
        return left.record.timestamp < right.record.timestamp ? -1 : 1;
      }
      return left.originalEventIndex - right.originalEventIndex;
    });
  let cumulativeQuantity = 0;
  const rows = sorted.map(({ record, originalEventIndex }): VenueDemandRow => {
    const nextCumulativeQuantity = cumulativeQuantity + record.quantity;
    if (!Number.isSafeInteger(nextCumulativeQuantity)) {
      throw new RangeError('Cumulative venue demand exceeds the JavaScript safe-integer range.');
    }
    cumulativeQuantity = nextCumulativeQuantity;
    return {
      worldwideDay: record.worldwideDay,
      bidder: record.bidder,
      quantity: record.quantity,
      bidRate: record.bidRate,
      cumulativeQuantity,
      revealTimestamp: record.timestamp,
      provenance: {
        originalEventIndex,
        blockNumber: record.blockNumber,
        blockHash: record.blockHash,
        transactionHash: record.transactionHash,
        transactionIndex: record.transactionIndex,
        logIndex: record.logIndex,
      },
    };
  });
  return {
    label: 'Active-venue revealed demand',
    state: evidenceState(evidence, issues, confirmationPending),
    stage: evidence.live.stage,
    rows,
    eventOrder,
    issues,
    reapStatus: evidence.logs.reapStatus,
    confirmedThroughBlock: evidence.logs.confirmedThroughBlock,
    authoritativeClearingRate: evidence.live.authoritativeClearingRate,
    cacheStatus: evidence.logs.cacheStatus,
    unconfirmedLiveCount: Math.max(0, evidence.live.bids.length - evidence.logs.bidReveals.length),
    confirmationPending,
  };
};

export const formatBidRate = (bidRate: number): string => {
  if (!Number.isSafeInteger(bidRate) || bidRate < 0 || bidRate > Number(BID_RATE_SCALE)) {
    throw new RangeError('Bid rate must use the reviewed 1e6 fixed-point scale.');
  }
  const basisPointsOfPercent = bidRate / 100;
  return `${(basisPointsOfPercent / 100).toFixed(4)}%`;
};

export const shortenPublicAddress = (address: Address): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

export interface VenueLadderOutcome {
  supply: number;
  loadedPromis: bigint;
  bidder: { address: Address; wonCount: bigint | null } | null;
}

const MIN_Y_TICK_GAP = 34;

const nicePercentStep = (target: number): number => {
  if (!Number.isFinite(target) || target <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(target));
  const fraction = target / power;
  const multiplier = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return multiplier * power;
};

export const buildBidRateAxis = (
  values: readonly number[],
  plotHeight: number,
): { min: number; max: number; ticks: number[] } => {
  const finite = values.filter(Number.isFinite);
  const rawMin = finite.length > 0 ? Math.min(...finite) : 0;
  const rawMax = finite.length > 0 ? Math.max(...finite) : 1;
  const maxTickCount = Math.max(3, Math.floor(plotHeight / MIN_Y_TICK_GAP));
  const rawSpan = Math.max(rawMax - rawMin, 1);
  let step = Math.max(1, nicePercentStep(rawSpan / Math.max(1, maxTickCount - 1)));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let min = Math.max(0, Math.floor(rawMin / step) * step);
    let max = Math.ceil(rawMax / step) * step;
    if (min > 0 && rawMin - min < step * 0.08) min = Math.max(0, min - step);
    if (max - rawMax < step * 0.08) max += step;
    if (max <= min) max = min + step;

    const count = Math.round((max - min) / step) + 1;
    if (count <= maxTickCount || attempt === 7) {
      return {
        min,
        max,
        ticks: Array.from({ length: count }, (_, index) => +(min + index * step).toFixed(6)),
      };
    }
    step = nicePercentStep(step * 1.01);
  }

  return { min: 0, max: 1, ticks: [0, 1] };
};

const sameAddress = (left: Address, right: Address): boolean => left.toLowerCase() === right.toLowerCase();
const formatPromis = (value: bigint): string => formatLadderPromis(value, PROMIS_DECIMALS);

export interface DisplaySegment {
  row: VenueDemandRow;
  start: number;
  end: number;
  mine: boolean;
  won: number | null;
}

const trimPercent = (text: string): string => text.replace(/0+%$/, '%').replace(/\.%$/, '%');
const formatExactPercent = (rate: number): string => trimPercent(formatBidRate(rate));

export interface LadderDetailRow {
  label: string;
  value: string | null;
}

export const buildLadderBidDetail = (segment: DisplaySegment, clearingRate: number | null): LadderDetailRow[] => {
  const { quantity, bidRate, bidder } = segment.row;
  const rows: LadderDetailRow[] = [
    { label: segment.mine ? 'Your bid' : `Bid ${shortenPublicAddress(bidder)}`, value: null },
    { label: 'Quantity', value: `${quantity} ${intexUnit(quantity)}` },
    { label: 'Bid rate', value: `${formatExactPercent(bidRate)} of strike` },
  ];
  if (clearingRate === null || segment.won === null) return rows;
  rows.push({ label: 'Filled', value: `${segment.won} of ${quantity}` });
  rows.push({ label: 'Clearing rate', value: `${formatExactPercent(clearingRate)} of strike` });
  return rows;
};

export const ladderDetailText = (rows: readonly LadderDetailRow[]): string =>
  rows.map((row) => (row.value === null ? row.label : `${row.label} ${row.value}`)).join(' · ');

export const buildDisplaySegments = (
  rows: readonly VenueDemandRow[],
  clearingRate: number | null,
  outcome?: VenueLadderOutcome,
): DisplaySegment[] => {
  const bidder = outcome?.bidder ?? null;
  const supply = outcome?.supply ?? null;
  const segments = rows.map((row) => ({
    row,
    start: row.cumulativeQuantity - row.quantity,
    end: row.cumulativeQuantity,
    mine: bidder ? sameAddress(row.bidder, bidder.address) : false,
    won: null as number | null,
  }));
  if (clearingRate === null || supply === null) return segments;

  let remaining = supply;
  for (const segment of segments) {
    if (remaining <= 0 || segment.row.bidRate < clearingRate) {
      segment.won = 0;
      continue;
    }
    segment.won = Math.min(segment.row.quantity, remaining);
    remaining -= segment.won;
  }

  // The bidder's contract allocation is authoritative; the supply mark is only a local reconstruction.
  const mine = segments.find((segment) => segment.mine);
  if (mine && bidder?.wonCount !== null && bidder?.wonCount !== undefined) {
    if (bidder.wonCount < 0n || bidder.wonCount > BigInt(mine.row.quantity)) {
      throw new RangeError('Authoritative bidder allocation is outside the revealed bid quantity.');
    }
    mine.won = Number(bidder.wonCount);
  }

  return segments;
};

export const ladderPromisSummary = formatPromis;

export interface LadderLabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const yRangesOverlap = (a: LadderLabelRect, b: LadderLabelRect): boolean =>
  a.y < b.y + b.height && b.y < a.y + a.height;

export const resolveLadderLabelOverlaps = (
  labels: readonly LadderLabelRect[],
  bounds: { minX: number; maxX: number },
  gap = 8,
): void => {
  if (labels.length < 2) return;

  const bands: LadderLabelRect[][] = [];
  const sorted = [...labels].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const label of sorted) {
    const band = bands.find((group) => group.some((other) => yRangesOverlap(other, label)));
    if (band) band.push(label);
    else bands.push([label]);
  }

  for (const band of bands) {
    if (band.length < 2) continue;
    const passLimit = Math.max(3, band.length * 2);
    for (let pass = 0; pass < passLimit; pass += 1) {
      let moved = false;
      for (let i = 0; i < band.length; i += 1) {
        for (let j = i + 1; j < band.length; j += 1) {
          const a = band[i]!;
          const b = band[j]!;
          const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          if (overlapX <= 0) continue;
          const left = a.x <= b.x ? a : b;
          const right = left === a ? b : a;
          const needed = overlapX + gap;
          const leftRoom = left.x - bounds.minX;
          const rightRoom = bounds.maxX - right.width - right.x;
          const half = needed / 2;
          let leftShift = Math.min(leftRoom, half);
          const rightShift = Math.min(rightRoom, needed - leftShift);
          if (leftShift + rightShift < needed) {
            leftShift = Math.min(leftRoom, needed - rightShift);
          }
          if (leftShift > 0) {
            left.x -= leftShift;
            moved = true;
          }
          if (rightShift > 0) {
            right.x += rightShift;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }
};
