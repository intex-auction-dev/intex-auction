import { describe, expect, it } from 'vitest';
import { parseAuctionRoute } from '@/discovery/auction-route';

describe('auction route', () => {
  it('parses the WorldwideDay key without deriving a UTC date', () => {
    expect(parseAuctionRoute('/auction/20260803')).toEqual({
      kind: 'auction',
      worldwideDay: '20260803',
    });
    expect(parseAuctionRoute('/auction/20260803/')).toEqual({
      kind: 'auction',
      worldwideDay: '20260803',
    });
  });

  it('classifies malformed and impossible auction dates', () => {
    expect(parseAuctionRoute('/auction/2026-08-03')).toEqual({
      kind: 'invalid-auction',
      reason: 'format',
    });
    expect(parseAuctionRoute('/auction/20260229')).toEqual({
      kind: 'invalid-auction',
      reason: 'calendar-date',
    });
  });

  it('does not claim unrelated routes', () => {
    expect(parseAuctionRoute('/')).toEqual({ kind: 'other' });
    expect(parseAuctionRoute('/auction/20260803/bids')).toEqual({ kind: 'other' });
  });
});
