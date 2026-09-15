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
      revealLockMinor: 2_257n,
    });
  });

  it('maps typed payment-token amounts back to exact contract bid rates', () => {
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0.000000000000005',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5');
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0.0000000000000055',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5.5');
    expect(
      paymentAmountInputToBidRatePercent({
        value: '0',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
        minimumBidRate: 50_000,
      }),
    ).toBe('5');
    expect(
      paymentAmountInputToBidRatePercent({
        value: '1',
        paymentTokenDecimals: 0,
        promisLoadMinor: 3n,
        minimumBidRate: 1,
      }),
    ).toBe('33.3334');
  });

  it('rejects quantity below the delivered minimum', () => {
    expect(() => validateCommitBidInput({ quantity: '1', bidRatePercent: '50', constraints })).toThrow('at least 2');
  });

  it('maps payment amounts to raw bid rates without snapping below the minimum', () => {
    expect(
      paymentAmountToBidRatePercent({
        value: '0.000000000000000001',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('0.001');
    expect(
      paymentAmountToBidRatePercent({
        value: '0',
        paymentTokenDecimals: 18,
        promisLoadMinor: 100_000n,
      }),
    ).toBe('0');
    expect(
      paymentAmountToBidRatePercent({
        value: '999',
        paymentTokenDecimals: 0,
        promisLoadMinor: 1n,
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
