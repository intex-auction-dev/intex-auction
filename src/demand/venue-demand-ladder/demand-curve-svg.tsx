import { ExternalLink } from 'lucide-react';
import { intexUnit } from '../../ui/display-format';
import { explorerLink } from '../explorer-links';
import {
  buildDisplaySegments,
  buildLadderBidDetail,
  resolveLadderLabelOverlaps,
  buildBidRateAxis,
  type LadderDetailRow,
  type VenueDemandModel,
  type VenueLadderOutcome,
} from '../venue-demand-model';
import {
  CHART_HEIGHT,
  clamp,
  DETAIL_FIRST_BASELINE,
  DETAIL_LINE_HEIGHT,
  DETAIL_PAD_BOTTOM,
  DETAIL_PAD_X,
  DETAIL_COLUMN_GAP,
  EXPLORER_ICON_GAP,
  EXPLORER_ICON_SIZE,
  formatChartPercent,
  HOVER_TARGET_OVERHANG,
  labelWidth,
  MIN_HOVER_WIDTH,
  PAD_BOTTOM,
  PAD_LEFT,
  PAD_RIGHT,
  PAD_TOP,
  percentOfEscrowBasis,
  TOOLTIP_GAP,
  TOOLTIP_HEIGHT,
  TOOLTIP_LINE_HEIGHT,
  TOOLTIP_SUBTITLE_Y,
  TOOLTIP_TITLE_Y,
  tooltipHeight,
} from './chart-geometry';

export interface DemandCurveSvgProps {
  model: VenueDemandModel;
  outcome?: VenueLadderOutcome;
  explorerUrl?: string | null;
  chartWidth: number;
  hoveredSegment: number | null;
  onHoverSegment: (updater: number | null | ((current: number | null) => number | null)) => void;
}

