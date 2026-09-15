const STORAGE_KEY = 'itx-acn:theme';

export type Theme = 'light' | 'dark';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

export const getStoredTheme = (): Theme | undefined => {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const getSystemTheme = (): Theme =>
  typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

export const resolveTheme = (): Theme => getStoredTheme() ?? getSystemTheme();

export const currentTheme = (): Theme =>
  globalThis.document?.documentElement?.classList.contains('dark') ? 'dark' : 'light';

export const applyTheme = (value: Theme): void => {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.toggle('dark', value === 'dark');
};

export const setStoredTheme = (value: Theme): void => {
  try {
    if (value === 'dark') globalThis.localStorage?.setItem(STORAGE_KEY, 'dark');
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {}
};

export const toggleTheme = (): Theme => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  setStoredTheme(next);
  return next;
};
