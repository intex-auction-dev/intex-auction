import { decodeEnumTag } from '../domain/enum-tag';
export type WorldwideDayLifecycle =
  | 'forming'
  | 'lookback-delay'
  | 'offering'
  | 'waiting'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'offchain-pending';

export type WorldwideDayType = 'unknown' | 'green' | 'red';

export type GlobalAuctionStage = 'none' | 'briefed' | 'started' | 'revealing' | 'clearing' | 'cleared' | 'cancelled';

export type VenueAuctionStage = 'committing-bids' | 'revealing-bids' | 'issuance' | 'completed' | 'cancelled';

export const decodeWorldwideDayLifecycle = (tag: number): WorldwideDayLifecycle => {
  if (tag === 5) throw new RangeError('WorldwideDay lifecycle tag 5 is reserved.');
  return decodeEnumTag('WorldwideDay lifecycle', tag, {
    0: 'forming',
    1: 'lookback-delay',
    2: 'offering',
    3: 'waiting',
    4: 'ready',
    6: 'completed',
    7: 'failed',
    8: 'offchain-pending',
  });
};

export const decodeWorldwideDayType = (tag: number): WorldwideDayType =>
  decodeEnumTag('WorldwideDay type', tag, { 0: 'unknown', 1: 'green', 2: 'red' });

export const decodeGlobalAuctionStage = (tag: number): GlobalAuctionStage =>
  decodeEnumTag('Global auction stage', tag, {
    0: 'none',
    1: 'briefed',
    2: 'started',
    3: 'revealing',
    4: 'clearing',
    5: 'cleared',
    6: 'cancelled',
  });

export const decodeVenueAuctionStage = (tag: number): VenueAuctionStage =>
  decodeEnumTag('Venue auction stage', tag, {
    0: 'committing-bids',
    1: 'revealing-bids',
    2: 'issuance',
    3: 'completed',
    4: 'cancelled',
  });
