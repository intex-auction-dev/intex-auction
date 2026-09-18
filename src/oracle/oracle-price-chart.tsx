import { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import uPlot, { type AlignedData, type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { Card, Icon, ViewToggle } from '../ui/primitives';
import { FlowingNumberText, flowingNumberTextParts } from '../ui/flowing-number-text';
import {
  formatOracleRate,
  formatPrice,
  ORACLE_RATE_SCALE,
  type OracleChartLevel,
  type OracleChartModel,
  type OracleChartPoint,
} from './oracle-chart-model';
import './oracle-price-chart.css';

interface OraclePriceChartProps {
  model: OracleChartModel;
  quoteDenomination: string;
}

const ranges = [
  { value: '1d', label: '1D', seconds: 86_400 },
  { value: '1w', label: '1W', seconds: 604_800 },
  { value: '1m', label: '1M', seconds: 2_592_000 },
  { value: '3m', label: '3M', seconds: 7_776_000 },
  { value: '1y', label: '1Y', seconds: 31_536_000 },
  { value: 'all', label: 'ALL', seconds: Number.POSITIVE_INFINITY },
] as const;

export const CHART_CALL_ANCHOR_HEADROOM = 64;
const CHART_HEIGHT = 260;

const chartColor = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const pointsForRange = (points: readonly OracleChartPoint[], range: string): readonly OracleChartPoint[] => {
  const config = ranges.find((item) => item.value === range) ?? ranges[1];
  const latest = points.at(-1);
  if (!latest || !Number.isFinite(config.seconds)) return points;
  const threshold = latest.time - config.seconds;
  const filtered = points.filter((point) => point.time >= threshold);
  return filtered.length > 1 ? filtered : points.slice(-Math.min(2, points.length));
};

export const toAlignedChartData = (points: readonly OracleChartPoint[]): AlignedData => [
  points.map((point) => point.time),
  points.map((point) => point.value),
];

export const chartYRange = (
  points: readonly OracleChartPoint[],
  levels: readonly OracleChartLevel[],
): [number, number] => {
  const values = [...points.map((point) => point.value), ...levels.map((level) => level.value)].filter(Number.isFinite);
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const padding = span > 0 ? span * 0.06 : Math.max(Math.abs(min) * 0.06, 1e-6);
  return [min - padding, max + padding];
};

export const chartYRanges = (
  points: readonly OracleChartPoint[],
  levels: readonly OracleChartLevel[],
): { defaultRange: [number, number]; fullRange: [number, number] } => ({
  defaultRange: chartYRange(
    points,
    levels.filter((level) => level.label !== 'Call'),
  ),
  fullRange: chartYRange(points, levels),
});

export const chartYRangeWithHeadroom = (
  range: readonly [number, number],
  edge: 'above' | 'below' | null,
  headroomPixels: number,
  plotHeight: number,
): [number, number] => {
  if (!edge || headroomPixels <= 0 || plotHeight <= headroomPixels) return [range[0], range[1]];
  const span = range[1] - range[0];
  const headroom = (span * headroomPixels) / (plotHeight - headroomPixels);
  return edge === 'above' ? [range[0], range[1] + headroom] : [range[0] - headroom, range[1]];
};

export const chartYRangeAtZoom = (
  defaultRange: readonly [number, number],
  fullRange: readonly [number, number],
  progress: number,
): [number, number] => {
  const clamped = Math.max(0, Math.min(1, progress));
  return [
    defaultRange[0] + (fullRange[0] - defaultRange[0]) * clamped,
    defaultRange[1] + (fullRange[1] - defaultRange[1]) * clamped,
  ];
};

export const chartYPannedRange = (
  baseRange: readonly [number, number],
  fullRange: readonly [number, number],
  offset: number,
): [number, number] => {
  const baseSpan = baseRange[1] - baseRange[0];
  const fullSpan = fullRange[1] - fullRange[0];
  if (baseSpan >= fullSpan) return [fullRange[0], fullRange[1]];
  const minOffset = fullRange[0] - baseRange[0];
  const maxOffset = fullRange[1] - baseRange[1];
  const clamped = Math.max(minOffset, Math.min(maxOffset, offset));
  return [baseRange[0] + clamped, baseRange[1] + clamped];
};

export const chartYPanDelta = (deltaPixels: number, plotHeight: number, span: number): number =>
  plotHeight > 0 ? (deltaPixels / plotHeight) * span * 2 : 0;

export const chartLevelLabelTops = (
  lineYs: readonly number[],
  plotTop: number,
  plotBottom: number,
  labelHeight: number,
  gap: number,
): number[] => {
  if (lineYs.length === 0) return [];
  const maxTop = Math.max(plotTop, plotBottom - labelHeight);
  const separation = labelHeight + gap;
  const placed = lineYs
    .map((lineY, index) => ({
      index,
      naturalTop: Math.max(plotTop, Math.min(maxTop, lineY - labelHeight / 2)),
      top: 0,
    }))
    .sort((a, b) => a.naturalTop - b.naturalTop);

  let start = 0;
  let previousTop: number | null = null;
  while (start < placed.length) {
    const first = placed[start];
    if (!first) break;
    let end = start;
    let groupTop = first.naturalTop;
    while (true) {
      const count = end - start + 1;
      const span = separation * (count - 1);
      const mean = placed.slice(start, end + 1).reduce((sum, item) => sum + item.naturalTop, 0) / count;
      const lower = previousTop === null ? plotTop : previousTop + separation;
      const upper = Math.max(lower, maxTop - span);
      groupTop = Math.max(lower, Math.min(upper, mean - span / 2));
      const next = placed[end + 1];
      if (end + 1 >= placed.length || !next || next.naturalTop >= groupTop + span + separation) break;
      end += 1;
    }
    for (let index = start; index <= end; index += 1) {
      const item = placed[index];
      if (item) item.top = groupTop + separation * (index - start);
    }
    const endItem = placed[end];
    previousTop = endItem ? endItem.top : null;
    start = end + 1;
  }

  const result = Array<number>(lineYs.length);
  for (const item of placed) result[item.index] = item.top;
  return result;
};

export interface ChartPriceMarkerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const chartPriceMarkerRect = (
  pointX: number,
  pointY: number,
  plotTop: number,
  plotBottom: number,
  plotLeft: number,
  plotRight: number,
  labelWidth: number,
  labelHeight: number,
  inset: number,
  offsetAbove: number,
): ChartPriceMarkerRect => {
  const centerY = Math.max(
    plotTop + labelHeight / 2,
    Math.min(plotBottom - labelHeight / 2, pointY - offsetAbove - labelHeight / 2),
  );
  const centerX = Math.max(plotLeft + labelWidth / 2 + inset, Math.min(plotRight - labelWidth / 2 - inset, pointX));
  return {
    x: centerX - labelWidth / 2,
    y: centerY - labelHeight / 2,
    width: labelWidth,
    height: labelHeight,
  };
};

export const chartCallLabelTop = (
  naturalTop: number,
  marker: Pick<ChartPriceMarkerRect, 'y'> | null,
  plotTop: number,
  labelHeight: number,
  gap: number,
): number => {
  if (!marker) return naturalTop;
  return Math.max(plotTop, Math.min(naturalTop, marker.y - labelHeight - gap));
};

const pricePrefix = (denomination: string): string => (denomination === 'USD' ? '$' : '');

const ORACLE_THREE_DECIMALS = ORACLE_RATE_SCALE / 1_000n;

const toThreeDecimalRate = (value: bigint): bigint =>
  ((value + ORACLE_THREE_DECIMALS / 2n) / ORACLE_THREE_DECIMALS) * ORACLE_THREE_DECIMALS;

const formatChartNumber = (value: number): string => value.toFixed(3).replace(/\.?0+$/, '');

export const priceFlowParts = flowingNumberTextParts;

interface FlowingPriceProps {
  rawRate: bigint;
  prefix: string;
}

function FlowingPrice({ rawRate, prefix }: FlowingPriceProps) {
  const previousRateRef = useRef(rawRate);
  const value = formatOracleRate(toThreeDecimalRate(rawRate));
  const direction: 1 | -1 = rawRate >= previousRateRef.current ? 1 : -1;
  useEffect(() => {
    previousRateRef.current = rawRate;
  }, [rawRate]);

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: deferred FlowingNumberText accessible-name work
    <strong data-number-flow="coen-price" aria-label={`${prefix}${value}`} style={{ display: 'inline-flex' }}>
      <FlowingNumberText value={`${prefix}${value}`} direction={direction} />
    </strong>
  );
}

export function OraclePriceChart({ model, quoteDenomination }: OraclePriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef({ range: '1w', zoomProgress: 0, panOffset: 0 });
  const highlightedIndexRef = useRef<number | null>(null);
  const chartRef = useRef<uPlot | null>(null);
  const visiblePointsRef = useRef<readonly OracleChartPoint[]>([]);
  const [range, setRange] = useState('1w');
  const visiblePoints = useMemo(() => pointsForRange(model.points, range), [model.points, range]);
  useEffect(() => {
    visiblePointsRef.current = visiblePoints;
  }, [visiblePoints]);
  const changeRange = (nextRange: string) => {
    viewportRef.current = { range: nextRange, zoomProgress: 0, panOffset: 0 };
    setRange(nextRange);
    highlightedIndexRef.current = null;
  };
  const setHighlightedIndex = (index: number | null) => {
    highlightedIndexRef.current = index;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: chart rebuild is structural-only
  useEffect(() => {
    const container = containerRef.current;
    if (!container || visiblePoints.length === 0) return undefined;
    const foreground = chartColor('--color-foreground', '#18181b');
    const muted = chartColor('--color-muted', '#71717a');
    const line = chartColor('--color-line', 'rgba(9,9,11,.11)');
    const accent = chartColor('--color-accent', '#2563eb');
    const surface = chartColor('--color-surface', '#ffffff');
    const rangesForChart = chartYRanges(visiblePoints, model.levels);
    const callLevel = model.levels.find((level) => level.label === 'Call') ?? null;
    const defaultRange = chartYRangeWithHeadroom(
      rangesForChart.defaultRange,
      callLevel ? 'above' : null,
      CHART_CALL_ANCHOR_HEADROOM,
      CHART_HEIGHT,
    );
    const fullRange = chartYRangeWithHeadroom(
      rangesForChart.fullRange,
      callLevel ? 'above' : null,
      CHART_CALL_ANCHOR_HEADROOM,
      CHART_HEIGHT,
    );
    const hasExtraRange = fullRange[0] !== defaultRange[0] || fullRange[1] !== defaultRange[1];
    const savedViewport =
      viewportRef.current.range === range ? viewportRef.current : { range, zoomProgress: 0, panOffset: 0 };
    let callAnchor: HTMLButtonElement | null = null;
    let zoomProgress = hasExtraRange ? savedViewport.zoomProgress : 0;
    let panOffset = hasExtraRange ? savedViewport.panOffset : 0;
    let dragState: { pointerId: number; startY: number; startOffset: number; span: number } | null = null;

    const MARKER_EASE_MS = 140;
    let markerAnim: {
      start: number;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
    } | null = null;
    let markerAnimRaf: number | null = null;
    let lastDrawnX: number | null = null;
    let lastDrawnY: number | null = null;
    let currentPriceRect: ChartPriceMarkerRect | null = null;

    const updateCallAnchor = (plot: uPlot) => {
      if (!callAnchor || !callLevel) return;
      const yScale = plot.scales.y;
      if (!yScale) return;
      const yMin = yScale.min;
      const yMax = yScale.max;
      if (yMin === undefined || yMax === undefined || (callLevel.value >= yMin && callLevel.value <= yMax)) {
        callAnchor.hidden = true;
        return;
      }
      const above = callLevel.value > yMax;
      const formatted = `${pricePrefix(quoteDenomination)}${formatPrice(callLevel.rawValue)}`;
      callAnchor.hidden = false;
      callAnchor.textContent = `${above ? '↑' : '↓'} Call ${formatted}`;
      callAnchor.setAttribute('aria-label', `Show Call at ${formatted}`);
      callAnchor.style.top = above ? '6px' : '';
      callAnchor.style.bottom = above ? '' : '6px';
    };

    const drawLevels = (plot: uPlot) => {
      const { ctx, bbox } = plot;
      const ratio = uPlot.pxRatio;
      const labelHeight = 24 * ratio;
      const labelGap = 4 * ratio;
      const labelPaddingX = 7 * ratio;
      const labelInset = 6 * ratio;
      const labelRadius = 6 * ratio;
      const yScale = plot.scales.y;
      if (!yScale) return;
      const yMin = yScale.min ?? defaultRange[0];
      const yMax = yScale.max ?? defaultRange[1];
      const visibleLevels = model.levels.filter((level) => level.value >= yMin && level.value <= yMax);
      const levelYs = visibleLevels.map((level) => plot.valToPos(level.value, 'y', true));
      const labelTops = chartLevelLabelTops(levelYs, bbox.top, bbox.top + bbox.height, labelHeight, labelGap);

      ctx.save();
      ctx.font = `${15 * ratio}px Geist, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = ratio;

      for (const y of levelYs) {
        ctx.strokeStyle = foreground;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(bbox.left, y);
        ctx.lineTo(bbox.left + bbox.width, y);
        ctx.stroke();
      }

      visibleLevels.forEach((level, index) => {
        const textWidth = ctx.measureText(level.label).width;
        const labelWidth = textWidth + labelPaddingX * 2;
        const x = bbox.left + bbox.width - labelWidth - labelInset;
        const naturalTop = labelTops[index] ?? bbox.top;
        const top =
          level.label === 'Call'
            ? chartCallLabelTop(naturalTop, currentPriceRect, bbox.top, labelHeight, labelGap)
            : naturalTop;

        ctx.setLineDash([]);
        ctx.fillStyle = surface;
        ctx.strokeStyle = line;
        ctx.beginPath();
        ctx.roundRect(x, top, labelWidth, labelHeight, labelRadius);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = foreground;
        ctx.fillText(level.label, x + labelPaddingX, top + labelHeight / 2);
      });
      ctx.restore();
      updateCallAnchor(plot);
    };

    const drawCurrentPrice = (plot: uPlot) => {
      currentPriceRect = null;
      const pointIndex =
        highlightedIndexRef.current !== null ? highlightedIndexRef.current : visiblePointsRef.current.length - 1;
      const targetPoint = visiblePointsRef.current[pointIndex];
      if (!targetPoint) return;
      const { ctx, bbox } = plot;
      const ratio = uPlot.pxRatio;
      const labelHeight = 22 * ratio;
      const labelRadius = 6 * ratio;
      const labelPaddingX = 8 * ratio;
      const labelInset = 4 * ratio;
      const offsetAbove = 10 * ratio;
      const text = `${pricePrefix(quoteDenomination)}${formatOracleRate(toThreeDecimalRate(targetPoint.rawRate))}`;

      const targetX = plot.valToPos(targetPoint.time, 'x', true);
      const targetY = plot.valToPos(targetPoint.value, 'y', true);

      let drawX: number;
      let drawY: number;
      if (markerAnim) {
        const progress = Math.min(1, (performance.now() - markerAnim.start) / MARKER_EASE_MS);
        const eased = 1 - (1 - progress) ** 3;
        drawX = markerAnim.fromX + (markerAnim.toX - markerAnim.fromX) * eased;
        drawY = markerAnim.fromY + (markerAnim.toY - markerAnim.fromY) * eased;
        if (progress >= 1) markerAnim = null;
      } else if (lastDrawnX !== null && lastDrawnY !== null && (targetX !== lastDrawnX || targetY !== lastDrawnY)) {
        const fromX = lastDrawnX;
        const fromY = lastDrawnY;
        markerAnim = {
          start: performance.now(),
          fromX,
          fromY,
          toX: targetX,
          toY: targetY,
        };
        drawX = fromX;
        drawY = fromY;
      } else {
        drawX = targetX;
        drawY = targetY;
      }
      lastDrawnX = drawX;
      lastDrawnY = drawY;

      ctx.save();
      ctx.font = `600 ${15 * ratio}px Geist, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      const labelWidth = ctx.measureText(text).width + labelPaddingX * 2;
      const rect = chartPriceMarkerRect(
        drawX,
        drawY,
        bbox.top,
        bbox.top + bbox.height,
        bbox.left,
        bbox.left + bbox.width,
        labelWidth,
        labelHeight,
        labelInset,
        offsetAbove,
      );
      currentPriceRect = rect;
      ctx.fillStyle = chartColor('--color-accent', '#2563eb');
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, labelRadius);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, rect.x + labelPaddingX, rect.y + labelHeight / 2);
      ctx.restore();
    };

    const options: Options = {
      width: Math.max(container.clientWidth, 1),
      height: CHART_HEIGHT,
      padding: [8, 0, 0, 0],
      cursor: { drag: { x: false, y: false }, focus: { prox: 24 } },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: false, range: () => defaultRange },
      },
      axes: [
        { stroke: muted, grid: { show: false }, ticks: { stroke: line }, font: '15px Geist, system-ui, sans-serif' },
        {
          side: 1,
          stroke: foreground,
          grid: { stroke: line, dash: [3, 3] },
          ticks: { show: false },
          font: '15px Geist, system-ui, sans-serif',
          values: (_: uPlot, splits: number[]) => splits.map((split) => formatChartNumber(split)),
        },
      ],
      series: [
        {},
        {
          stroke: accent,
          width: 2,
          fill: 'rgba(37, 99, 235, 0.12)',
          points: { show: false },
          paths: (uPlot.paths.spline ?? uPlot.paths.linear)!({ alignGaps: 0 }),
        },
      ],
      hooks: { draw: [drawCurrentPrice, drawLevels] },
    };
    const chart = new uPlot(options, toAlignedChartData(visiblePoints), container);
    chartRef.current = chart;

    const setViewport = (nextProgress: number, nextOffset = panOffset) => {
      zoomProgress = Math.max(0, Math.min(1, nextProgress));
      const baseRange = chartYRangeAtZoom(defaultRange, fullRange, zoomProgress);
      const [min, max] = chartYPannedRange(baseRange, fullRange, nextOffset);
      panOffset = min - baseRange[0];
      viewportRef.current = { range, zoomProgress, panOffset };
      chart.setScale('y', { min, max });
    };
    setViewport(zoomProgress, panOffset);

    const isRightYAxisEvent = (event: MouseEvent | WheelEvent) => {
      const rootRect = chart.root.getBoundingClientRect();
      const x = event.clientX - rootRect.left;
      const plotRight = (chart.bbox.left + chart.bbox.width) / uPlot.pxRatio;
      return x >= plotRight && x <= rootRect.width;
    };

    const onWheel = (event: WheelEvent) => {
      if (!hasExtraRange || !isRightYAxisEvent(event) || event.deltaY === 0) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? chart.height
            : 1;
      const delta = Math.max(-0.12, Math.min(0.12, event.deltaY * unit * 0.0015));
      const next = Math.max(0, Math.min(1, zoomProgress + delta));
      if (next === zoomProgress) return;
      event.preventDefault();
      setViewport(next);
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (!hasExtraRange || !isRightYAxisEvent(event)) return;
      event.preventDefault();
      setViewport(0, 0);
    };

    const cancelDrag = () => {
      const pointerId = dragState?.pointerId;
      if (pointerId === undefined) return;
      dragState = null;
      chart.over.style.cursor = hasExtraRange ? 'grab' : '';
      if (chart.over.hasPointerCapture(pointerId)) chart.over.releasePointerCapture(pointerId);
    };

    const finishDrag = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      cancelDrag();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!hasExtraRange || event.button !== 0 || event.target === callAnchor) return;
      const yScale = chart.scales.y;
      if (!yScale) return;
      const yMin = yScale.min;
      const yMax = yScale.max;
      if (yMin === undefined || yMax === undefined) return;
      event.preventDefault();
      dragState = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startOffset: panOffset,
        span: yMax - yMin,
      };
      chart.over.setPointerCapture(event.pointerId);
      chart.over.style.cursor = 'grabbing';
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if ((event.buttons & 1) === 0) {
        cancelDrag();
        return;
      }
      const plotHeight = chart.bbox.height / uPlot.pxRatio;
      const deltaValue = chartYPanDelta(event.clientY - dragState.startY, plotHeight, dragState.span);
      setViewport(zoomProgress, dragState.startOffset + deltaValue);
    };

    const findClosestPointIndex = (clientX: number): number | null => {
      const pts = visiblePointsRef.current;
      if (pts.length === 0) return null;
      const rootRect = chart.root.getBoundingClientRect();
      const x = clientX - rootRect.left;
      const plotLeft = chart.bbox.left / uPlot.pxRatio;
      const plotRight = (chart.bbox.left + chart.bbox.width) / uPlot.pxRatio;
      if (x < plotLeft || x > plotRight) return null;
      const xScale = chart.scales.x;
      if (!xScale) return null;
      const timeValue = chart.posToVal(x, 'x');
      if (timeValue === null) return null;
      let closestIndex = 0;
      let minDiff = Math.abs(pts[0]!.time - timeValue);
      for (let i = 1; i < pts.length; i++) {
        const diff = Math.abs(pts[i]!.time - timeValue);
        if (diff < minDiff) {
          minDiff = diff;
          closestIndex = i;
        }
      }
      return closestIndex;
    };

    const startMarkerLoop = () => {
      if (markerAnimRaf !== null) return;
      const tick = () => {
        if (markerAnim) {
          markerAnimRaf = requestAnimationFrame(tick);
        } else {
          markerAnimRaf = null;
        }
        chart.redraw();
      };
      markerAnimRaf = requestAnimationFrame(tick);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (dragState) return;
      const index = findClosestPointIndex(event.clientX);
      setHighlightedIndex(index);
      chart.redraw();
      startMarkerLoop();
    };

    const onMouseLeave = () => {
      if (dragState) return;
      setHighlightedIndex(null);
      markerAnim = null;
      if (markerAnimRaf !== null) cancelAnimationFrame(markerAnimRaf);
      markerAnimRaf = null;
      lastDrawnX = null;
      lastDrawnY = null;
      chart.redraw();
    };

    if (callLevel) {
      callAnchor = document.createElement('button');
      callAnchor.type = 'button';
      callAnchor.title =
        'Drag the chart vertically toward Call. Click to fit Call. Scroll the price axis to zoom; double-click the axis to reset.';
      Object.assign(callAnchor.style, {
        position: 'absolute',
        right: '6px',
        zIndex: '3',
        padding: '3px 7px',
        border: `1px solid ${line}`,
        borderRadius: '6px',
        background: surface,
        color: foreground,
        font: '15px Geist, system-ui, sans-serif',
        lineHeight: '1.2',
        cursor: 'pointer',
      });
      callAnchor.addEventListener('click', () => setViewport(1, 0));
      chart.over.append(callAnchor);
      updateCallAnchor(chart);
    }

    if (hasExtraRange) {
      chart.over.style.cursor = 'grab';
      chart.over.style.touchAction = 'none';
      chart.over.style.userSelect = 'none';
    }
    chart.root.addEventListener('wheel', onWheel, { passive: false });
    chart.root.addEventListener('dblclick', onDoubleClick);
    chart.over.addEventListener('pointerdown', onPointerDown);
    chart.over.addEventListener('pointermove', onPointerMove);
    chart.over.addEventListener('lostpointercapture', finishDrag);
    chart.over.addEventListener('mousemove', onMouseMove);
    chart.over.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', finishDrag, true);
    window.addEventListener('blur', cancelDrag);

    let width = container.clientWidth;
    const resize = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? 0);
      if (nextWidth > 0 && nextWidth !== width) {
        width = nextWidth;
        chart.setSize({ width, height: CHART_HEIGHT });
      }
    });
    resize.observe(container);
    return () => {
      resize.disconnect();
      cancelDrag();
      chart.root.removeEventListener('wheel', onWheel);
      chart.root.removeEventListener('dblclick', onDoubleClick);
      chart.over.removeEventListener('pointerdown', onPointerDown);
      chart.over.removeEventListener('pointermove', onPointerMove);
      chart.over.removeEventListener('lostpointercapture', finishDrag);
      chart.over.removeEventListener('mousemove', onMouseMove);
      chart.over.removeEventListener('mouseleave', onMouseLeave);
      if (markerAnimRaf !== null) cancelAnimationFrame(markerAnimRaf);
      markerAnimRaf = null;
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', finishDrag, true);
      window.removeEventListener('blur', cancelDrag);
      callAnchor?.remove();
      chart.destroy();
      chartRef.current = null;
    };
  }, [model.levels, model.pair.quote, quoteDenomination, range]);

  useEffect(() => {
    if (chartRef.current && visiblePoints.length > 0) {
      chartRef.current.setData(toAlignedChartData(visiblePoints));
    }
  }, [visiblePoints]);

  const latest = visiblePoints.at(-1) ?? model.latest;
  const first = visiblePoints[0] ?? null;
  const entry = model.levels.find((level) => level.label === 'Entry') ?? null;
  const basis = entry?.value ?? first?.value ?? null;
  const change = latest && basis ? ((latest.value - basis) / basis) * 100 : null;
  const up = (change ?? 0) >= 0;
  const suffix = entry ? (up ? 'above entry' : 'below entry') : range === 'all' ? 'retained' : range.toUpperCase();

  return (
    <Card className="oracle-card" aria-labelledby="oracle-chart-title">
      <div className="oracle-card__header">
        <div>
          <span className="auction-section-label" id="oracle-chart-title">
            COEN Price
          </span>
          <div className="oracle-card__price-line">
            {latest ? (
              <FlowingPrice rawRate={latest.rawRate} prefix={pricePrefix(quoteDenomination)} />
            ) : (
              <strong>No price history</strong>
            )}
            {change !== null && (
              <span className={up ? 'price-change price-change--up' : 'price-change price-change--down'}>
                <Icon icon={up ? TrendingUp : TrendingDown} size={15} />
                {change >= 0 ? '+' : ''}
                {change.toFixed(1)}% {suffix}
              </span>
            )}
          </div>
        </div>
        <ViewToggle value={range} items={ranges} onChange={changeRange} label="Price time range" />
      </div>
      {model.points.length > 0 ? (
        <>
          <p className="visually-hidden">
            COEN price history from recorded price snapshots. {model.retainedCount} points available. The plotted line
            is snapshot prices, not the frozen auction entry price shown by the Entry marker.
          </p>
          <div ref={containerRef} className="oracle-chart" data-chart-library="uplot" />
        </>
      ) : (
        <p className="product-empty-state">COEN price history is unavailable.</p>
      )}
    </Card>
  );
}
