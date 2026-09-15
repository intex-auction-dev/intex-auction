declare const worldwideDayBrand: unique symbol;
declare const utcTimestampBrand: unique symbol;
declare const durationSecondsBrand: unique symbol;
declare const utcAccountingDayBrand: unique symbol;

export type WorldwideDayKey = string & { readonly [worldwideDayBrand]: true };
export type UtcTimestamp = bigint & { readonly [utcTimestampBrand]: true };
export type DurationSeconds = bigint & { readonly [durationSecondsBrand]: true };
export type UtcAccountingDay = number & { readonly [utcAccountingDayBrand]: true };

export interface WorldwideDayComponents {
  year: number;
  month: number;
  day: number;
}

export interface WorldwideDayMonth {
  year: number;
  month: number;
}

export interface WorldwideDayCalendarCell {
  worldwideDay: WorldwideDayKey;
  day: number;
  inMonth: boolean;
}

export interface WorldwideDayCalendarMonth extends WorldwideDayMonth {
  cells: readonly WorldwideDayCalendarCell[];
}

export interface TwoMonthWorldwideDayGrid {
  first: WorldwideDayCalendarMonth;
  second: WorldwideDayCalendarMonth;
  visibleStart: WorldwideDayKey;
  visibleEnd: WorldwideDayKey;
}

export type WorldwideDayParseResult =
  | { ok: true; value: WorldwideDayKey }
  | { ok: false; reason: 'format' | 'calendar-date' };

const UINT64_MAX = (1n << 64n) - 1n;
const WORLDWIDE_DAY_PATTERN = /^\d{8}$/;
const UTC_PLUS_14_MS = 14 * 60 * 60 * 1000;
const CELLS_PER_MONTH_GRID = 42;

export const CALENDAR_WINDOW_DAYS = 90;

const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const isCalendarDate = (raw: string): boolean => {
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));

  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

const requireUint64 = (value: bigint, label: string): bigint => {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(`${label} must fit uint64.`);
  }
  return value;
};

