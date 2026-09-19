import { describe, expect, it } from 'vitest';
import {
  BID_RATE_SCALE,
  calculateEscrowLockMinor,
  maxQuantityForEscrowLock,
  UINT128_MAX,
  UINT16_MAX,
} from '@/domain/escrow-lock';
import { NATIVE_UNITS_PER_PROTOCOL_UNIT } from '@/domain/protocol-constants';

describe('auction escrow lock math', () => {
  it('matches the contract fixed-point calculation (six-decimal result lifted to native-18)', () => {
    expect(
      calculateEscrowLockMinor({
        quantity: 30n,
        promisLoadMinor: 1_000n,
        bidRate: 800_000n,
      }),
    ).toBe(24_000n * NATIVE_UNITS_PER_PROTOCOL_UNIT);
  });

  it('DIVIDES before MULTIPLYING: a qty*basis*rate not divisible by 1e6 truncates before the 1e12 lift', () => {
    const wrongOrder = (1n * 1n * 1_500_001n * NATIVE_UNITS_PER_PROTOCOL_UNIT) / BID_RATE_SCALE;
    expect(wrongOrder).toBe(1_500_001_000_000n);
    expect(
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: 1n,
        bidRate: 1_500_001n > BID_RATE_SCALE ? BID_RATE_SCALE : 1_500_001n,
      }),
    ).not.toBe(wrongOrder);
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: 1_500_001n, bidRate: BID_RATE_SCALE })).toBe(
      1_500_001n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    );
    const divideFirst = ((1n * 1_000_003n * 999_999n) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
    const multiplyFirst = (1n * 1_000_003n * 999_999n * NATIVE_UNITS_PER_PROTOCOL_UNIT) / BID_RATE_SCALE;
    expect(divideFirst).not.toBe(multiplyFirst);
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: 1_000_003n, bidRate: 999_999n })).toBe(
      divideFirst,
    );
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

  it('accepts the exact uint128 result boundary (chain: BNB reverts above, does not saturate)', () => {
    const basis = UINT128_MAX / NATIVE_UNITS_PER_PROTOCOL_UNIT;
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: basis, bidRate: BID_RATE_SCALE })).toBe(
      basis * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    );
  });

  it('rejects a computed uint128 overflow at the boundary, matching BNB revert (LockAmountParity.t.sol)', () => {
    const basis = UINT128_MAX / NATIVE_UNITS_PER_PROTOCOL_UNIT + 1n;
    expect(() => calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: basis, bidRate: BID_RATE_SCALE })).toThrow(
      'Escrow lock amount exceeds uint128.',
    );
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

describe('auction max quantity from escrow lock cap (native-18 ceiling)', () => {
  it('returns exactly 1 at the largest single-unit basis that fits native-18 uint128', () => {
    const basis = UINT128_MAX / NATIVE_UNITS_PER_PROTOCOL_UNIT;
    expect(maxQuantityForEscrowLock({ promisLoadMinor: basis, bidRate: BID_RATE_SCALE })).toBe(1n);
  });

  it('the returned cap fits and the next quantity overflows the real native-18 lock', () => {
    const promisLoadMinor = 10n ** 22n;
    const max = maxQuantityForEscrowLock({ promisLoadMinor, bidRate: BID_RATE_SCALE });
    expect(max).toBeGreaterThan(0n);
    expect(max).toBeLessThan(UINT16_MAX);
    const lockAt = (q: bigint): bigint =>
      ((q * promisLoadMinor * BID_RATE_SCALE) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
    expect(lockAt(max)).toBeLessThanOrEqual(UINT128_MAX);
    expect(lockAt(max + 1n)).toBeGreaterThan(UINT128_MAX);
    expect(() => calculateEscrowLockMinor({ quantity: max, promisLoadMinor, bidRate: BID_RATE_SCALE })).not.toThrow();
    expect(() => calculateEscrowLockMinor({ quantity: max + 1n, promisLoadMinor, bidRate: BID_RATE_SCALE })).toThrow(
      'exceeds uint128',
    );
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
