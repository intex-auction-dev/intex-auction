import type { ReactNode } from 'react';
import type { WorldwideDayKey } from '../domain/protocol-time';
import { ErrorBoundary } from '../ui/error-boundary';

export const AUCTION_WIDGET_BOUNDARIES = {
  lifecycle: 'Auction lifecycle',
  metrics: 'Auction metrics',
  oracle: 'Oracle chart',
  ladder: 'Bid ladder',
  instrument: 'Instrument details',
  actionRail: 'Auction action rail',
} as const;

export type AuctionWidgetBoundaryName = (typeof AUCTION_WIDGET_BOUNDARIES)[keyof typeof AUCTION_WIDGET_BOUNDARIES];

export function AuctionWidgetBoundary({
  children,
  name,
  worldwideDay,
}: {
  children: ReactNode;
  name: AuctionWidgetBoundaryName;
  worldwideDay: WorldwideDayKey;
}) {
  return (
    <ErrorBoundary name={name} resetKey={worldwideDay}>
      {children}
    </ErrorBoundary>
  );
}