const componentsToKey = ({ year, month, day }: WorldwideDayComponents): WorldwideDayKey => {
  const raw = `${year.toString().padStart(4, '0')}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
  const parsed = parseWorldwideDayKey(raw);
  if (!parsed.ok) throw new RangeError('WorldwideDay components must form a valid YYYYMMDD date.');
  return parsed.value;
};

const utcDateFromComponents = ({ year, month, day }: WorldwideDayComponents): Date => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const componentsFromUtcDate = (date: Date): WorldwideDayComponents => ({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
  day: date.getUTCDate(),
});

export const parseWorldwideDayKey = (raw: string): WorldwideDayParseResult => {
  if (!WORLDWIDE_DAY_PATTERN.test(raw)) return { ok: false, reason: 'format' };
  if (!isCalendarDate(raw)) return { ok: false, reason: 'calendar-date' };
  return { ok: true, value: raw as WorldwideDayKey };
};

export const worldwideDayComponents = (worldwideDay: WorldwideDayKey): WorldwideDayComponents => ({
  year: Number(worldwideDay.slice(0, 4)),
  month: Number(worldwideDay.slice(4, 6)),
  day: Number(worldwideDay.slice(6, 8)),
});

export const worldwideDayMonth = (worldwideDay: WorldwideDayKey): WorldwideDayMonth => {
  const { year, month } = worldwideDayComponents(worldwideDay);
  return { year, month };
};

export const shiftWorldwideDay = (worldwideDay: WorldwideDayKey, offsetDays: number): WorldwideDayKey => {
  if (!Number.isSafeInteger(offsetDays)) throw new RangeError('WorldwideDay offset must be a safe integer.');
  const date = utcDateFromComponents(worldwideDayComponents(worldwideDay));
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return componentsToKey(componentsFromUtcDate(date));
};

export const shiftWorldwideDayMonth = (value: WorldwideDayMonth, offsetMonths: number): WorldwideDayMonth => {
  if (!Number.isSafeInteger(offsetMonths)) throw new RangeError('Month offset must be a safe integer.');
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1 + offsetMonths, 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
};

export const compareWorldwideDays = (left: WorldwideDayKey, right: WorldwideDayKey): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const inclusiveWorldwideDayRange = (
  start: WorldwideDayKey,
  end: WorldwideDayKey,
): readonly WorldwideDayKey[] => {
  if (compareWorldwideDays(start, end) > 0) {
    throw new RangeError('WorldwideDay range start must not be after its end.');
  }
  const result: WorldwideDayKey[] = [];
  for (let day = start; compareWorldwideDays(day, end) <= 0; day = shiftWorldwideDay(day, 1)) {
    result.push(day);
  }
  return result;
};

export const contiguousWorldwideDayWindow = (start: WorldwideDayKey, count: number): readonly WorldwideDayKey[] => {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError('WorldwideDay window count must be a positive safe integer.');
  }
  return Array.from({ length: count }, (_, index) => shiftWorldwideDay(start, index));
};

export const currentWorldwideDay = (nowMilliseconds = Date.now()): WorldwideDayKey => {
  if (!Number.isFinite(nowMilliseconds)) throw new RangeError('Current time must be finite milliseconds.');
  const protocolDate = new Date(nowMilliseconds + UTC_PLUS_14_MS);
  return componentsToKey(componentsFromUtcDate(protocolDate));
};

export const buildWorldwideDayMonthGrid = (value: WorldwideDayMonth): WorldwideDayCalendarMonth => {
  const firstDay = componentsToKey({ ...value, day: 1 });
  const weekday = utcDateFromComponents(worldwideDayComponents(firstDay)).getUTCDay();
  const gridStart = shiftWorldwideDay(firstDay, -weekday);
  const cells = contiguousWorldwideDayWindow(gridStart, CELLS_PER_MONTH_GRID).map((worldwideDay) => {
    const components = worldwideDayComponents(worldwideDay);
    return {
      worldwideDay,
      day: components.day,
      inMonth: components.year === value.year && components.month === value.month,
    };
  });
  return { ...value, cells };
};

export const buildTwoMonthWorldwideDayGrid = (firstMonth: WorldwideDayMonth): TwoMonthWorldwideDayGrid => {
  const first = buildWorldwideDayMonthGrid(firstMonth);
  const second = buildWorldwideDayMonthGrid(shiftWorldwideDayMonth(firstMonth, 1));
  const visibleStart = first.cells[0]?.worldwideDay;
  const visibleEnd = second.cells[second.cells.length - 1]?.worldwideDay;
  if (!visibleStart || !visibleEnd) throw new Error('Calendar grid generation failed.');
  return { first, second, visibleStart, visibleEnd };
};

export const calendarWorldwideDayWindow = (firstMonth: WorldwideDayMonth): readonly WorldwideDayKey[] => {
  const grid = buildTwoMonthWorldwideDayGrid(firstMonth);
  const visibleLength = inclusiveWorldwideDayRange(grid.visibleStart, grid.visibleEnd).length;
  if (visibleLength > CALENDAR_WINDOW_DAYS)
    throw new RangeError('Two-month calendar grid exceeds the reviewed 90-day window.');
  return contiguousWorldwideDayWindow(grid.visibleStart, CALENDAR_WINDOW_DAYS);
};

export const toUtcTimestamp = (value: bigint): UtcTimestamp => requireUint64(value, 'UTC timestamp') as UtcTimestamp;

export const toDurationSeconds = (value: bigint): DurationSeconds =>
  requireUint64(value, 'Duration') as DurationSeconds;

export const toUtcAccountingDay = (value: number): UtcAccountingDay => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('UTC accounting day must be a safe integer.');
  }

  const raw = value.toString().padStart(8, '0');
  if (!WORLDWIDE_DAY_PATTERN.test(raw) || !isCalendarDate(raw)) {
    throw new RangeError('UTC accounting day must be a valid YYYYMMDD date.');
  }
  return value as UtcAccountingDay;
};
