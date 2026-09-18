import { describe, expect, it } from 'vitest';
import {
  effectiveMinimumBidQuantity,
  effectiveMinimumBidRate,
  formatContractBidRatePercent,
  parseBidRatePercent,
  paymentAmountInputToBidRatePercent,
  paymentAmountToBidRatePercent,
  validateCommitBidInput,
} from '@/domain/commit-domain';
import { NATIVE_UNITS_PER_PROTOCOL_UNIT } from '@/domain/protocol-constants';

const constraints = {
  minQuantity: 2,
  minBidRate: 500_000,
  promisLoadMinor: 1_000n,
};

describe('commit bid input', () => {
  it('derives effective UI minimums from delivered contract floors and strict non-zero bid rules', () => {
    expect(effectiveMinimumBidQuantity(0)).toBe(1);
    expect(effectiveMinimumBidQuantity(12)).toBe(12);
    expect(effectiveMinimumBidRate(0)).toBe(1);
    expect(effectiveMinimumBidRate(75_000)).toBe(75_000);
  });

  it('converts fixed-decimal percentages to exact contract integers', () => {
    expect(parseBidRatePercent('50')).toBe(500_000);
    expect(parseBidRatePercent('50.125')).toBe(501_250);
    expect(parseBidRatePercent('100.0000')).toBe(1_000_000);
    expect(formatContractBidRatePercent(501_250)).toBe('50.125%');
    expect(validateCommitBidInput({ quantity: '3', bidRatePercent: '75.25', constraints })).toEqual({
      quantity: 3,
      bidRate: 752_500,
      // (3 * 1000 * 752500 / 1e6) * 1e12 = 2257 * 1e12
      revealLockMinor: 2_257n * NATIVE_UNITS_PER_PROTOCOL_UNIT,
    });
  });

  // paymentMinor is native-18 WCOEN; promisLoadMinor is a 1e6 protocol basis. The rate now divides the
  // payment by 1e12 to share the 1e6 scale. lock per unit at rate r, basis b = (b*r/1e6)*1e12, so a
  // payment of P native-18 implies rate = ceil(P/1e12 * 1e6 / b).
  it('maps typed payment-token amounts back to exact contract bid rates at the native-18 scale', () => {
    // basis 100_000 (1e6). 5% -> per-unit lock = (100_000*50_000/1e6)*1e12 = 5_000 * 1e12 = 5e15 native
    // = 0.005 WCOEN.
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0.005',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5');
    // 5.5% -> 5_500 * 1e12 = 5.5e15 native = 0.0055 WCOEN.
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0.0055',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5.5');
    // zero snaps up to the delivered minimum (5%).
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5');
    // Zero-decimal payment token, tiny basis: a payment of 4e12 native (=4 protocol-6) at basis 3
    // implies >100% and is now rejected rather than clamped.
    expect(() =>
      paymentAmountInputToBidRatePercent({
        value: '4000000000000',
        paymentTokenDecimals: 0,
        promisLoadMinor: 3n,
        minimumBidRate: 1,
      }),
    ).toThrow('above 100%');
  });

  it('rejects a payment input implying an over-100% rate instead of clamping to the maximum escrow', () => {
    // basis 100_000. 100% -> per-unit lock = 100_000 * 1e12 = 1e17 native = 0.1 WCOEN. 0.2 is 200%.
    expect(() =>
      paymentAmountToBidRatePercent({
        value: '0.2',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toThrow('above 100%');
    // Exactly 100% is accepted (boundary), not rejected.
    expect(
      paymentAmountToBidRatePercent({
        value: '0.1',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('100');
  });

  it('rejects quantity below the delivered minimum', () => {
    expect(() => validateCommitBidInput({ quantity: '1', bidRatePercent: '50', constraints })).toThrow('at least 2');
  });

  it('maps payment amounts to raw bid rates without snapping below the minimum', () => {
    // basis 100_000. 0.1% -> per-unit lock = (100_000*1000/1e6)*1e12 = 100 * 1e12 = 1e14 native = 0.0001 WCOEN.
    expect(
      paymentAmountToBidRatePercent({
        value: '0.0001',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('0.1');
    // Sub-1e12-native dust divides down to zero protocol-6 and maps to 0 (no snap-up here).
    expect(
      paymentAmountToBidRatePercent({
        value: '0.000000000000000001',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('0');
    expect(
      paymentAmountToBidRatePercent({
        value: '0',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('0');
    // 0.1 WCOEN at basis 100_000 is exactly 100%.
    expect(
      paymentAmountToBidRatePercent({
        value: '0.1',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('100');
  });

  it('rejects rates below the delivered minimum and above 100%', () => {
    expect(() => validateCommitBidInput({ quantity: '2', bidRatePercent: '49.9999', constraints })).toThrow(
      'at least 50%',
    );
    expect(() => parseBidRatePercent('100.0001')).toThrow('no more than 100%');
    expect(() => parseBidRatePercent('50.00001')).toThrow('at most four decimal places');
  });

  it('rejects a zero reveal lock', () => {
    expect(() =>
      validateCommitBidInput({
        quantity: '1',
        bidRatePercent: '0.0001',
        constraints: { minQuantity: 1, minBidRate: 1, promisLoadMinor: 1n },
      }),
    ).toThrow('truncates to zero');
  });

  it('rejects reveal-lock overflow', () => {
    expect(() =>
      validateCommitBidInput({
        quantity: '65535',
        bidRatePercent: '100',
        constraints: { minQuantity: 1, minBidRate: 1, promisLoadMinor: (1n << 128n) - 1n },
      }),
    ).toThrow('Escrow lock amount');
  });
});
