import { describe, expect, it } from 'vitest';
import { evaluateBrowserSupport } from '@/app/runtime-gates';

describe('browser capability gate', () => {
  it('accepts the required browser capabilities', () => {
    const result = evaluateBrowserSupport({
      fetch: () => undefined,
      AbortController: class {},
      BigInt: () => 1n,
      TextEncoder: class {},
      WebAssembly: {},
      crypto: { subtle: {} },
    });

    expect(result).toEqual({ supported: true, missingCapabilities: [] });
  });

  it('reports every missing capability', () => {
    const result = evaluateBrowserSupport({});

    expect(result.supported).toBe(false);
    expect(result.missingCapabilities).toEqual([
      'Fetch API',
      'AbortController',
      'BigInt',
      'TextEncoder',
      'WebAssembly',
      'Web Crypto',
    ]);
  });
});
