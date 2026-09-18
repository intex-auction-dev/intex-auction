import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import type { CalendarRangeRead, CalendarWorldwideDay } from '../calendar-evidence';
import type { WorldwideDayCalendarMonth, WorldwideDayKey, WorldwideDayMonth } from '../../domain/protocol-time';
import { shiftWorldwideDay } from '../../domain/protocol-time';
import { usePresence } from '../../ui/use-presence';
import { formatWorldwideDayDisplay, titleCase } from '../../ui/display-format';
import { Badge, Button, Icon, type PresentationTone } from '../../ui/primitives';
import { venueStatusPresentation } from '../public-auction-view';

const monthFormatter = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });
const monthName = ({ year, month }: WorldwideDayMonth): string =>
  monthFormatter.format(new Date(Date.UTC(year, month - 1, 1)));

const monthLabel = ({ year, month }: WorldwideDayMonth): string => `${monthName({ year, month })} ${year}`;

const monthRangeLabel = (first: WorldwideDayMonth, second: WorldwideDayMonth): string =>
  first.year === second.year
    ? `${monthName(first)} – ${monthName(second)} ${first.year}`
    : `${monthLabel(first)} – ${monthLabel(second)}`;

const formatWwdDate = (worldwideDay: WorldwideDayKey): string =>
  `${worldwideDay.slice(6, 8)}.${worldwideDay.slice(4, 6)}.${worldwideDay.slice(0, 4)}`;

const originLabel = (day: CalendarWorldwideDay): string => {
  if (day.originRecord.kind === 'not-found') return 'No canonical WWD';
  if (day.originRecord.kind === 'cleaned-history-unavailable') return 'Cleaned history unavailable';
  if (day.originRecord.kind === 'failure') return 'Origin evidence unavailable';
  return `${titleCase(day.dayType ?? 'unknown')} · ${titleCase(day.lifecycle ?? 'unknown')}`;
};

const venueEvidenceLabel = (day: CalendarWorldwideDay): string => {
  if (day.venueParticipation === 'skipped') return 'Venue skipped';
  if (day.venueParticipation === 'not-applicable') return 'No bidder auction';
  if (day.venueReceipt === 'delivery-pending') return 'Delivery pending';
  if (day.venueStage) return titleCase(day.venueStage);
  return titleCase(day.venueReceipt);
};

export const auctionCalendarStatus = (day: CalendarWorldwideDay): { label: string; tone: PresentationTone } => {
  if (day.venueParticipation === 'skipped' || day.venueParticipation === 'not-applicable') {
    return { label: 'No auction', tone: 'neutral' };
  }
  if (day.dayType === 'red' || day.globalAuction.terminalDisposition === 'cancelled-red') {
    return { label: 'Cancelled', tone: 'danger' };
  }
  // An unpriced day is cancelled on-chain but is NOT a red day (Metadosis still classifies it
  // green), so it is reported as cancelled without the red-day danger tone — matching
  // venueStatusPresentation in public-auction-view-presentation.ts so the two surfaces agree.
  if (day.globalAuction.terminalDisposition === 'cancelled-unpriced') {
    return { label: 'Cancelled', tone: 'neutral' };
  }
  if (day.venueStage || day.venueReceipt === 'delivery-pending') {
    const status = venueStatusPresentation(null, day);
    const calendarTone: PresentationTone = status.tone === 'neutral' ? 'success' : status.tone;
    return { label: titleCase(status.label.toLowerCase()), tone: calendarTone };
  }
  if (
    day.globalAuction.terminalDisposition === 'cleared' ||
    day.globalAuction.terminalDisposition === 'cleared-sale' ||
    day.globalAuction.terminalDisposition === 'cleared-no-sale'
  ) {
    return { label: 'Pending', tone: 'warning' };
  }
  if (day.globalAuction.terminalDisposition === 'active') return { label: 'Scheduled', tone: 'success' };
  return { label: 'Unknown', tone: 'neutral' };
};

export const worldwideDayCalendarStatus = (day: CalendarWorldwideDay): { label: string; tone: PresentationTone } => {
  if (day.dayType === 'green') return { label: 'Green day', tone: 'success' };
  if (day.dayType === 'red') return { label: 'Red day', tone: 'danger' };
  return { label: 'Unknown', tone: 'neutral' };
};

