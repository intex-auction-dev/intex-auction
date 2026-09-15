import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import type { CalendarRangeRead } from '../calendar-evidence';
import type { WorldwideDayKey } from '../../domain/protocol-time';
import { Button, Icon } from '../../ui/primitives';

export interface PreviousDemandPoint {
  cancelled: boolean;
  date: WorldwideDayKey;
  ratio: number;
}

export const previousDemandPoints = (
  calendar: CalendarRangeRead,
  selectedWorldwideDay: WorldwideDayKey,
): PreviousDemandPoint[] =>
  calendar.days
    .filter((day) => day.worldwideDay < selectedWorldwideDay)
    .reduce<PreviousDemandPoint[]>((points, day) => {
      const demand = day.globalAuction.grossIncludedDemand;
      const supply = day.globalAuction.offeredQuantity;
      const cancelled = day.dayType === 'red' || day.lifecycle === 'failed';
      if (cancelled) points.push({ cancelled, date: day.worldwideDay, ratio: 0 });
      else if (demand !== null && supply !== null && supply > 0n)
        points.push({ cancelled, date: day.worldwideDay, ratio: Number(demand) / Number(supply) });
      return points;
    }, []);

const DEMAND_PAGE_SIZE = 7;

export const previousDemandPage = (
  data: readonly PreviousDemandPoint[],
  pageFromLatest: number,
): { data: readonly PreviousDemandPoint[]; page: number; totalPages: number } => {
  const totalPages = Math.max(1, Math.ceil(data.length / DEMAND_PAGE_SIZE));
  const page = Math.min(Math.max(0, pageFromLatest), totalPages - 1);
  const end = Math.max(0, data.length - page * DEMAND_PAGE_SIZE);
  const start = Math.max(0, end - DEMAND_PAGE_SIZE);
  return { data: data.slice(start, end), page, totalPages };
};

export function DemandBarChart({ data }: { data: readonly PreviousDemandPoint[] }) {
  const maxRatio = Math.max(1, ...data.map((point) => point.ratio));
  const cap = Math.ceil(maxRatio);
  const width = 380;
  const height = 180;
  const padLeft = 40;
  const padBottom = 38;
  const padTop = 12;
  const chartHeight = height - padTop - padBottom;
  const columnWidth = (width - padLeft - 16) / Math.max(data.length, 1);
  const barWidth = columnWidth - 6;

  return (
    <svg
      className="demand-popover__chart"
      viewBox={`0 0 ${width} ${height}`}
      aria-label="Past auction oversubscription chart"
    >
      <defs>
        <linearGradient id="product-demand-over-gradient" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgba(37,99,235,0.7)" />
          <stop offset="100%" stopColor="rgba(20,50,160,1)" />
        </linearGradient>
      </defs>
      {Array.from({ length: cap + 1 }, (_, index) => {
        const y = padTop + chartHeight - (index / cap) * chartHeight;
        const tick = index;
        return (
          <g key={`gridline-${tick}x`}>
            <line x1={padLeft} x2={width - 12} y1={y} y2={y} className="demand-popover__gridline" />
            <text
              x={padLeft - 8}
              y={y + 5}
              textAnchor="end"
              className={
                index === 1
                  ? 'demand-popover__axis-label demand-popover__axis-label--baseline'
                  : 'demand-popover__axis-label'
              }
            >
              {index}×
            </text>
          </g>
        );
      })}
      {data.map((point, index) => {
        const x = padLeft + index * columnWidth + 3;
        const baseHeight = (Math.min(point.ratio, 1) / cap) * chartHeight;
        const overHeight = (Math.max(0, point.ratio - 1) / cap) * chartHeight;
        const label = `${point.date.slice(6, 8)}.${point.date.slice(4, 6)}`;
        return (
          <g key={point.date}>
            {!point.cancelled && (
              <>
                <rect
                  x={x}
                  y={padTop + chartHeight - baseHeight}
                  width={barWidth}
                  height={baseHeight}
                  rx={overHeight > 0 ? 0 : 3}
                  className="demand-popover__bar-base"
                />
                {overHeight > 0 && (
                  <rect
                    x={x}
                    y={padTop + chartHeight - baseHeight - overHeight}
                    width={barWidth}
                    height={overHeight + baseHeight}
                    rx={3}
                    className="demand-popover__bar-base"
                  />
                )}
                {overHeight > 0 &&
                  (() => {
                    const radius = 3;
                    const y = padTop + chartHeight - baseHeight - overHeight;
                    return (
                      <path
                        d={`M${x + radius},${y} h${barWidth - 2 * radius} a${radius},${radius} 0 0 1 ${radius},${radius} v${overHeight - radius} h${-barWidth} v${-(overHeight - radius)} a${radius},${radius} 0 0 1 ${radius},${-radius}z`}
                        fill="url(#product-demand-over-gradient)"
                      />
                    );
                  })()}
              </>
            )}
            <text
              x={x + barWidth / 2}
              y={height - 10}
              textAnchor="middle"
              className={
                point.cancelled ? 'demand-popover__date demand-popover__date--cancelled' : 'demand-popover__date'
              }
            >
              {label}
            </text>
          </g>
        );
      })}
      <line
        x1={padLeft}
        x2={width - 12}
        y1={padTop + chartHeight - (1 / cap) * chartHeight}
        y2={padTop + chartHeight - (1 / cap) * chartHeight}
        className="demand-popover__baseline"
      />
    </svg>
  );
}

