import { describe, expect, it } from 'vitest';
import {
  decodeIntexLifecycle,
  decodeIntexTokenStatus,
  deriveBidderEconomics,
  deriveRecipientDelivery,
  deriveSeriesProvisioning,
  isTargetSeriesExpired,
  targetAuctionResult,
} from '@/domain/completion-domain';

describe('Phase 10 completion domain', () => {
  it('keeps result, provisioning and no-sale terminal state independent', () => {
    expect(targetAuctionResult('completed', 0)).toBe('no-sale');
    expect(deriveSeriesProvisioning('no-sale', 0)).toBe('not-applicable-no-sale');
    expect(targetAuctionResult('completed', 2)).toBe('sale');
    expect(deriveSeriesProvisioning('sale', 0)).toBe('awaiting-series');
    expect(deriveSeriesProvisioning('sale', 2)).toBe('provisioned');
  });

  it('decodes reviewed lifecycle and token tags and rejects unknown tags', () => {
    expect([0, 1, 2].map(decodeIntexLifecycle)).toEqual(['issued', 'qualified', 'called']);
    expect([0, 1].map(decodeIntexTokenStatus)).toEqual(['issued', 'settled']);
    expect(() => decodeIntexLifecycle(3)).toThrow('unsupported tag');
    expect(() => decodeIntexTokenStatus(2)).toThrow('unsupported tag');
  });

  it('derives expiry only strictly after the Called deadline', () => {
    const input = { lifecycle: 'called' as const, calledAt: 100n, intexCallPeriod: 20n };
    expect(isTargetSeriesExpired({ ...input, latestBlockTimestamp: 120n })).toBe(false);
    expect(isTargetSeriesExpired({ ...input, latestBlockTimestamp: 121n })).toBe(true);
    expect(isTargetSeriesExpired({ ...input, lifecycle: 'qualified', latestBlockTimestamp: 999n })).toBe(false);
  });

  it('derives exact normal economics only from finalized lock and delivered allocation evidence', () => {
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 1n,
        promisLoadMinor: 1_000n,
        clearingRate: 600_000n,
        issuanceInstructionsReceived: true,
        deliveryDeferred: false,
        deliveryObserved: true,
      }),
    ).toEqual({
      kind: 'finalized',
      lockedAmount: 1_000n,
      paidAmount: 600n,
      refundedAmount: 400n,
      burnedAmount: 0n,
      wonCount: 1n,
      source: 'normal-finalization',
    });
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 1n,
        promisLoadMinor: 1_000n,
        clearingRate: 600_000n,
        issuanceInstructionsReceived: true,
        deliveryDeferred: true,
        deliveryObserved: false,
      }).kind,
    ).toBe('unknown');
  });

  it('does not infer a loss from zero balance or zero won-count alone', () => {
    expect(
      deriveRecipientDelivery({
        result: 'sale',
        seriesProvisioned: true,
        issuanceInstructionsReceived: true,
        deferred: false,
        deliveredEvent: false,
        wonCount: 0n,
        bidderEconomics: null,
      }),
    ).toBe('unknown');
  });

  it('marks a loser only when normal finalization proves a full refund', () => {
    const economics = deriveBidderEconomics({
      lockedAmount: 1_000n,
      lockStatus: 'finalized',
      wonCount: 0n,
      promisLoadMinor: 1_000n,
      clearingRate: 600_000n,
      issuanceInstructionsReceived: true,
      deliveryDeferred: false,
      deliveryObserved: false,
    });
    expect(
      deriveRecipientDelivery({
        result: 'sale',
        seriesProvisioned: true,
        issuanceInstructionsReceived: true,
        deferred: false,
        deliveredEvent: false,
        wonCount: 0n,
        bidderEconomics: economics,
      }),
    ).toBe('not-a-winner');
  });

  it('labels exact retried amounts as recovery economics with the paid residual burned', () => {
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 2n,
        promisLoadMinor: 1_000n,
        clearingRate: 600_000n,
        issuanceInstructionsReceived: true,
        deliveryDeferred: false,
        deliveryObserved: true,
        exactRefundedAmount: 400n,
        exactPaidAmount: 600n,
      }),
    ).toEqual({
      kind: 'finalized',
      lockedAmount: 1_000n,
      paidAmount: 0n,
      refundedAmount: 400n,
      burnedAmount: 600n,
      wonCount: 2n,
      source: 'recovery',
    });
  });

  it('resolves a retried full-refund bidder to not-a-winner from recovery economics', () => {
    const economics = deriveBidderEconomics({
      lockedAmount: 800n,
      lockStatus: 'finalized',
      wonCount: 0n,
      promisLoadMinor: 1_000n,
      clearingRate: 600_000n,
      issuanceInstructionsReceived: true,
      deliveryDeferred: false,
      deliveryObserved: false,
      exactRefundedAmount: 800n,
      exactPaidAmount: 0n,
    });
    expect(economics).toEqual({
      kind: 'finalized',
      lockedAmount: 800n,
      paidAmount: 0n,
      refundedAmount: 800n,
      burnedAmount: 0n,
      wonCount: 0n,
      source: 'recovery',
    });
    expect(
      deriveRecipientDelivery({
        result: 'sale',
        seriesProvisioned: true,
        issuanceInstructionsReceived: true,
        deferred: false,
        deliveredEvent: false,
        wonCount: 0n,
        bidderEconomics: economics,
      }),
    ).toBe('not-a-winner');
  });

  it('requires recovery economics to exactly partition the bidder lock', () => {
    expect(() =>
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 0n,
        promisLoadMinor: 1_000n,
        clearingRate: 600_000n,
        issuanceInstructionsReceived: true,
        deliveryDeferred: false,
        deliveryObserved: false,
        recoveredAmount: 300n,
        burnedAmount: 400n,
      }),
    ).toThrow('must exactly partition the bidder lock');
  });

  it('derives a full refund for a no-sale without fabricating issuance evidence', () => {
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 0n,
        promisLoadMinor: 1_000n,
        clearingRate: 0n,
        issuanceInstructionsReceived: false,
        deliveryDeferred: false,
        deliveryObserved: false,
        noSale: true,
      }),
    ).toEqual({
      kind: 'finalized',
      lockedAmount: 1_000n,
      paidAmount: 0n,
      refundedAmount: 1_000n,
      burnedAmount: 0n,
      wonCount: 0n,
      source: 'normal-finalization',
    });
  });

  it('keeps a still-locked bidder pending even under a no-sale result', () => {
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'locked',
        wonCount: 0n,
        promisLoadMinor: 1_000n,
        clearingRate: 0n,
        issuanceInstructionsReceived: false,
        deliveryDeferred: false,
        deliveryObserved: false,
        noSale: true,
      }),
    ).toEqual({ kind: 'pending', lockedAmount: 1_000n });
  });

  it('lets exact recovery evidence win over the no-sale full-refund default', () => {
    expect(
      deriveBidderEconomics({
        lockedAmount: 1_000n,
        lockStatus: 'finalized',
        wonCount: 2n,
        promisLoadMinor: 1_000n,
        clearingRate: 0n,
        issuanceInstructionsReceived: false,
        deliveryDeferred: false,
        deliveryObserved: false,
        noSale: true,
        exactRefundedAmount: 400n,
        exactPaidAmount: 600n,
      }),
    ).toEqual({
      kind: 'finalized',
      lockedAmount: 1_000n,
      paidAmount: 0n,
      refundedAmount: 400n,
      burnedAmount: 600n,
      wonCount: 2n,
      source: 'recovery',
    });
  });
});
