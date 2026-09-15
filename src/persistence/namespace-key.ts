/**
 * The single rule for naming browser-local records.
 *
 * AGENTS.md requires bid records, settings, caches and history cursors to be namespaced
 * by chain, deployment and wallet as applicable. That rule was previously re-implemented
 * per subsystem and had drifted: one site left the deployment id unencoded and kept the
 * checksummed casing of the contract address, so two subsystems disagreed about what the
 * same deployment was called.
 *
 * Everything here is a pure string derivation so it can be pinned by tests: the reveal
 * material key in particular must stay byte-identical forever, because reveal material is
 * the one record that cannot be rebuilt from chain logs.
 */

export interface StorageNamespace {
  /** Stable record family, e.g. `itx-acn:venue-log`. Must not end in a separator. */
  readonly prefix: string;
  /** Record schema version. Bumping it orphans older records by design. */
  readonly version: number;
  readonly chainId: number;
  readonly deploymentId: string;
  /** Contract this record belongs to; lower-cased so casing never forks a namespace. */
  readonly contract?: string;
  /** Owning wallet, where the record is bidder-scoped. */
  readonly wallet?: string;
  /** Further scalar discriminators, appended in order (e.g. event family, WorldwideDay). */
  readonly segments?: readonly (string | number)[];
}

/**
 * `encodeURIComponent` on the deployment id is what keeps a configured id containing a
 * separator from silently merging two namespaces. Deployment ids come from
 * operator-edited JSON and are not pattern-validated, so this is a trust boundary.
 */
export const namespaceKey = (namespace: StorageNamespace): string => {
  const parts: (string | number)[] = [
    namespace.prefix,
    `v${namespace.version}`,
    namespace.chainId,
    encodeURIComponent(namespace.deploymentId),
  ];
  if (namespace.contract !== undefined) parts.push(namespace.contract.toLowerCase());
  if (namespace.wallet !== undefined) parts.push(namespace.wallet.toLowerCase());
  for (const segment of namespace.segments ?? []) parts.push(segment);
  return parts.join(':');
};

/** True when `key` belongs to `prefix` but not to `version` — i.e. an orphaned record. */
export const isSupersededKey = (key: string, prefix: string, version: number): boolean =>
  key.startsWith(`${prefix}:v`) && !key.startsWith(`${prefix}:v${version}:`);

export interface EnumerableStorage {
  readonly length?: number;
  key?(index: number): string | null;
  removeItem(key: string): void;
}

/**
 * Drops records left behind by an earlier schema version.
 */
export const pruneSupersededRecords = (storage: EnumerableStorage | null, prefix: string, version: number): void => {
  if (storage === null || storage.key === undefined || storage.length === undefined) return;
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && isSupersededKey(key, prefix, version)) stale.push(key);
  }
  for (const key of stale) {
    try {
      storage.removeItem(key);
    } catch {
      // Cache hygiene is best-effort and must never block a read path.
    }
  }
};