export function DemandPopover({
  data,
  canLoadEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
}: {
  data: readonly PreviousDemandPoint[];
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => Promise<boolean>;
}) {
  const [pageFromLatest, setPageFromLatest] = useState(0);
  const [loadExhausted, setLoadExhausted] = useState(false);
  const directionRef = useRef<'left' | 'right' | 'initial'>('initial');
  const page = previousDemandPage(data, pageFromLatest);
  const atLoadedStart = page.page >= page.totalPages - 1;
  const canGoEarlier = data.length > 0 && !loadingEarlier && !(atLoadedStart && (!canLoadEarlier || loadExhausted));
  const canGoLater = page.page > 0;
  const showEarlier = async () => {
    directionRef.current = 'left';
    if (!atLoadedStart) {
      setPageFromLatest((value) => value + 1);
      return;
    }
    if (!canLoadEarlier || loadingEarlier || !onLoadEarlier) return;
    const loaded = await onLoadEarlier();
    if (loaded) {
      setPageFromLatest((value) => value + 1);
    } else {
      setLoadExhausted(true);
    }
  };
  return (
    <div role="dialog" aria-label="Oversubscription rates of past auctions">
      <div className="demand-popover__header">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Earlier auctions"
          disabled={!canGoEarlier}
          onClick={() => {
            void showEarlier();
          }}
        >
          <Icon icon={ChevronLeft} size={16} />
        </Button>
        <strong>Oversubscription rates of past auctions</strong>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Later auctions"
          disabled={!canGoLater}
          onClick={() => {
            directionRef.current = 'right';
            setPageFromLatest((value) => Math.max(0, value - 1));
          }}
        >
          <Icon icon={ChevronRight} size={16} />
        </Button>
      </div>
      <div key={page.page} className={`demand-popover__page demand-popover__page--${directionRef.current}`}>
        {page.data.length > 0 ? (
          <DemandBarChart data={page.data} />
        ) : (
          <p className="product-empty-state demand-popover__empty">No previous auction demand is available.</p>
        )}
        <section className="calendar-legend demand-popover__legend" aria-label="Previous demand legend">
          {page.data.some((point) => point.cancelled) && (
            <span>
              <i style={{ background: 'var(--color-danger)' }} />
              Red day
            </span>
          )}
        </section>
      </div>
    </div>
  );
}

export function DemandDots({
  calendar,
  selectedWorldwideDay,
  onLoadEarlierDemand,
}: {
  calendar: CalendarRangeRead;
  selectedWorldwideDay: WorldwideDayKey;
  onLoadEarlierDemand?: ((beforeWorldwideDay: WorldwideDayKey) => Promise<CalendarRangeRead | null>) | undefined;
}) {
  const [olderData, setOlderData] = useState<PreviousDemandPoint[]>([]);
  const [earliestLoadedDay, setEarliestLoadedDay] = useState(calendar.start);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const historyGeneration = useRef(0);
  const data = [...olderData, ...previousDemandPoints(calendar, selectedWorldwideDay)];
  const recent = data.slice(-7);
  const max = recent.length > 0 ? Math.max(1, ...recent.map((point) => point.ratio)) : 1;
  const hasAnyData = recent.some((point) => point && point.ratio > 0);

  const loadEarlier = async (): Promise<boolean> => {
    if (!onLoadEarlierDemand || loadingEarlier) return false;
    const generation = historyGeneration.current;
    setLoadingEarlier(true);
    let beforeWorldwideDay = earliestLoadedDay;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const older = await onLoadEarlierDemand(beforeWorldwideDay);
        if (generation !== historyGeneration.current || !older) return false;
        beforeWorldwideDay = older.start;
        setEarliestLoadedDay(beforeWorldwideDay);
        const points = previousDemandPoints(older, selectedWorldwideDay);
        if (points.length > 0) {
          setOlderData((current) => [...points, ...current]);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      if (generation === historyGeneration.current) setLoadingEarlier(false);
    }
  };

  useEffect(() => {
    historyGeneration.current += 1;
    setOlderData([]);
    setEarliestLoadedDay(calendar.start);
    setLoadingEarlier(false);
  }, [calendar.start, selectedWorldwideDay, onLoadEarlierDemand]);

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={0}
        closeDelay={120}
        className="demand-dots auction-calendar-trigger"
        aria-label="Demand history"
      >
        <span>Prev. Demand</span>
        {hasAnyData && (
          <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 3 }}>
            {recent.map((point) => {
              const height = !point || point.ratio === 0 ? 4 : Math.max(5, (point.ratio / max) * 18);
              return <i className="demand-dots__bar" style={{ height }} key={point.date} />;
            })}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="demand-popover-anchor">
          <Popover.Popup className="demand-popover">
            <DemandPopover
              key={selectedWorldwideDay}
              data={data}
              canLoadEarlier={Boolean(onLoadEarlierDemand)}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={loadEarlier}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
