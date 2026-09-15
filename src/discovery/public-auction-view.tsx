import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Check, FileSignature, ShieldCheck } from 'lucide-react';
import type { CalendarWorldwideDay } from './calendar-evidence';
import type { OriginReadState, PublicAuctionRead, PublicReadFailure, VenueReadState } from './load-public-auction';
import { useCurrencyFormatters } from '../oracle/currency-state';
import type { VenueAuctionStage } from '../protocol/read-model';
import { Badge, Button, Card, Icon, InfoTip, Metric, MetricGrid, type PresentationTone } from '../ui/primitives';
import { FlowingNumberText } from '../ui/flowing-number-text';
import { getScheduleTimeZone } from '../domain/display-timezone';
import {
  currencyCode,
  formatPriceMinor9,
  formatPromisAmount as formatTokenAmount18,
  formatWorldwideDayDisplay,
  integer,
  scheduleTime,
  titleCase,
} from '../ui/display-format';
import { USD_REFERENCE_CURRENCY } from '../domain/protocol-constants';
import { AUCTION_WIDGET_BOUNDARIES, AuctionWidgetBoundary } from './auction-widget-boundary';
import { InstrumentSpecification } from './public-auction-view/instrument-specification';
export { InstrumentSpecification } from './public-auction-view/instrument-specification';
import {
  authoritativeSchedule,
  authoritativeStage,
  completedAuctionOutcome,
  venueLifecyclePresentation,
  venueStatusClassName,
  venueStatusPresentation,
  type LifecycleStepState,
  type VenueLifecyclePresentation,
} from './public-auction-view-presentation';
import './public-auction-view.css';

export {
  authoritativeStage,
  completedAuctionOutcome,
  venueLifecyclePresentation,
  venueStatusClassName,
  venueStatusPresentation,
} from './public-auction-view-presentation';
export type {
  CompletedAuctionOutcome,
  LifecycleStepState,
  VenueLifecyclePresentation,
  VenueStatusPresentation,
} from './public-auction-view-presentation';

export const formatReferenceValue = (value: bigint, currency: number): string => {
  const amount = formatPriceMinor9(value);
  return currency === USD_REFERENCE_CURRENCY ? `$${amount}` : `${amount} ${currencyCode(currency)}`;
};

const AUCTION_LIFECYCLE_STEPS = [
  'Commit Sealed Bid',
  'Reveal Bid',
  'Clearing Rate computed',
  'Intex Issuance',
] as const;

