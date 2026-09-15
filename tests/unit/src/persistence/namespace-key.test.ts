import { describe, expect, it } from 'vitest';
import { isSupersededKey, namespaceKey, pruneSupersededRecords } from '@/persistence/namespace-key';
import { probeStorage } from '@/persistence/available-storage';

describe('namespaceKey', () => {
  it('encodes the deployment id so a separator cannot merge two namespaces', () => {
    const sneaky = namespaceKey({
      prefix: 'itx-acn:venue-log',
      version: 2,
      chainId: 56,
      deploymentId: 'a:b',
      contract: '0xAbC',
    });
    const distinct = namespaceKey({
      prefix: 'itx-acn:venue-log',
      version: 2,
      chainId: 56,
      deploymentId: 'a',
      contract: '0xAbC',
    });
    expect(sneaky).toContain('a%3Ab');
    expect(sneaky).not.toEqual(distinct);
  });

  it('lower-cases contract and wallet so address casing never forks a namespace', () => {
    const checksummed = namespaceKey({
      prefix: 'p',
      version: 1,
      chainId: 1,
      deploymentId: 'd',
      contract: '0xAAAABBBB',
      wallet: '0xCCCCDDDD',
    });
    expect(checksummed).toBe('p:v1:1:d:0xaaaabbbb:0xccccdddd');
  });

  it('appends segments in order after the identity parts', () => {
    expect(
      namespaceKey({
        prefix: 'p',
        version: 3,
        chainId: 97,
        deploymentId: 'd',
        contract: '0xa',
        segments: ['BidRevealed', 20260101],
      }),
    ).toBe('p:v3:97:d:0xa:BidRevealed:20260101');
  });

  it('treats a different version of the same prefix as superseded', () => {
    expect(isSupersededKey('itx-acn:venue-log:v1:56:d:0xa', 'itx-acn:venue-log', 2)).toBe(true);
    expect(isSupersededKey('itx-acn:venue-log:v2:56:d:0xa', 'itx-acn:venue-log', 2)).toBe(false);
    expect(isSupersededKey('itx-acn:other:v1:56', 'itx-acn:venue-log', 2)).toBe(false);
  });

  it('prunes superseded records and leaves current and foreign ones', () => {
    const entries = new Map([
      ['itx-acn:venue-log:v1:56:d:0xa', 'stale'],
      ['itx-acn:venue-log:v2:56:d:0xa', 'current'],
      ['itx-acn:reveal-material:v1:56:d', 'foreign'],
    ]);
    const storage = {
      get length() {
        return entries.size;
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      removeItem: (key: string) => {
        entries.delete(key);
      },
    };
    pruneSupersededRecords(storage, 'itx-acn:venue-log', 2);
    expect([...entries.keys()]).toEqual(['itx-acn:venue-log:v2:56:d:0xa', 'itx-acn:reveal-material:v1:56:d']);
  });

  it('is a no-op on storage that cannot enumerate', () => {
    expect(() => pruneSupersededRecords({ removeItem: () => {} }, 'p', 1)).not.toThrow();
    expect(() => pruneSupersededRecords(null, 'p', 1)).not.toThrow();
  });
});

describe('probeStorage', () => {
  it('reports success and leaves no probe key behind', () => {
    const entries = new Map<string, string>();
    const result = probeStorage({
      getItem: (k) => entries.get(k) ?? null,
      setItem: (k, v) => {
        entries.set(k, v);
      },
      removeItem: (k) => {
        entries.delete(k);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(entries.size).toBe(0);
  });

  it('reports the reason when the write throws instead of propagating it', () => {
    const result = probeStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    });
    expect(result).toEqual({ ok: false, reason: 'QuotaExceededError' });
  });

  it('fails when the value does not read back', () => {
    const result = probeStorage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    expect(result.ok).toBe(false);
  });
});
