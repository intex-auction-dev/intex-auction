import { afterEach, describe, expect, it } from 'vitest';
import { getScheduleTimeZone, getScheduleTimeZoneChoice, setScheduleTimeZone } from '@/domain/display-timezone';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('schedule timezone preference', () => {
  it('stores UTC and removes the override for browser-local time', () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(getScheduleTimeZone()).toBeUndefined();
    expect(getScheduleTimeZoneChoice()).toBe('local');
    setScheduleTimeZone('UTC');
    expect(getScheduleTimeZone()).toBe('UTC');
    expect(getScheduleTimeZoneChoice()).toBe('UTC');
    setScheduleTimeZone('local');
    expect(getScheduleTimeZone()).toBeUndefined();
  });

  it('stores and retrieves arbitrary IANA timezone identifiers', () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    setScheduleTimeZone('America/New_York');
    expect(getScheduleTimeZone()).toBe('America/New_York');
    expect(getScheduleTimeZoneChoice()).toBe('America/New_York');

    setScheduleTimeZone('Asia/Tokyo');
    expect(getScheduleTimeZone()).toBe('Asia/Tokyo');
    expect(getScheduleTimeZoneChoice()).toBe('Asia/Tokyo');

    setScheduleTimeZone('local');
    expect(getScheduleTimeZone()).toBeUndefined();
    expect(getScheduleTimeZoneChoice()).toBe('local');
  });
});