export function DemandCurveSvg({
  model,
  outcome,
  explorerUrl,
  chartWidth,
  hoveredSegment,
  onHoverSegment,
}: DemandCurveSvgProps) {
  const plotWidth = chartWidth - PAD_LEFT - PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baseY = PAD_TOP + plotHeight;
  const totalQuantity = model.rows.at(-1)?.cumulativeQuantity ?? 0;
  const maxQuantity = Math.ceil(Math.max(totalQuantity, outcome?.supply ?? 0) / 10) * 10 || 10;
  const clearingRate = model.authoritativeClearingRate === null ? null : Number(model.authoritativeClearingRate);
  const axisValues = model.rows.map((row) => percentOfEscrowBasis(row.bidRate));
  if (clearingRate !== null) axisValues.push(percentOfEscrowBasis(clearingRate));
  const axis = buildBidRateAxis(axisValues, plotHeight);
  const x = (quantity: number) => PAD_LEFT + (quantity / maxQuantity) * plotWidth;
  const yPercent = (value: number) => PAD_TOP + (1 - (value - axis.min) / (axis.max - axis.min)) * plotHeight;
  const yRate = (rate: number) => yPercent(percentOfEscrowBasis(rate));
  const segments = buildDisplaySegments(model.rows, clearingRate, outcome);

  const path = `${segments
    .map((segment, index) => {
      const startX = x(clamp(segment.start, 0, maxQuantity));
      const endX = x(clamp(segment.end, 0, maxQuantity));
      const rowY = yRate(segment.row.bidRate);
      return `${index === 0 ? 'M' : 'L'} ${startX} ${rowY} L ${endX} ${rowY}`;
    })
    .join(' ')} L ${x(clamp(totalQuantity, 0, maxQuantity))} ${baseY}`;

  const clearingY = clearingRate === null ? null : yRate(clearingRate);
  const clearingTitle = clearingRate === null ? null : formatChartPercent(percentOfEscrowBasis(clearingRate));
  const clearingBadgeWidth =
    clearingTitle === null ? 0 : Math.max(labelWidth(clearingTitle, 15, 16), labelWidth('Clearing Rate', 15, 16), 112);
  const clearingBadgeHeight = TOOLTIP_HEIGHT;
  const clearingBadgeX = PAD_LEFT + plotWidth - clearingBadgeWidth;
  const clearingBadgeY =
    clearingY === null ? 0 : clamp(clearingY - clearingBadgeHeight - 7, PAD_TOP + 3, baseY - clearingBadgeHeight - 3);
  const supply = outcome && clearingY !== null ? outcome.supply : null;
  const supplyTitle = supply === null ? null : `${supply} ${intexUnit(supply)}`;
  const supplyBadgeWidth =
    supplyTitle === null ? 0 : Math.max(labelWidth(supplyTitle, 15, 16), labelWidth('Total Supply', 15, 16), 112);
  const supplyBadgeHeight = TOOLTIP_HEIGHT;
  const supplyBadgeX =
    supply === null ? 0 : clamp(x(supply) - supplyBadgeWidth / 2, PAD_LEFT, PAD_LEFT + plotWidth - supplyBadgeWidth);
  const supplyBadgeY = baseY + 20;
  const supplySegment =
    supply === null ? null : (segments.find((segment) => supply > segment.start && supply <= segment.end) ?? null);
  const mine = segments.find((segment) => segment.mine) ?? null;
  const hasFilled = segments.some((segment) => segment.won !== null && segment.won > 0);
  const hasRefund =
    clearingRate !== null &&
    segments.some((segment) => segment.won !== null && segment.won > 0 && segment.row.bidRate > clearingRate);

  const visiblePills = segments.flatMap((segment, index) => {
    const hovered = hoveredSegment === index;
    const showPartial = segment.won !== null && segment.won > 0 && segment.won < segment.row.quantity && segment.mine;
    const showMineFull = segment.mine && segment.won !== null && segment.won === segment.row.quantity;
    if (!hovered && !showPartial && !showMineFull) return [];
    const rows: LadderDetailRow[] = hovered
      ? buildLadderBidDetail(segment, clearingRate)
      : [
          { label: segment.mine ? 'Your bid' : 'Partial fill', value: null },
          {
            label: showPartial ? `${segment.won}/${segment.row.quantity} filled` : `${segment.won} filled`,
            value: null,
          },
        ];
    const explorerHref = hovered
      ? explorerLink(explorerUrl ?? null, 'tx', segment.row.provenance.transactionHash)
      : null;
    const titleExtra = explorerHref === null ? 0 : EXPLORER_ICON_SIZE + EXPLORER_ICON_GAP;
    const pillWidth = Math.max(
      ...rows.map((row, rowIndex) =>
        row.value === null
          ? labelWidth(row.label, 15, hovered ? DETAIL_PAD_X * 2 : 14) + (rowIndex === 0 ? titleExtra : 0)
          : labelWidth(row.label, 15, 0) + DETAIL_COLUMN_GAP + labelWidth(row.value, 15, 0) + DETAIL_PAD_X * 2,
      ),
    );
    const lineHeight = hovered ? DETAIL_LINE_HEIGHT : TOOLTIP_LINE_HEIGHT;
    const firstBaseline = hovered ? DETAIL_FIRST_BASELINE : TOOLTIP_TITLE_Y;
    const pillHeight = hovered
      ? firstBaseline + (rows.length - 1) * lineHeight + DETAIL_PAD_BOTTOM
      : tooltipHeight(rows.length);
    const centreQuantity = segment.start + (hovered || !showPartial ? segment.row.quantity / 2 : segment.won! / 2);
    const centreX = x(clamp(centreQuantity, 0, maxQuantity));
    const rowY = yRate(segment.row.bidRate);
    const anchorY = segment.row.bidRate > (clearingRate ?? segment.row.bidRate) ? rowY : (clearingY ?? rowY);
    const above = anchorY - pillHeight - TOOLTIP_GAP;
    const pillY = hovered
      ? rowY - pillHeight - TOOLTIP_GAP
      : above >= PAD_TOP - HOVER_TARGET_OVERHANG
        ? above
        : Math.min(anchorY + TOOLTIP_GAP, baseY - pillHeight);
    return [
      {
        index,
        segment,
        mine: segment.mine,
        hovered,
        explorerHref,
        titleExtra,
        rows,
        lineHeight,
        firstBaseline,
        side: hovered || above >= PAD_TOP - HOVER_TARGET_OVERHANG ? ('top' as const) : ('bottom' as const),
        width: pillWidth,
        height: pillHeight,
        x: clamp(centreX - pillWidth / 2, PAD_LEFT, PAD_LEFT + plotWidth - pillWidth),
        y: pillY,
      },
    ];
  });

  const lostPill =
    mine && mine.won === 0
      ? (() => {
          const width = labelWidth('Not filled', 15, 14);
          return {
            width,
            height: TOOLTIP_HEIGHT,
            x: clamp(
              x(clamp((mine.start + mine.end) / 2, 0, maxQuantity)) - width / 2,
              PAD_LEFT,
              PAD_LEFT + plotWidth - width,
            ),
            y: supplyBadgeY,
          };
        })()
      : null;
  const clearingBadge =
    clearingY !== null && clearingTitle !== null
      ? { width: clearingBadgeWidth, height: clearingBadgeHeight, x: clearingBadgeX, y: clearingBadgeY }
      : null;
  const supplyBadgeLabel =
    supply !== null && supplyTitle !== null
      ? { width: supplyBadgeWidth, height: supplyBadgeHeight, x: supplyBadgeX, y: supplyBadgeY, markX: x(supply) }
      : null;

  resolveLadderLabelOverlaps(
    [
      ...(clearingBadge === null ? [] : [clearingBadge]),
      ...(supplyBadgeLabel === null ? [] : [supplyBadgeLabel]),
      ...(lostPill === null ? [] : [lostPill]),
      ...visiblePills.filter((pill) => !pill.hovered),
    ],
    { minX: PAD_LEFT, maxX: PAD_LEFT + plotWidth },
  );

  return (
    <>
      <svg
        viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        preserveAspectRatio="xMinYMin meet"
        style={{ height: CHART_HEIGHT }}
        onMouseLeave={() => onHoverSegment(null)}
      >
        <defs>
          <pattern
            id="venue-refund-hatch"
            patternUnits="userSpaceOnUse"
            width="14"
            height="14"
            patternTransform="rotate(45)"
          >
            <rect width="14" height="14" fill="var(--color-accent-soft)" />
            <line x1="3.5" y1="0" x2="3.5" y2="14" stroke="var(--color-accent)" strokeOpacity="0.12" strokeWidth="7" />
          </pattern>
          <pattern
            id="venue-refund-mine-hatch"
            patternUnits="userSpaceOnUse"
            width="14"
            height="14"
            patternTransform="rotate(45)"
          >
            <rect width="14" height="14" fill="var(--color-accent)" />
            <line x1="3.5" y1="0" x2="3.5" y2="14" stroke="#fff" strokeOpacity="0.38" strokeWidth="7" />
          </pattern>
          <pattern
            id="venue-lost-hatch"
            patternUnits="userSpaceOnUse"
            width="14"
            height="14"
            patternTransform="rotate(45)"
          >
            <rect width="14" height="14" fill="var(--color-danger-soft)" />
            <line x1="3.5" y1="0" x2="3.5" y2="14" stroke="var(--color-danger)" strokeOpacity="0.22" strokeWidth="7" />
          </pattern>
        </defs>
        {axis.ticks.map((value) => {
          const tickY = yPercent(value);
          return (
            <g key={value}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={tickY}
                y2={tickY}
                className="venue-demand-curve__grid"
              />
              <text x={PAD_LEFT - 9} y={tickY + 5} textAnchor="end" className="venue-demand-curve__axis-tick">
                {formatChartPercent(value)}
              </text>
            </g>
          );
        })}
        {clearingY !== null &&
          segments.map((segment) => {
            const segmentKey = `${segment.row.provenance.transactionHash}:${segment.row.provenance.logIndex}`;
            if (segment.won === null) return null;
            const rowY = yRate(segment.row.bidRate);
            const startX = x(clamp(segment.start, 0, maxQuantity));
            const wonX = x(clamp(segment.start + segment.won, 0, maxQuantity));
            const endX = x(clamp(segment.end, 0, maxQuantity));
            const wonWidth = Math.max(0, wonX - startX);
            const lostWidth = Math.max(0, endX - wonX);
            if (segment.won <= 0) {
              return segment.mine && lostWidth > 0 ? (
                <rect
                  key={segmentKey}
                  x={startX}
                  y={rowY}
                  width={lostWidth}
                  height={baseY - rowY}
                  fill="url(#venue-lost-hatch)"
                  stroke="var(--color-danger-soft)"
                />
              ) : null;
            }
            const overTop = Math.max(rowY, PAD_TOP);
            return (
              <g key={segmentKey}>
                <rect
                  x={startX}
                  y={clearingY}
                  width={wonWidth}
                  height={baseY - clearingY}
                  fill={segment.mine ? 'var(--color-accent)' : 'var(--color-accent-soft)'}
                  stroke={segment.mine ? 'var(--color-accent)' : 'var(--color-accent-border)'}
                />
                {rowY < clearingY && (
                  <rect
                    x={startX}
                    y={overTop}
                    width={wonWidth}
                    height={clearingY - overTop}
                    fill={segment.mine ? 'url(#venue-refund-mine-hatch)' : 'url(#venue-refund-hatch)'}
                  />
                )}
                {lostWidth > 0 && (
                  <rect
                    x={wonX}
                    y={clearingY}
                    width={lostWidth}
                    height={baseY - clearingY}
                    fill={segment.mine ? 'url(#venue-refund-mine-hatch)' : 'url(#venue-refund-hatch)'}
                  />
                )}
              </g>
            );
          })}
        <path d={path} className="venue-demand-curve__line" />
        {mine &&
          mine.won !== null &&
          mine.won < mine.row.quantity &&
          (() => {
            const markerY = yRate(mine.row.bidRate);
            const markerStart = x(clamp(mine.start + mine.won, 0, maxQuantity));
            const markerEnd = x(clamp(mine.end, 0, maxQuantity));
            return markerEnd > markerStart ? (
              <line
                x1={markerStart}
                x2={markerEnd}
                y1={markerY}
                y2={markerY}
                stroke={mine.won === 0 ? 'var(--color-danger)' : 'var(--color-accent)'}
                strokeWidth={mine.won === 0 ? 1.5 : 3}
                strokeDasharray={mine.won === 0 ? undefined : '4 3'}
              />
            ) : null;
          })()}
        {hoveredSegment !== null &&
          (() => {
            const segment = segments[hoveredSegment];
            if (!segment) return null;
            const startX = x(clamp(segment.start, 0, maxQuantity));
            const endX = x(clamp(segment.end, 0, maxQuantity));
            const rowY = yRate(segment.row.bidRate);
            return (
              <g key={hoveredSegment} style={{ pointerEvents: 'none' }}>
                <rect
                  className="venue-demand-curve__hover-band"
                  x={startX}
                  y={PAD_TOP}
                  width={Math.max(0, endX - startX)}
                  height={baseY - PAD_TOP}
                />
                <line className="venue-demand-curve__hover-step" x1={startX} x2={endX} y1={rowY} y2={rowY} />
              </g>
            );
          })()}
        {clearingBadge !== null && clearingY !== null && (
          <g className="venue-demand-curve__tooltip venue-demand-curve__tooltip--clearing">
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + plotWidth}
              y1={clearingY}
              y2={clearingY}
              className="venue-demand-curve__clearing"
            />
            <rect
              x={clearingBadge.x}
              y={clearingBadge.y}
              width={clearingBadge.width}
              height={clearingBadge.height}
              rx="4"
              className="venue-demand-curve__clearing-badge"
            />
            <text
              x={clearingBadge.x + clearingBadge.width / 2}
              y={clearingBadge.y + TOOLTIP_TITLE_Y}
              textAnchor="middle"
              className="venue-demand-curve__tooltip-title"
            >
              {clearingTitle}
            </text>
            <text
              x={clearingBadge.x + clearingBadge.width / 2}
              y={clearingBadge.y + TOOLTIP_SUBTITLE_Y}
              textAnchor="middle"
              className="venue-demand-curve__tooltip-subtitle"
            >
              Clearing Rate
            </text>
          </g>
        )}
        {supplyBadgeLabel !== null && (
          <g className="venue-demand-curve__tooltip venue-demand-curve__tooltip--inverse">
            <line
              x1={supplyBadgeLabel.markX}
              x2={supplyBadgeLabel.markX}
              y1={supplySegment ? yRate(supplySegment.row.bidRate) : baseY}
              y2={supplyBadgeLabel.y}
              stroke="var(--color-foreground)"
              strokeWidth="1"
            />
            <rect
              x={supplyBadgeLabel.x}
              y={supplyBadgeLabel.y}
              width={supplyBadgeLabel.width}
              height={supplyBadgeLabel.height}
              rx="4"
              fill="var(--color-badge)"
            />
            <text
              className="venue-demand-curve__tooltip-title"
              x={supplyBadgeLabel.x + supplyBadgeLabel.width / 2}
              y={supplyBadgeLabel.y + TOOLTIP_TITLE_Y}
              textAnchor="middle"
            >
              {supplyTitle}
            </text>
            <text
              className="venue-demand-curve__tooltip-subtitle"
              x={supplyBadgeLabel.x + supplyBadgeLabel.width / 2}
              y={supplyBadgeLabel.y + TOOLTIP_SUBTITLE_Y}
              textAnchor="middle"
            >
              Total Supply
            </text>
          </g>
        )}
        {segments
          .map((segment, index) => {
            const startX = x(clamp(segment.start, 0, maxQuantity));
            const width = Math.max(MIN_HOVER_WIDTH, x(clamp(segment.end, 0, maxQuantity)) - startX);
            return { index, width, x: clamp(startX, PAD_LEFT, PAD_LEFT + plotWidth - width) };
          })
          .sort((left, right) => right.width - left.width)
          .map((target) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: deferred keyboard-accessible chart work
            <rect
              key={`hover-${target.index}`}
              x={target.x}
              y={PAD_TOP - HOVER_TARGET_OVERHANG}
              width={target.width}
              height={baseY - PAD_TOP + HOVER_TARGET_OVERHANG}
              fill="transparent"
              onMouseEnter={() => onHoverSegment(target.index)}
              onMouseLeave={() => onHoverSegment((current) => (current === target.index ? null : current))}
            />
          ))}
        {visiblePills.map((pill) => (
          <g
            key={`pill-${pill.index}`}
            className={`venue-demand-curve__tooltip ${pill.mine ? 'venue-demand-curve__tooltip--inverse' : 'venue-demand-curve__tooltip--surface'}${pill.hovered ? ' venue-demand-curve__tooltip--hover' : ''}`}
            data-side={pill.side}
            style={{ pointerEvents: 'none' }}
          >
            <rect
              x={pill.x}
              y={pill.y}
              width={pill.width}
              height={pill.height}
              rx="5"
              fill={pill.mine ? 'var(--color-accent)' : 'var(--color-surface)'}
              stroke={pill.mine ? 'var(--color-accent-border)' : 'var(--color-line)'}
            />
            {pill.rows.map((row, rowIndex) => {
              const baseline = pill.y + pill.firstBaseline + rowIndex * pill.lineHeight;
              if (row.value === null) {
                return (
                  <text
                    key={row.label}
                    className={
                      rowIndex === 0 ? 'venue-demand-curve__tooltip-title' : 'venue-demand-curve__tooltip-subtitle'
                    }
                    x={pill.x + (pill.width - (rowIndex === 0 ? pill.titleExtra : 0)) / 2}
                    y={baseline}
                    textAnchor="middle"
                  >
                    {row.label}
                  </text>
                );
              }
              return (
                <g key={row.label}>
                  <text
                    className="venue-demand-curve__tooltip-label"
                    x={pill.x + DETAIL_PAD_X}
                    y={baseline}
                    textAnchor="start"
                  >
                    {row.label}
                  </text>
                  <text
                    className="venue-demand-curve__tooltip-value"
                    x={pill.x + pill.width - DETAIL_PAD_X}
                    y={baseline}
                    textAnchor="end"
                  >
                    {row.value}
                  </text>
                </g>
              );
            })}
            {pill.rows[1]?.value !== undefined && pill.rows[1]?.value !== null && (
              <line
                className="venue-demand-curve__tooltip-rule"
                x1={pill.x + DETAIL_PAD_X}
                x2={pill.x + pill.width - DETAIL_PAD_X}
                y1={pill.y + pill.firstBaseline + 7}
                y2={pill.y + pill.firstBaseline + 7}
              />
            )}
            {pill.explorerHref !== null && (
              <a
                className="venue-demand-curve__explorer"
                href={pill.explorerHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ pointerEvents: 'auto' }}
                onMouseEnter={() => onHoverSegment(pill.index)}
              >
                <title>Open this bid's reveal transaction in the explorer</title>
                <ExternalLink
                  x={
                    pill.x +
                    (pill.width - pill.titleExtra) / 2 +
                    labelWidth(pill.rows[0]?.label ?? '', 15, 0) / 2 +
                    EXPLORER_ICON_GAP
                  }
                  y={pill.y + pill.firstBaseline - 12}
                  width={EXPLORER_ICON_SIZE}
                  height={EXPLORER_ICON_SIZE}
                  aria-hidden="true"
                />
              </a>
            )}
          </g>
        ))}
        {lostPill !== null && (
          <g
            className="venue-demand-curve__tooltip venue-demand-curve__tooltip--inverse"
            style={{ pointerEvents: 'none' }}
          >
            <rect
              x={lostPill.x}
              y={lostPill.y}
              width={lostPill.width}
              height={lostPill.height}
              rx="5"
              fill="var(--color-danger)"
            />
            <text
              className="venue-demand-curve__tooltip-title"
              x={lostPill.x + lostPill.width / 2}
              y={lostPill.y + TOOLTIP_TITLE_Y}
              textAnchor="middle"
            >
              Your bid
            </text>
            <text
              className="venue-demand-curve__tooltip-subtitle"
              x={lostPill.x + lostPill.width / 2}
              y={lostPill.y + TOOLTIP_SUBTITLE_Y}
              textAnchor="middle"
            >
              Not filled
            </text>
          </g>
        )}
        <line x1={PAD_LEFT} x2={PAD_LEFT + plotWidth} y1={baseY} y2={baseY} className="venue-demand-curve__baseline" />
        {[0, 0.5, 1].map((fraction, index) => {
          const quantity = Math.round(fraction * maxQuantity);
          return (
            <text
              key={fraction}
              x={x(quantity)}
              y={baseY + 17}
              textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'}
              className="venue-demand-curve__quantity-tick"
            >
              {index === 2 ? `${quantity} ${intexUnit(quantity)}` : quantity}
            </text>
          );
        })}
        <text x="6" y="16" textAnchor="start" className="venue-demand-curve__axis-title">
          % Strike
        </text>
      </svg>
      <div className="venue-demand-legend">
        {hasFilled && (
          <span>
            <i style={{ background: 'var(--color-accent-soft)', border: '1px solid var(--color-accent-border)' }} />
            Filled At Clearing
          </span>
        )}
        {hasRefund && (
          <span>
            <i
              style={{
                background:
                  'repeating-linear-gradient(45deg, var(--color-accent-soft) 0 5px, var(--color-surface) 5px 10px)',
                border: '1px solid var(--color-accent-border)',
              }}
            />
            Above Clearing · Refunded
          </span>
        )}
        {clearingY !== null && (
          <span>
            <i className="venue-demand-legend__clearing" />
            Clearing Rate (you pay)
          </span>
        )}
        <span>
          <i className="venue-demand-legend__curve" />
          Demand Curve (all bids)
        </span>
        {mine?.won !== null && mine && mine.won > 0 && (
          <span>
            <i style={{ background: 'var(--color-accent)', border: '1px solid var(--color-accent)' }} />
            Your Bid
          </span>
        )}
        {mine?.won === 0 && (
          <span>
            <i
              style={{
                background:
                  'repeating-linear-gradient(45deg, var(--color-danger-soft) 0 5px, var(--color-surface) 5px 10px)',
                border: '1px solid var(--color-danger)',
              }}
            />
            Your Bid · Not Filled
          </span>
        )}
      </div>
      {outcome?.bidder && !mine && clearingY !== null && (
        <p style={{ margin: '10px 0 0', textAlign: 'right', color: 'var(--color-subtle)', fontSize: 15 }}>
          No revealed bid from this wallet
        </p>
      )}
    </>
  );
}
