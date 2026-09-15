export const CHART_WIDTH = 620;
export const CHART_HEIGHT = 288;
export const PAD_LEFT = 58;
export const PAD_RIGHT = 16;
export const PAD_TOP = 42;
export const PAD_BOTTOM = 64;
export const MIN_CHART_WIDTH = PAD_LEFT + PAD_RIGHT + 180;
export const TOOLTIP_HEIGHT = 38;
export const TOOLTIP_TITLE_Y = 15;
export const TOOLTIP_SUBTITLE_Y = 31;
export const TOOLTIP_LINE_HEIGHT = 16;
export const DETAIL_LINE_HEIGHT = 20;
export const DETAIL_FIRST_BASELINE = 17;
export const DETAIL_PAD_BOTTOM = 10;
export const DETAIL_PAD_X = 11;
export const DETAIL_COLUMN_GAP = 20;
export const TOOLTIP_GAP = 7;
export const MIN_HOVER_WIDTH = 8;
export const HOVER_TARGET_OVERHANG = 32;
export const EXPLORER_ICON_SIZE = 15;
export const EXPLORER_ICON_GAP = 6;

export const tooltipHeight = (lineCount: number): number =>
  TOOLTIP_HEIGHT + Math.max(0, lineCount - 2) * TOOLTIP_LINE_HEIGHT;

export const percentOfEscrowBasis = (rate: number): number => rate / 10_000;
export const formatChartPercent = (value: number): string => `${value.toFixed(Number.isInteger(value) ? 0 : 1)}%`;
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));
export const labelWidth = (text: string, fontSize = 15, extra = 14): number =>
  Math.ceil(text.length * fontSize * 0.56 + extra);
export const resolveChartWidth = (width: number): number =>
  Number.isFinite(width) && width > 0 ? Math.max(MIN_CHART_WIDTH, Math.round(width)) : CHART_WIDTH;
