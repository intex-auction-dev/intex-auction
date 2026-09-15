/**
 * One storage availability probe.
 *
 * Storage can be present but unwritable — Safari private browsing, a full quota, or a
 * blocked-cookie policy all surface as a throw on `setItem` rather than a missing API.
 * A write-back-and-read check is the only reliable test, and getting it wrong is a
 * bid-persistence risk: AGENTS.md requires reveal material to be written and read back
 * before a commit is broadcast.
 *
 * This module owns only the mechanics. Failure *policy* stays with each caller, because
 * the correct response genuinely differs: the commit path must abort, the recovery
 * history falls back to a session-only store with a warning, and the log caches simply
 * go without a cache.
 */

export interface ProbeTarget {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Writes, reads back and removes a unique key, reporting why it failed rather than throwing. */
export const probeStorage = (storage: ProbeTarget): StorageProbe => {
  const key = `itx-acn:storage-probe:${Date.now()}:${Math.random()}`;
  try {
    storage.setItem(key, '1');
    if (storage.getItem(key) !== '1') throw new Error('Storage probe was not readable.');
    storage.removeItem(key);
    return { ok: true };
  } catch (error) {
    try {
      storage.removeItem(key);
    } catch {
      // Probe cleanup is best-effort; the failure below is what matters.
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

/** `localStorage` when it exists and is usable, otherwise null. Never throws. */
export const browserStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

/**
 * `localStorage` proven writable, or a reason it is not. Callers decide what to do with
 * a failure; this never falls back silently.
 */
export const availableStorage = ():
  | { readonly ok: true; readonly storage: Storage }
  | { readonly ok: false; readonly reason: string } => {
  const storage = browserStorage();
  if (storage === null) return { ok: false, reason: 'Browser storage is unavailable.' };
  const probe = probeStorage(storage);
  return probe.ok ? { ok: true, storage } : { ok: false, reason: probe.reason };
};
