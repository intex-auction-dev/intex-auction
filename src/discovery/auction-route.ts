import { parseWorldwideDayKey, type WorldwideDayKey } from '../domain/protocol-time';

export type AuctionRouteResult =
  | { kind: 'auction'; worldwideDay: WorldwideDayKey }
  | { kind: 'invalid-auction'; reason: 'format' | 'calendar-date' }
  | { kind: 'other' };

const AUCTION_ROUTE_PATTERN = /^\/auction\/([^/]+)\/?$/;

export const parseAuctionRoute = (pathname: string): AuctionRouteResult => {
  const match = AUCTION_ROUTE_PATTERN.exec(pathname);
  if (!match) return { kind: 'other' };

  const raw = match[1];
  if (raw === undefined) return { kind: 'invalid-auction', reason: 'format' };

  const parsed = parseWorldwideDayKey(raw);
  return parsed.ok
    ? { kind: 'auction', worldwideDay: parsed.value }
    : { kind: 'invalid-auction', reason: parsed.reason };
};

export const auctionRoutePath = (worldwideDay: WorldwideDayKey): string => `/auction/${worldwideDay}`;
