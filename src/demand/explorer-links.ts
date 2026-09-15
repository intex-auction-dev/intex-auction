export const explorerLink = (base: string | null, kind: 'tx' | 'address', value: string): string | null => {
  if (base === null) return null;
  try {
    const normalized = base.endsWith('/') ? base : `${base}/`;
    const url = new URL(`${kind}/${value}`, normalized);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};
