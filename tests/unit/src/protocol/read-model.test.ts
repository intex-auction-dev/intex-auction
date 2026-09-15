import { describe, expect, it } from 'vitest';
import {
  decodeGlobalAuctionStage,
  decodeVenueAuctionStage,
  decodeWorldwideDayLifecycle,
  decodeWorldwideDayType,
} from '@/protocol/read-model';

describe('authority-labelled auction states', () => {
  it('decodes every persisted WorldwideDay lifecycle tag', () => {
    expect([0, 1, 2, 3, 4, 6, 7, 8].map(decodeWorldwideDayLifecycle)).toEqual([
      'forming',
      'lookback-delay',
      'offering',
      'waiting',
      'ready',
      'completed',
      'failed',
      'offchain-pending',
    ]);
  });

  it('rejects the reserved lifecycle tag and unknown tags', () => {
    expect(() => decodeWorldwideDayLifecycle(5)).toThrow('tag 5 is reserved');
    expect(() => decodeWorldwideDayLifecycle(9)).toThrow(RangeError);
  });

  it('keeps day type separate from lifecycle', () => {
    expect(decodeWorldwideDayType(0)).toBe('unknown');
    expect(decodeWorldwideDayType(1)).toBe('green');
    expect(decodeWorldwideDayType(2)).toBe('red');
    expect(() => decodeWorldwideDayType(3)).toThrow(RangeError);
  });

  it('decodes global and venue stages independently', () => {
    expect(decodeGlobalAuctionStage(5)).toBe('cleared');
    expect(decodeVenueAuctionStage(3)).toBe('completed');
    expect(decodeGlobalAuctionStage(6)).toBe('cancelled');
    expect(decodeVenueAuctionStage(4)).toBe('cancelled');
  });
});
