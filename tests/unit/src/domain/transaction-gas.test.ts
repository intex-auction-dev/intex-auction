import { describe, expect, it } from 'vitest';
import { bufferedGasLimit } from '@/domain/transaction-gas';

describe('transaction gas buffer', () => {
  it('applies a 120% safety buffer to the preflighted estimate', () => {
    expect(bufferedGasLimit(100_000n)).toBe(120_000n);
    expect(bufferedGasLimit(40_000n)).toBe(48_000n);
  });

  it('never drops below the estimate for tiny values', () => {
    expect(bufferedGasLimit(1n)).toBe(2n);
  });

  it('rejects a non-positive estimate', () => {
    expect(() => bufferedGasLimit(0n)).toThrow(TypeError);
    expect(() => bufferedGasLimit(-1n)).toThrow(TypeError);
  });
});