export const calendarDayOpensAuction = (day: CalendarWorldwideDay | undefined): boolean => {
  if (!day) return false;
  if (day.originRecord.kind === 'retained' || day.originRecord.kind === 'cleaned-history-unavailable') return true;
  if (day.globalAuction.stage !== null || day.globalAuction.terminalDisposition !== 'none') return true;
  if (Object.values(day.originDelivery).some((delivery) => delivery !== 'not-observed')) return true;
  return (day.venueReceipt !== 'not-observed' && day.venueReceipt !== 'not-applicable') || day.venueStage !== null;
};

function MonthCalendar({
  month,
  byDay,
  selectedWorldwideDay,
  onSelectDay,
  onHoverDay,
}: {
  month: WorldwideDayCalendarMonth;
  byDay: ReadonlyMap<WorldwideDayKey, CalendarWorldwideDay>;
  selectedWorldwideDay: WorldwideDayKey;
  onSelectDay: (worldwideDay: WorldwideDayKey) => void;
  onHoverDay: (worldwideDay: WorldwideDayKey | null) => void;
}) {
  return (
    <section className="calendar-month" aria-label={monthLabel(month)}>
      <h3>{monthLabel(month)}</h3>
      <div className="calendar-weekdays" aria-hidden="true">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="calendar-days">
        {month.cells.map((cell) => {
          if (!cell.inMonth)
            return <span className="calendar-day calendar-day--empty" aria-hidden="true" key={cell.worldwideDay} />;
          const evidence = byDay.get(cell.worldwideDay);
          const selected = cell.worldwideDay === selectedWorldwideDay;
          const label = evidence
            ? `${originLabel(evidence)}. ${venueEvidenceLabel(evidence)}`
            : 'Evidence outside loaded range';
          const auctionStatus = evidence ? auctionCalendarStatus(evidence) : null;
          const hasAuction = auctionStatus !== null && auctionStatus.tone !== 'neutral';
          const tone =
            auctionStatus?.tone === 'success' || auctionStatus?.tone === 'danger'
              ? auctionStatus.tone
              : hasAuction
                ? 'active'
                : 'unknown';
          const className = `calendar-day calendar-day--${tone} ${selected ? 'calendar-day--selected' : ''}`.trim();
          const contents = (
            <>
              <span>{cell.day}</span>
              {hasAuction && <i aria-hidden="true" />}
            </>
          );
          if (!calendarDayOpensAuction(evidence)) {
            return (
              <span
                key={cell.worldwideDay}
                className={className}
                role="img"
                aria-label={`${formatWorldwideDayDisplay(cell.worldwideDay)}. ${label}`}
                style={{ cursor: 'default', pointerEvents: 'none' }}
              >
                {contents}
              </span>
            );
          }
          return (
            <button
              key={cell.worldwideDay}
              type="button"
              className={className}
              aria-pressed={selected}
              aria-label={`${formatWorldwideDayDisplay(cell.worldwideDay)}. ${label}`}
              onClick={() => onSelectDay(cell.worldwideDay)}
              onMouseEnter={() => onHoverDay(cell.worldwideDay)}
              onMouseLeave={() => onHoverDay(null)}
              onFocus={() => onHoverDay(cell.worldwideDay)}
              onBlur={() => onHoverDay(null)}
            >
              {contents}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function CalendarLegend() {
  return (
    <section className="calendar-legend" aria-label="Calendar legend">
      <span>
        <i className="calendar-legend__selected" />
        Selected
      </span>
      <span>
        <i className="calendar-legend__worldwide-day" />
        Worldwide Day
      </span>
      <span>
        <i className="calendar-legend__today" />
        Today's auction
      </span>
      <span>
        <i className="calendar-legend__unknown" />
        Unknown
      </span>
    </section>
  );
}

export function CalendarSelectionSummary({ day }: { day: CalendarWorldwideDay | null }) {
  if (!day)
    return (
      <div className="calendar-selection-summary">
        <p>No auction</p>
      </div>
    );
  const auctionStatus = auctionCalendarStatus(day);
  const worldwideDayStatus = worldwideDayCalendarStatus(day);
  const worldwideDay = shiftWorldwideDay(day.worldwideDay, -24);
  return (
    <div className="calendar-selection-summary">
      <section>
        <div>
          <strong>Auction</strong>
          <Badge tone={auctionStatus.tone}>{auctionStatus.label}</Badge>
        </div>
        <p>{formatWwdDate(day.worldwideDay)}</p>
      </section>
      <section>
        <div>
          <strong>Worldwide Day</strong>
          <Badge tone={worldwideDayStatus.tone}>{worldwideDayStatus.label}</Badge>
        </div>
        <p>{formatWwdDate(worldwideDay)}</p>
      </section>
    </div>
  );
}

export function CalendarSelectionStage({
  selected,
  hovered,
}: {
  selected: CalendarWorldwideDay | null;
  hovered: CalendarWorldwideDay | null;
}) {
  const { mounted, state } = usePresence(hovered !== null);
  const lastHoveredRef = useRef<CalendarWorldwideDay | null>(null);
  useEffect(() => {
    if (hovered) lastHoveredRef.current = hovered;
  }, [hovered]);
  const previewDay = mounted ? (hovered ?? lastHoveredRef.current) : null;
  return (
    <div className="calendar-selection-stage">
      <div className={`calendar-selection-stage__base${mounted ? ' calendar-selection-stage__base--hidden' : ''}`}>
        <CalendarSelectionSummary day={selected} />
      </div>
      {previewDay && (
        <div
          key={previewDay.worldwideDay}
          className={`calendar-selection-stage__preview${state === 'ending' ? ' calendar-selection-stage__preview--ending' : ''}`}
          aria-hidden="true"
        >
          <CalendarSelectionSummary day={previewDay} />
        </div>
      )}
    </div>
  );
}

interface AuctionCalendarPopoverProps {
  calendar: CalendarRangeRead;
  firstMonth: WorldwideDayMonth;
  monthGrids: readonly [WorldwideDayCalendarMonth, WorldwideDayCalendarMonth];
  selectedWorldwideDay: WorldwideDayKey;
  byDay: ReadonlyMap<WorldwideDayKey, CalendarWorldwideDay>;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onSelectDay: (worldwideDay: WorldwideDayKey) => void;
}

export function AuctionCalendarPopover({
  calendar,
  firstMonth,
  monthGrids,
  selectedWorldwideDay,
  byDay,
  onPreviousMonth,
  onNextMonth,
  onSelectDay,
}: AuctionCalendarPopoverProps) {
  const [open, setOpen] = useState(false);
  const [hoveredWorldwideDay, setHoveredWorldwideDay] = useState<WorldwideDayKey | null>(null);
  const directionRef = useRef<'left' | 'right' | 'initial'>('initial');

  useEffect(() => {
    if (!open) setHoveredWorldwideDay(null);
  }, [open]);

  const monthKey = `${firstMonth.year}-${firstMonth.month}`;

  useEffect(() => {
    setHoveredWorldwideDay(null);
  }, [monthKey]);

  const selectDay = (worldwideDay: WorldwideDayKey) => {
    if (!calendarDayOpensAuction(byDay.get(worldwideDay))) return;
    setOpen(false);
    onSelectDay(worldwideDay);
  };

  const hoveredEvidence =
    hoveredWorldwideDay && hoveredWorldwideDay !== selectedWorldwideDay
      ? (byDay.get(hoveredWorldwideDay) ?? null)
      : null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={0}
        closeDelay={120}
        className="auction-calendar-trigger"
        aria-label="Show calendar"
      >
        <Icon icon={CalendarDays} size={16} />
        <span>{formatWorldwideDayDisplay(selectedWorldwideDay)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="auction-calendar-popover-anchor">
          <Popover.Popup className="auction-calendar-popover" role="dialog" aria-label="Auction calendar">
            <div className="auction-calendar-popover__header">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Show previous month"
                onClick={() => {
                  directionRef.current = 'left';
                  onPreviousMonth();
                }}
              >
                <Icon icon={ChevronLeft} />
              </Button>
              <strong>{monthRangeLabel(firstMonth, monthGrids[1])}</strong>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Show next month"
                onClick={() => {
                  directionRef.current = 'right';
                  onNextMonth();
                }}
              >
                <Icon icon={ChevronRight} />
              </Button>
            </div>
            <div key={monthKey} className={`demand-popover__page demand-popover__page--${directionRef.current}`}>
              {calendar.failures.length > 0 && (
                <p className="calendar-failure" role="status">
                  Some calendar evidence is unavailable; retained states remain authority-scoped.
                </p>
              )}
              <div className="calendar-pair">
                <MonthCalendar
                  month={monthGrids[0]}
                  byDay={byDay}
                  selectedWorldwideDay={selectedWorldwideDay}
                  onSelectDay={selectDay}
                  onHoverDay={setHoveredWorldwideDay}
                />
                <MonthCalendar
                  month={monthGrids[1]}
                  byDay={byDay}
                  selectedWorldwideDay={selectedWorldwideDay}
                  onSelectDay={selectDay}
                  onHoverDay={setHoveredWorldwideDay}
                />
              </div>
              <CalendarSelectionStage selected={byDay.get(selectedWorldwideDay) ?? null} hovered={hoveredEvidence} />
              <CalendarLegend />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
