import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  currentTheme,
  getStoredTheme,
  getSystemTheme,
  resolveTheme,
  setStoredTheme,
  toggleTheme,
} from '@/domain/theme';

class FakeClassList {
  private tokens = new Set<string>();
  contains(token: string) {
    return this.tokens.has(token);
  }
  toggle(token: string, force?: boolean) {
    if (force === undefined) {
      if (this.tokens.has(token)) {
        this.tokens.delete(token);
        return false;
      }
      this.tokens.add(token);
      return true;
    }
    if (force) this.tokens.add(token);
    else this.tokens.delete(token);
    return force;
  }
}

function installStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
}

function installDocument() {
  const classList = new FakeClassList();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { classList } },
  });
  return classList;
}

function installSystemPreference(matches: boolean) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches, media: query }),
  });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).matchMedia;
});

describe('theme preference', () => {
  it('falls back to the system preference when nothing is stored', () => {
    installStorage();
    installSystemPreference(true);
    expect(getStoredTheme()).toBeUndefined();
    expect(getSystemTheme()).toBe('dark');
    expect(resolveTheme()).toBe('dark');

    installSystemPreference(false);
    expect(resolveTheme()).toBe('light');
  });

  it('prefers the stored choice over the system preference', () => {
    installStorage({ 'itx-acn:theme': 'dark' });
    installSystemPreference(false);
    expect(resolveTheme()).toBe('dark');
  });

  it('stores and clears the explicit choice', () => {
    const storage = installStorage();
    setStoredTheme('dark');
    expect(storage.getItem('itx-acn:theme')).toBe('dark');
    setStoredTheme('light');
    expect(storage.getItem('itx-acn:theme')).toBeNull();
  });

  it('ignores corrupt stored values', () => {
    installStorage({ 'itx-acn:theme': 'sepia' });
    installSystemPreference(true);
    expect(getStoredTheme()).toBeUndefined();
    expect(resolveTheme()).toBe('dark');
  });
});

describe('theme application', () => {
  it('toggles the dark class on the document element', () => {
    const classList = installDocument();
    applyTheme('dark');
    expect(classList.contains('dark')).toBe(true);
    applyTheme('light');
    expect(classList.contains('dark')).toBe(false);
  });

  it('reads the active theme from the document', () => {
    const classList = installDocument();
    expect(currentTheme()).toBe('light');
    classList.toggle('dark', true);
    expect(currentTheme()).toBe('dark');
  });

  it('does not crash without a DOM', () => {
    expect(currentTheme()).toBe('light');
    expect(applyTheme('dark')).toBeUndefined();
  });

  it('toggles to the opposite theme and persists it', () => {
    const classList = installDocument();
    const storage = installStorage();
    expect(toggleTheme()).toBe('dark');
    expect(classList.contains('dark')).toBe(true);
    expect(storage.getItem('itx-acn:theme')).toBe('dark');
    expect(toggleTheme()).toBe('light');
    expect(classList.contains('dark')).toBe(false);
    expect(storage.getItem('itx-acn:theme')).toBeNull();
  });
});
