import { describe, expect, it } from 'vitest';
import {
  BID_RATE_SCALE,
  calculateEscrowLockMinor,
  maxQuantityForEscrowLock,
  UINT128_MAX,
  UINT16_MAX,
} from '@/domain/escrow-lock';

describe('auction escrow lock math', () => {
  it('matches the contract fixed-point calculation', () => {
    expect(
      calculateEscrowLockMinor({
        quantity: 30n,
        promisLoadMinor: 1_000n,
        bidRate: 800_000n,
      }),
    ).toBe(24_000n);
  });

  it('preserves Solidity integer truncation, including zero', () => {
    expect(
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: 1n,
        bidRate: 1n,
      }),
    ).toBe(0n);
  });

  it('accepts the exact uint128 result boundary', () => {
    expect(
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: UINT128_MAX,
        bidRate: BID_RATE_SCALE,
      }),
    ).toBe(UINT128_MAX);
  });

  it('rejects a computed uint128 overflow', () => {
    expect(() =>
      calculateEscrowLockMinor({
        quantity: 2n,
        promisLoadMinor: UINT128_MAX,
        bidRate: BID_RATE_SCALE,
      }),
    ).toThrow('Escrow lock amount exceeds uint128.');
  });

  it('rejects values outside contract input ranges', () => {
    expect(() =>
      calculateEscrowLockMinor({
        quantity: 0n,
        promisLoadMinor: 1n,
        bidRate: 1n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: 1n,
        bidRate: BID_RATE_SCALE + 1n,
      }),
    ).toThrow(RangeError);
  });
});

describe('auction max quantity from escrow lock cap', () => {
  it('returns the exact uint128 boundary quantity at max basis and rate', () => {
    expect(
      maxQuantityForEscrowLock({
        promisLoadMinor: UINT128_MAX,
        bidRate: BID_RATE_SCALE,
      }),
    ).toBe(1n);
  });

  it('returns a lower max for a larger basis at full rate', () => {
    const promisLoadMinor = 10n ** 34n;
    const max = maxQuantityForEscrowLock({ promisLoadMinor, bidRate: BID_RATE_SCALE });
    expect(max).toBeGreaterThan(0n);
    expect(max).toBeLessThan(UINT16_MAX);
    expect((max * promisLoadMinor * BID_RATE_SCALE) / BID_RATE_SCALE).toBeLessThanOrEqual(UINT128_MAX);
    expect(((max + 1n) * promisLoadMinor * BID_RATE_SCALE) / BID_RATE_SCALE).toBeGreaterThan(UINT128_MAX);
  });

  it('caps at the uint16 quantity type bound when the lock allows more', () => {
    expect(
      maxQuantityForEscrowLock({
        promisLoadMinor: 1_000n,
        bidRate: 800_000n,
      }),
    ).toBe(UINT16_MAX);
  });

  it('never caps when the escrow basis is zero', () => {
    expect(
      maxQuantityForEscrowLock({
        promisLoadMinor: 0n,
        bidRate: BID_RATE_SCALE,
      }),
    ).toBe(UINT16_MAX);
  });
});
