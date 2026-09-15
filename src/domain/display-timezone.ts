const STORAGE_KEY = 'itx-acn:schedule-time-zone';

export type ScheduleTimeZone = string;

export const getScheduleTimeZone = (): string | undefined => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!stored || stored === 'local') return undefined;
    return stored;
  } catch {
    return undefined;
  }
};

export const getScheduleTimeZoneChoice = (): ScheduleTimeZone => getScheduleTimeZone() ?? 'local';

export const setScheduleTimeZone = (value: ScheduleTimeZone): void => {
  try {
    if (!value || value === 'local') globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, value);
  } catch {}
};
