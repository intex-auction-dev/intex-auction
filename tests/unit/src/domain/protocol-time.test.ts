import { describe, expect, it } from 'vitest';
import {
  buildTwoMonthWorldwideDayGrid,
  CALENDAR_WINDOW_DAYS,
  calendarWorldwideDayWindow,
  compareWorldwideDays,
  contiguousWorldwideDayWindow,
  currentWorldwideDay,
  inclusiveWorldwideDayRange,
  parseWorldwideDayKey,
  shiftWorldwideDay,
  toDurationSeconds,
  toUtcTimestamp,
  worldwideDayComponents,
  worldwideDayMonth,
  type WorldwideDayKey,
} from '@/domain/protocol-time';

const day = (raw: string): WorldwideDayKey => {
  const parsed = parseWorldwideDayKey(raw);
  if (!parsed.ok) throw new Error(`Bad test WWD ${raw}`);
  return parsed.value;
};

describe('protocol time domains', () => {
  it('parses valid worldwide-day keys and rejects malformed/impossible dates', () => {
    expect(parseWorldwideDayKey('20260804')).toEqual({ ok: true, value: '20260804' });
    expect(parseWorldwideDayKey('2026-08-04')).toEqual({ ok: false, reason: 'format' });
    expect(parseWorldwideDayKey('20260229')).toEqual({ ok: false, reason: 'calendar-date' });
    expect(parseWorldwideDayKey('20240229')).toEqual({ ok: true, value: '20240229' });
  });

  it('keeps branded UTC timestamps and durations inside uint64', () => {
    expect(toUtcTimestamp(42n)).toBe(42n);
    expect(toDurationSeconds((1n << 64n) - 1n)).toBe((1n << 64n) - 1n);
    expect(() => toUtcTimestamp(-1n)).toThrow('must fit uint64');
    expect(() => toDurationSeconds(1n << 64n)).toThrow('must fit uint64');
  });

  it('moves across month, year and leap-year boundaries with UTC arithmetic', () => {
    expect(shiftWorldwideDay(day('20261231'), 1)).toBe('20270101');
    expect(shiftWorldwideDay(day('20270101'), -1)).toBe('20261231');
    expect(shiftWorldwideDay(day('20240228'), 1)).toBe('20240229');
    expect(shiftWorldwideDay(day('20240229'), 1)).toBe('20240301');
    expect(worldwideDayComponents(day('20240229'))).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it('generates inclusive ranges and exactly 90 unique contiguous WWD keys', () => {
    expect(inclusiveWorldwideDayRange(day('20261230'), day('20270102'))).toEqual([
      '20261230',
      '20261231',
      '20270101',
      '20270102',
    ]);
    const window = contiguousWorldwideDayWindow(day('20260701'), 90);
    expect(window).toHaveLength(90);
    expect(new Set(window).size).toBe(90);
    window.slice(1).forEach((value, index) => {
      expect(value).toBe(shiftWorldwideDay(window[index]!, 1));
      expect(compareWorldwideDays(window[index]!, value)).toBe(-1);
    });
  });

  it('uses UTC+14 rollover while ordinary UTC remains on the prior date', () => {
    const now = Date.parse('2026-08-03T10:30:00Z');
    expect(new Date(now).getUTCDate()).toBe(3);
    expect(currentWorldwideDay(now)).toBe('20260804');
  });

  it('builds two six-week grids and one covering 90-day load window', () => {
    const month = worldwideDayMonth(day('20260804'));
    const grid = buildTwoMonthWorldwideDayGrid(month);
    expect(grid.first.cells).toHaveLength(42);
    expect(grid.second.cells).toHaveLength(42);
    expect(grid.first.cells.some((cell) => cell.worldwideDay === '20260804' && cell.inMonth)).toBe(true);
    const window = calendarWorldwideDayWindow(month);
    expect(CALENDAR_WINDOW_DAYS).toBe(90);
    expect(window).toHaveLength(CALENDAR_WINDOW_DAYS);
    expect(window[0]).toBe(grid.visibleStart);
    expect(window.includes(grid.visibleEnd)).toBe(true);
  });
});
