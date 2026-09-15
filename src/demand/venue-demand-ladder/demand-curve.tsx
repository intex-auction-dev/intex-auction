import { useEffect, useRef, useState } from 'react';
import { explorerLink } from '../explorer-links';
import {
  buildDisplaySegments,
  buildLadderBidDetail,
  ladderDetailText,
  type VenueDemandModel,
  type VenueLadderOutcome,
} from '../venue-demand-model';
import { CHART_WIDTH, formatChartPercent, percentOfEscrowBasis, resolveChartWidth } from './chart-geometry';
import { DemandCurveSvg } from './demand-curve-svg';

export function DemandCurve({
  model,
  outcome,
  explorerUrl,
}: {
  model: VenueDemandModel;
  outcome?: VenueLadderOutcome;
  explorerUrl?: string | null;
}) {
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(CHART_WIDTH);
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = chartRef.current;
    if (!node) return undefined;
    const updateWidth = (width: number) => {
      const next = resolveChartWidth(width);
      setChartWidth((current) => (current === next ? current : next));
    };
    updateWidth(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? node.clientWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (model.rows.length === 0) return null;

  const clearingRate = model.authoritativeClearingRate === null ? null : Number(model.authoritativeClearingRate);
  const clearingTitle = clearingRate === null ? null : formatChartPercent(percentOfEscrowBasis(clearingRate));
  const segments = buildDisplaySegments(model.rows, clearingRate, outcome);
  const mine = segments.find((segment) => segment.mine) ?? null;

  return (
    <>
      <div
        className="venue-demand-curve"
        ref={chartRef}
        role="img"
        aria-label={`Revealed demand curve with ${model.rows.length} bids${clearingTitle ? ` and ${clearingTitle} clearing rate` : ''}.`}
      >
        <DemandCurveSvg
          model={model}
          {...(outcome === undefined ? {} : { outcome })}
          explorerUrl={explorerUrl ?? null}
          chartWidth={chartWidth}
          hoveredSegment={hoveredSegment}
          onHoverSegment={setHoveredSegment}
        />
      </div>
      {clearingRate !== null && outcome !== undefined && (
        <p className="venue-demand-curve__note">
          Hover a bid for its detail. Per-bid fills are reconstructed from the delivered clearing rate and venue supply
          {mine && outcome.bidder?.wonCount !== null ? '; your own allocation is read from the contract.' : '.'}
        </p>
      )}
      <ul className="visually-hidden" aria-label="Revealed bid detail">
        {segments.map((segment) => {
          const href = explorerLink(explorerUrl ?? null, 'tx', segment.row.provenance.transactionHash);
          return (
            <li key={`${segment.row.provenance.transactionHash}:${segment.row.provenance.logIndex}`}>
              {ladderDetailText(buildLadderBidDetail(segment, clearingRate))}
              {href !== null && (
                <>
                  {' '}
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    Open reveal transaction in explorer
                  </a>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
