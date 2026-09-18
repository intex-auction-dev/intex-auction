import { describe, expect, it } from 'vitest';
import {
  BID_RATE_SCALE,
  calculateEscrowLockMinor,
  maxQuantityForEscrowLock,
  UINT128_MAX,
  UINT16_MAX,
} from '@/domain/escrow-lock';
import { NATIVE_UNITS_PER_PROTOCOL_UNIT } from '@/domain/protocol-constants';

// Chain: IntexAuction.revealBid (IntexAuction.sol:403-405)
//   qty * basis * rate / 1e6 * NATIVE_UNITS_PER_PROTOCOL_UNIT (=1e12)
// Every expected value below carries the 1e12 native-WCOEN conversion the previous scale omitted.
describe('auction escrow lock math', () => {
  it('matches the contract fixed-point calculation (six-decimal result lifted to native-18)', () => {
    // 30 * 1000 * 800000 / 1e6 = 24_000 protocol-6; * 1e12 = native-18.
    expect(
      calculateEscrowLockMinor({
        quantity: 30n,
        promisLoadMinor: 1_000n,
        bidRate: 800_000n,
      }),
    ).toBe(24_000n * NATIVE_UNITS_PER_PROTOCOL_UNIT);
  });

  it('DIVIDES before MULTIPLYING: a qty*basis*rate not divisible by 1e6 truncates before the 1e12 lift', () => {
    // qty*basis*rate = 1 * 1 * 1_500_001 = 1_500_001; 1_500_001 % 1e6 != 0.
    // Correct (divide first): (1_500_001 / 1_000_000) * 1e12 = 1 * 1e12 = 1e12.
    // Flipped (multiply first): (1_500_001 * 1e12) / 1e6 = 1_500_001_000_000 — this MUST NOT be the answer.
    const wrongOrder = (1n * 1n * 1_500_001n * NATIVE_UNITS_PER_PROTOCOL_UNIT) / BID_RATE_SCALE;
    expect(wrongOrder).toBe(1_500_001_000_000n);
    expect(
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: 1n,
        bidRate: 1_500_001n > BID_RATE_SCALE ? BID_RATE_SCALE : 1_500_001n,
      }),
    ).not.toBe(wrongOrder);
    // rate is capped at 1e6, so exercise the truncation with basis instead: basis=1_500_001, rate=1e6.
    // 1 * 1_500_001 * 1e6 / 1e6 = 1_500_001 protocol-6; * 1e12.
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: 1_500_001n, bidRate: BID_RATE_SCALE })).toBe(
      1_500_001n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    );
    // The load-bearing case: product % 1e6 != 0 so the two orders diverge.
    // qty=1, basis=1_000_003, rate=999_999 -> product 1_000_002_999_997.
    // divide-first: 1_000_002 * 1e12; multiply-first: 1_000_002_999_997_000_000_000_000 / 1e6.
    const divideFirst = ((1n * 1_000_003n * 999_999n) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
    const multiplyFirst = (1n * 1_000_003n * 999_999n * NATIVE_UNITS_PER_PROTOCOL_UNIT) / BID_RATE_SCALE;
    expect(divideFirst).not.toBe(multiplyFirst);
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: 1_000_003n, bidRate: 999_999n })).toBe(
      divideFirst,
    );
  });

  it('preserves Solidity integer truncation, including zero', () => {
    // 1 * 1 * 1 / 1e6 = 0 protocol-6; * 1e12 = 0.
    expect(
      calculateEscrowLockMinor({
        quantity: 1n,
        promisLoadMinor: 1n,
        bidRate: 1n,
      }),
    ).toBe(0n);
  });

  it('accepts the exact uint128 result boundary (chain: BNB reverts above, does not saturate)', () => {
    // Largest protocol-6 basis whose native-18 result still fits uint128 at qty=1, rate=1e6.
    const basis = UINT128_MAX / NATIVE_UNITS_PER_PROTOCOL_UNIT;
    expect(calculateEscrowLockMinor({ quantity: 1n, promisLoadMinor: basis, bidRate: BID_RATE_SCALE })).toBe(
      basis * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    );
  });

  it('rejects a computed uint128 overflow at the boundary, matching BNB revert (LockAmountParity.t.sol)', () => {
    // One protocol unit above the boundary reverts on BNB (the target the app simulates), not saturates.
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
    // The cap actually validates through calculateEscrowLockMinor, and the next quantity is rejected.
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