const formatCountdown = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainingSeconds = safe % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainingSeconds).padStart(2, '0')}s`;
};

const useUnixNow = (): number => {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
};

export { formatWorldwideDayDisplay };

interface ProductEvidenceProps {
  auction: PublicAuctionRead;
  calendarDay?: CalendarWorldwideDay | null;
}

interface ScopedFailure {
  authority: string;
  failure: PublicReadFailure;
}

const scopedFailures = (auction: PublicAuctionRead, day: CalendarWorldwideDay | null): ScopedFailure[] => {
  const failures: ScopedFailure[] = (day?.failures ?? []).map((failure) => ({
    authority: titleCase(failure.authority),
    failure,
  }));
  if (auction.origin.kind === 'failure') failures.push({ authority: 'Origin', failure: auction.origin.failure });
  if (auction.venue.kind === 'failure') failures.push({ authority: 'Active venue', failure: auction.venue.failure });
  const seen = new Set<string>();
  return failures.filter(({ authority, failure }) => {
    const key = `${authority}:${failure.kind}:${failure.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function AuctionFailureNotices({ auction, calendarDay = null }: ProductEvidenceProps) {
  const failures = scopedFailures(auction, calendarDay);
  if (failures.length === 0) return null;
  return (
    <section className="auction-scoped-failures" aria-label="Scoped protocol failures">
      {failures.map(({ authority, failure }) => (
        <div className="auction-scoped-failure" role="status" key={`${authority}:${failure.kind}:${failure.message}`}>
          <strong>
            {authority} · {titleCase(failure.kind)}
          </strong>
          <span>{failure.message}</span>
        </div>
      ))}
    </section>
  );
}

const lifecycleUnavailableCopy = (auction: PublicAuctionRead, day: CalendarWorldwideDay | null): string => {
  if (day?.venueParticipation === 'skipped')
    return 'The active venue was excluded from global clearing. A venue lifecycle is not applicable.';
  if (day?.venueParticipation === 'not-applicable' || auction.venue.kind === 'not-applicable')
    return 'Canonical origin evidence shows that this WorldwideDay did not proceed to a bidder auction.';
  if (day?.venueReceipt === 'delivery-pending' || auction.venue.kind === 'delivery-pending')
    return "This auction's schedule hasn't arrived at the active venue yet. No dates are available until it does.";
  return 'The active-venue lifecycle is unavailable from the current scoped evidence.';
};

const lifecycleCopy = (
  index: number,
  state: LifecycleStepState,
  stage: VenueAuctionStage,
  presentation: VenueLifecyclePresentation,
  schedule: { commitEnd: bigint; revealEnd: bigint; issuanceEnd: bigint },
  now: number,
): ReactNode => {
  if (state === 'active') {
    if (stage === 'issuance') return presentation.label;
    const deadline = stage === 'committing-bids' ? schedule.commitEnd : schedule.revealEnd;
    const prefix = stage === 'committing-bids' ? 'Commit window ends' : 'Reveal ends';
    const countdownValue = formatCountdown(Number(deadline) - now);
    return (
      <>
        {prefix}
        <br />
        <span className="auction-lifecycle__deadline">
          in{' '}
          <strong className="auction-lifecycle__countdown">
            <FlowingNumberText value={countdownValue} direction={-1} />
          </strong>
        </span>
      </>
    );
  }
  if (state === 'complete') {
    return ['Sealed bids closed', 'Bids revealed', 'Auction results published', 'Intex issuance in progress'][index];
  }
  return [
    `Sealed bids · closes ${scheduleTime(schedule.commitEnd)}`,
    `Starts ${scheduleTime(schedule.commitEnd)}. Ends ${scheduleTime(schedule.revealEnd)}`,
    scheduleTime(schedule.revealEnd),
    `Starts ${scheduleTime(schedule.revealEnd)}`,
  ][index];
};

export function AuctionLifecycleCard({ auction, calendarDay = null }: ProductEvidenceProps) {
  const now = useUnixNow();
  const stage = authoritativeStage(auction, calendarDay);
  const presentation = venueLifecyclePresentation(stage);
  const schedule = authoritativeSchedule(auction, calendarDay);
  const completed = completedAuctionOutcome(auction, stage, calendarDay);
  const noBidCancellation = completed === 'no-bids';
  const noSaleCancellation = completed === 'no-sale';

  if (presentation.cancelled || noBidCancellation || noSaleCancellation) {
    return (
      <Card className="auction-lifecycle-card" aria-label="Active-venue auction lifecycle">
        <div className="auction-section-label">Auction Lifecycle</div>
        <div
          className={`auction-lifecycle-cancelled ${noSaleCancellation ? 'auction-lifecycle-cancelled--warning' : ''}`.trim()}
          role="status"
        >
          <strong>
            {noBidCancellation ? 'No-bid cancellation' : noSaleCancellation ? 'Auction Cancelled' : 'Auction cancelled'}
          </strong>
          <span>
            {noBidCancellation
              ? 'Reveal closed without accepted bids, so the series was cancelled without issuance.'
              : noSaleCancellation
                ? 'Clearing completed without issuance because no revealed demand qualified at the minimum bid rate.'
                : 'The series was cancelled before issuance.'}
          </span>
        </div>
      </Card>
    );
  }

  if (!stage || !schedule) {
    return (
      <Card className="auction-lifecycle-card" aria-label="Active-venue auction lifecycle">
        <div className="auction-section-label">Auction Lifecycle</div>
        <p className="product-empty-state product-empty-state--embedded">
          {lifecycleUnavailableCopy(auction, calendarDay)}
        </p>
      </Card>
    );
  }

  const revealWindow = Math.max(1, Number(schedule.revealEnd - schedule.commitEnd));
  const activeWindow =
    stage === 'issuance' ? Math.max(1, Number(schedule.issuanceEnd - schedule.revealEnd)) : revealWindow;
  const activeDeadline =
    stage === 'committing-bids'
      ? schedule.commitEnd
      : stage === 'revealing-bids'
        ? schedule.revealEnd
        : schedule.issuanceEnd;
  const remainingPercent = Math.max(0, Math.min(100, ((Number(activeDeadline) - now) / activeWindow) * 100));
  const selectedTimeZone = getScheduleTimeZone();
  const timeFormatCopy = selectedTimeZone
    ? `Time is shown in ${selectedTimeZone === 'UTC' ? 'UTC' : selectedTimeZone.replace('_', ' ')}.`
    : `Time is shown in your local timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;
  const timeFormatTip = (
    <span style={{ display: 'block' }}>
      <strong
        style={{
          display: 'block',
          marginBottom: 2,
          fontSize: 15,
          fontWeight: 700,
          lineHeight: 1.25,
          textTransform: 'uppercase',
          letterSpacing: '.04em',
        }}
      >
        Time format
      </strong>
      <span style={{ display: 'block', opacity: 0.82, lineHeight: 1.42 }}>{timeFormatCopy}</span>
    </span>
  );

  return (
    <Card className="auction-lifecycle-card" aria-label="Active-venue auction lifecycle">
      <div className="auction-section-label">Auction Lifecycle</div>
      <div className="auction-lifecycle" role="tablist" aria-label="Auction lifecycle">
        {AUCTION_LIFECYCLE_STEPS.map((label, index) => {
          const state = presentation.steps[index] ?? 'upcoming';
          const active = state === 'active';
          const stepLabel =
            index === 2 ? (state === 'complete' ? 'Clearing Rate Computed' : 'Clearing in progress') : label;
          return (
            <Fragment key={label}>
              <div
                className={`auction-lifecycle__step auction-lifecycle__step--${state}`}
                aria-current={active ? 'step' : undefined}
              >
                <span
                  className="auction-lifecycle__marker"
                  aria-hidden="true"
                  style={active ? { position: 'relative' } : undefined}
                >
                  {active && (
                    <svg viewBox="0 0 34 34" className="auction-lifecycle__ring" aria-hidden="true">
                      <circle cx="17" cy="17" r="15" />
                      {/* Timed stages count the ring down with the window; clearing/issuance is an
                          indeterminate "awaiting results" state, so the ring is fully filled (offset 0). */}
                      <circle
                        cx="17"
                        cy="17"
                        r="15"
                        style={{ strokeDashoffset: stage === 'issuance' ? 0 : 94.25 * (1 - remainingPercent / 100) }}
                      />
                    </svg>
                  )}
                  <span>
                    {state === 'complete' ? (
                      <Icon icon={Check} size={17} />
                    ) : (
                      <FlowingNumberText value={String(index + 1)} />
                    )}
                  </span>
                </span>
                <span className="auction-lifecycle__copy">
                  <strong className="auction-lifecycle__title">
                    {stepLabel}
                    <InfoTip label={`${stepLabel} information`}>
                      {index === 3 ? (
                        <>
                          <span style={{ display: 'block' }}>
                            <strong
                              style={{
                                display: 'block',
                                marginBottom: 2,
                                fontSize: 15,
                                fontWeight: 700,
                                lineHeight: 1.25,
                                textTransform: 'uppercase',
                                letterSpacing: '.04em',
                              }}
                            >
                              When issuance happens
                            </strong>
                            <span style={{ display: 'block', opacity: 0.82, lineHeight: 1.42 }}>
                              After clearing rate is computed, Intexes are issued to winning revealed bids.
                            </span>
                          </span>
                          <span style={{ display: 'block', marginTop: 10 }}>
                            <strong
                              style={{
                                display: 'block',
                                marginBottom: 2,
                                fontSize: 15,
                                fontWeight: 700,
                                lineHeight: 1.25,
                                textTransform: 'uppercase',
                                letterSpacing: '.04em',
                              }}
                            >
                              What is issued
                            </strong>
                            <span style={{ display: 'block', opacity: 0.82, lineHeight: 1.42 }}>
                              Each Intex, once settled, represents a conditional right to mine Promis.
                            </span>
                          </span>
                          <span style={{ display: 'block', marginTop: 10 }}>{timeFormatTip}</span>
                        </>
                      ) : (
                        timeFormatTip
                      )}
                    </InfoTip>
                  </strong>
                  <span>{lifecycleCopy(index, state, stage, presentation, schedule, now)}</span>
                </span>
              </div>
              {index < AUCTION_LIFECYCLE_STEPS.length - 1 && (
                <span
                  className={`auction-lifecycle__connector auction-lifecycle__connector--${state}`}
                  aria-hidden="true"
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </Card>
  );
}

const supplyMetric = (
  auction: PublicAuctionRead,
  day: CalendarWorldwideDay | null,
): { value: string; detail: string } => {
  const venue = auction.venue.kind === 'delivered' ? auction.venue.auction : null;
  const offered = day?.globalAuction.offeredQuantity;
  if (
    !venue ||
    offered === null ||
    offered === undefined ||
    day?.globalAuction.offeredQuantityEvidence === 'unavailable'
  ) {
    return { value: '—', detail: 'Known only at clearing' };
  }
  const totalPromis = offered * venue.params.promisLoadMinor;
  return {
    value: `${integer(offered)} ${offered === 1n ? 'Intex' : 'Intexes'}`,
    detail: `${formatTokenAmount18(totalPromis)} Promis offered`,
  };
};

export function AuctionKeyMetrics({ auction, calendarDay = null }: ProductEvidenceProps) {
  const currency = useCurrencyFormatters();
  if (auction.venue.kind !== 'delivered') {
    return (
      <Card className="auction-metrics-card" aria-label="Key auction metrics">
        <MetricGrid>
          <Metric label="Entry Price" value="—" detail="COEN entry price" />
          <Metric label="Supply" value="—" detail="Known only at clearing" />
          <Metric label="Sealed Bids" value="—" detail="Sealed so far" />
        </MetricGrid>
      </Card>
    );
  }

  const venue = auction.venue.auction;
  const supply = supplyMetric(auction, calendarDay);
  const stage = authoritativeStage(auction, calendarDay) ?? venue.stage;
  const revealOpen = stage !== 'committing-bids';
  return (
    <Card className="auction-metrics-card" aria-label="Key auction metrics">
      <MetricGrid>
        <Metric
          label={
            <>
              Entry Price{' '}
              <InfoTip label="The anchor">COEN reference price captured at the start of the auction.</InfoTip>
            </>
          }
          value={currency.formatReferenceValue(venue.params.entryPriceMinor, venue.params.referenceCurrency, {
            live: true,
          })}
          detail="COEN entry price"
        />
        <Metric label="Supply" value={supply.value} detail={supply.detail} />
        <Metric label="Sealed Bids" value={integer(venue.runningCounts.committedBids)} detail="Sealed so far" />
        {revealOpen && (
          <Metric label="Revealed Bids" value={integer(venue.runningCounts.revealedBids)} detail="Revealed so far" />
        )}
      </MetricGrid>
    </Card>
  );
}

interface ActionRailCopy {
  body: string;
  button: string | null;
  heading: string;
  icon: 'commit' | 'reveal' | null;
  tone: PresentationTone;
}

const actionRailCopy = (auction: PublicAuctionRead, day: CalendarWorldwideDay | null): ActionRailCopy => {
  if (day?.venueParticipation === 'skipped')
    return {
      heading: 'Active venue skipped',
      body: 'This venue was excluded from global clearing.',
      button: null,
      icon: null,
      tone: 'danger',
    };
  if (day?.venueParticipation === 'not-applicable' || auction.venue.kind === 'not-applicable')
    return {
      heading: 'No bidder auction',
      body: 'Canonical origin evidence shows that this WorldwideDay did not proceed to a bidder auction.',
      button: null,
      icon: null,
      tone: 'neutral',
    };
  if (day?.venueReceipt === 'delivery-pending' || auction.venue.kind === 'delivery-pending')
    return {
      heading: 'Auction delivery pending',
      body: "The active venue hasn't received the auction schedule yet. No dates are available until it does.",
      button: null,
      icon: null,
      tone: 'warning',
    };
  if (auction.venue.kind === 'failure')
    return {
      heading: 'Venue evidence unavailable',
      body: 'The scoped venue read failed. Healthy origin evidence remains available.',
      button: null,
      icon: null,
      tone: 'danger',
    };
  if (auction.venue.kind !== 'delivered')
    return {
      heading: 'Auction unavailable',
      body: 'Review the available public evidence for this WorldwideDay.',
      button: null,
      icon: null,
      tone: 'neutral',
    };
  switch (auction.venue.auction.stage) {
    case 'committing-bids':
      return {
        heading: 'Place your bid',
        body: 'Wallet actions are not enabled in this phase.',
        button: 'Commit Sealed Bid',
        icon: 'commit',
        tone: 'success',
      };
    case 'revealing-bids':
      return {
        heading: 'Reveal your bid',
        body: 'No bidder commitment is inferred in this read-only phase.',
        button: 'Reveal Bid',
        icon: 'reveal',
        tone: 'success',
      };
    case 'issuance':
      return {
        heading: 'Clearing in progress',
        body: 'The public venue auction is issuing. Bidder allocation requires wallet-specific evidence.',
        button: null,
        icon: null,
        tone: 'info',
      };
    case 'completed': {
      const outcome = completedAuctionOutcome(auction, 'completed', day);
      if (outcome === 'no-bids') {
        return {
          heading: 'No-bid cancellation',
          body: 'Reveal closed without accepted bids, so the series was cancelled without issuance.',
          button: null,
          icon: null,
          tone: 'danger',
        };
      }
      if (outcome === 'no-sale') {
        return {
          heading: 'Auction Cancelled',
          body: 'No revealed demand qualified at the minimum bid rate, so the series was cancelled without issuance.',
          button: null,
          icon: null,
          tone: 'warning',
        };
      }
      return {
        heading: 'Your result',
        body: 'Connect your wallet to see your allocation and funds.',
        button: null,
        icon: null,
        tone: 'info',
      };
    }
    case 'cancelled':
      return {
        heading: 'Series cancelled',
        body: 'The auction was cancelled before issuance.',
        button: null,
        icon: null,
        tone: 'danger',
      };
  }
};

export function ReadOnlyActionRail({ auction, calendarDay = null }: ProductEvidenceProps) {
  const copy = actionRailCopy(auction, calendarDay);
  const actionIcon = copy.icon === 'commit' ? FileSignature : ShieldCheck;
  return (
    <Card className={`action-card action-card--${copy.tone}`} aria-labelledby="action-card-title">
      <h2 id="action-card-title">{copy.heading}</h2>
      {copy.button ? (
        <Button className="action-card__button" disabled title={copy.body}>
          <Icon icon={actionIcon} size={15} />
          {copy.button}
        </Button>
      ) : (
        <p>{copy.body}</p>
      )}
    </Card>
  );
}

function EvidenceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="protocol-evidence__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EvidenceGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="protocol-evidence__group">
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

export const originLifecycle = (origin: OriginReadState): string =>
  origin.kind === 'retained'
    ? titleCase(origin.worldwideDay.lifecycle)
    : origin.kind === 'history-unavailable'
      ? 'History unavailable'
      : origin.kind === 'not-found'
        ? 'Not found'
        : 'Unavailable';
export const originDayType = (origin: OriginReadState): string =>
  origin.kind === 'retained' ? titleCase(origin.worldwideDay.dayType) : 'Unavailable';
const venueDelivery = (venue: VenueReadState): string =>
  venue.kind === 'delivered'
    ? 'Delivered'
    : venue.kind === 'delivery-pending'
      ? 'Venue schedule pending'
      : venue.kind === 'not-applicable'
        ? 'Not applicable'
        : 'Unavailable';

export function ProtocolEvidence({ auction, calendarDay = null }: ProductEvidenceProps) {
  const failures = scopedFailures(auction, calendarDay);
  const globalStage =
    calendarDay?.globalAuction.stage ??
    (auction.origin.kind === 'retained' ? auction.origin.globalAuction.stage : null);
  const canonicalSeries =
    calendarDay?.canonicalSeries ?? (auction.origin.kind === 'retained' ? auction.origin.canonicalSeries : null);
  const terminal =
    calendarDay?.terminalDisposition ??
    (auction.origin.kind === 'retained' ? (auction.origin.terminal?.disposition ?? null) : null);
  return (
    <details className="card protocol-evidence">
      <summary>
        <span>
          <strong>Protocol Evidence</strong>
          <small>Authority-specific diagnostics</small>
        </span>
        <span aria-hidden="true">＋</span>
      </summary>
      <div className="protocol-evidence__content">
        <EvidenceGroup title="Metadosis">
          <EvidenceRow label="Lifecycle">{originLifecycle(auction.origin)}</EvidenceRow>
          <EvidenceRow label="Day type">{originDayType(auction.origin)}</EvidenceRow>
          <EvidenceRow label="Terminal disposition">{terminal ? titleCase(terminal) : 'None observed'}</EvidenceRow>
        </EvidenceGroup>
        <EvidenceGroup title="Desis">
          <EvidenceRow label="Global stage">{globalStage ? titleCase(globalStage) : 'Unavailable'}</EvidenceRow>
          <EvidenceRow label="Venue participation">
            {calendarDay ? titleCase(calendarDay.venueParticipation) : 'Unavailable'}
          </EvidenceRow>
          <EvidenceRow label="Gross included demand">
            {calendarDay?.globalAuction.grossIncludedDemand?.toString() ?? 'Unavailable'}
          </EvidenceRow>
        </EvidenceGroup>
        <EvidenceGroup title="OriginRouter">
          <EvidenceRow label="Stage-start send">
            {calendarDay ? titleCase(calendarDay.originDelivery.stageStart) : 'Unavailable'}
          </EvidenceRow>
          <EvidenceRow label="Clearing send">
            {calendarDay ? titleCase(calendarDay.originDelivery.clearing) : 'Unavailable'}
          </EvidenceRow>
          <EvidenceRow label="Result send">
            {calendarDay ? titleCase(calendarDay.originDelivery.result) : 'Unavailable'}
          </EvidenceRow>
        </EvidenceGroup>
        <EvidenceGroup title="Active venue">
          <EvidenceRow label="Delivery">{venueDelivery(auction.venue)}</EvidenceRow>
          <EvidenceRow label="Venue stage">
            {authoritativeStage(auction, calendarDay)
              ? titleCase(authoritativeStage(auction, calendarDay)!)
              : 'Unavailable'}
          </EvidenceRow>
          <EvidenceRow label="wCOEN">
            {auction.venue.kind === 'delivered' ? (
              <code className="address">{auction.venue.auction.paymentToken}</code>
            ) : (
              'Unavailable'
            )}
          </EvidenceRow>
        </EvidenceGroup>
        <EvidenceGroup title="Canonical Intex">
          <EvidenceRow label="Existence">
            {canonicalSeries ? `Series ${canonicalSeries.seriesId} exists` : 'No canonical series recorded'}
          </EvidenceRow>
          <EvidenceRow label="Lifecycle state">
            {canonicalSeries ? `State tag ${canonicalSeries.state}` : 'Not applicable or unavailable'}
          </EvidenceRow>
        </EvidenceGroup>
        <EvidenceGroup title="Scoped failures">
          {failures.length > 0 ? (
            failures.map(({ authority, failure }) => (
              <EvidenceRow label={authority} key={`${authority}:${failure.kind}:${failure.message}`}>
                {titleCase(failure.kind)} · {failure.message}
              </EvidenceRow>
            ))
          ) : (
            <p className="protocol-evidence__empty">No scoped failures are present.</p>
          )}
        </EvidenceGroup>
      </div>
    </details>
  );
}

export function PublicAuctionView({ auction, calendarDay = null }: ProductEvidenceProps) {
  const status = venueStatusPresentation(auction, calendarDay);
  return (
    <div className="public-auction-product">
      <header className="auction-page-heading">
        <div className="auction-page-heading__identity">
          <span className="auction-page-heading__title">Auction</span>
          <span aria-hidden="true" />
          <Badge className={venueStatusClassName(status)} tone={status.tone} dot>
            {status.label}
          </Badge>
          <span aria-hidden="true" />
          <strong>{formatWorldwideDayDisplay(auction.worldwideDay)}</strong>
        </div>
      </header>
      <AuctionFailureNotices auction={auction} calendarDay={calendarDay} />
      <div className="auction-product-layout">
        <div className="auction-product-main">
          <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.lifecycle} worldwideDay={auction.worldwideDay}>
            <AuctionLifecycleCard auction={auction} calendarDay={calendarDay} />
          </AuctionWidgetBoundary>
          <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.metrics} worldwideDay={auction.worldwideDay}>
            <AuctionKeyMetrics auction={auction} calendarDay={calendarDay} />
          </AuctionWidgetBoundary>
          <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.instrument} worldwideDay={auction.worldwideDay}>
            <InstrumentSpecification auction={auction} calendarDay={calendarDay} />
          </AuctionWidgetBoundary>
        </div>
        <aside className="auction-product-rail">
          <AuctionWidgetBoundary name={AUCTION_WIDGET_BOUNDARIES.actionRail} worldwideDay={auction.worldwideDay}>
            <ReadOnlyActionRail auction={auction} calendarDay={calendarDay} />
          </AuctionWidgetBoundary>
        </aside>
      </div>
    </div>
  );
}
