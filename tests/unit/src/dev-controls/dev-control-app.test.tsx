import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DevControlView,
  type JsonNumber,
  type LocalStatus,
} from '../../../../dev/local-chain/controls/app/dev-control-app';

const NOW = 2_000_000_000;
const TESTER = '0x0000000000000000000000000000000000000001';

const status = (
  overrides: {
    targetStage?: number | null;
    revealed?: number;
    scenario?: boolean;
    oracleAvailable?: boolean;
    tryRate?: readonly JsonNumber[] | null;
    bondAmount?: string;
    revealedByTester?: boolean;
    bondClaimableAt?: string | null;
    lockAmount?: string;
    lockStatus?: number;
    escrowClaimableAt?: string | null;
  } = {},
): LocalStatus => ({
  chain: { chainId: 31_337, blockNumber: 42, timestamp: NOW },
  scenario: overrides.scenario === false ? null : { name: 'commit-open', worldwideDay: 20260825 },
  tester: {
    address: TESTER,
    native: '10000',
    wcoen: '100000000000000000000',
    allowance: '0',
    commitHash: '0x0',
    revealed: overrides.revealedByTester ?? false,
    commitBond: { amount: overrides.bondAmount ?? '0', lockedAt: NOW - 100 },
    bidLock:
      overrides.lockAmount === undefined
        ? null
        : {
            lockedAmount: overrides.lockAmount,
            lockedAt: NOW - 100,
            status: overrides.lockStatus ?? 1,
            failedRefund: '0',
            splitRecorded: false,
          },
    recoveryClaimableAt: overrides.bondClaimableAt ?? null,
    escrowRecoveryClaimableAt: overrides.escrowClaimableAt ?? null,
  },
  oracle: {
    available: overrides.oracleAvailable ?? true,
    pairs: [840, 949, 978],
    rates: {
      USD: [1_000_000_000_000_000_000n, 42, NOW],
      TRY: overrides.tryRate === undefined ? [15_000_000_000_000_000_000n, 42, NOW] : overrides.tryRate,
      EUR: [920_000_000_000_000_000n, 42, NOW],
    },
  },
  protocol: {
    worldwideDay: [6, 1],
    globalStage: 2,
    targetStage: overrides.targetStage === undefined ? 0 : overrides.targetStage,
    schedule: { commitEnd: NOW + 100, revealEnd: NOW + 200, issuanceEnd: NOW + 300 },
    parameters: {},
    result: { auctionClearingRate: 0, wonBidsCount: 0, issuedIntexCount: 0, issuedIntexLoadedPromis: 0 },
    runningCounts: [2, overrides.revealed ?? 0],
    escrow: [0, 0, 0, false],
    canonicalSeries: null,
    targetSeriesIds: [],
    ownedTokenIds: [],
    ownedBalances: [],
  },
});

const html = (
  value: LocalStatus,
  busy: string | null = null,
  testerAddress = TESTER,
  testerAddressError: string | null = null,
  fundingMessage: string | null = null,
): string =>
  renderToStaticMarkup(
    <DevControlView
      status={value}
      busy={busy}
      error={null}
      fundingMessage={fundingMessage}
      seedCount={20}
      testerAddress={testerAddress}
      testerAddressError={testerAddressError}
      onRefresh={() => undefined}
      onRun={() => undefined}
      onSeedCountChange={() => undefined}
      onTesterAddressChange={() => undefined}
    />,
  );

describe('DevControlView', () => {
  it('keeps fixture replacement controls visible without a loaded auction', () => {
    const markup = html(status({ scenario: false, targetStage: null }));
    expect(markup).toContain('Scenario setup');
    expect(markup).toContain('Reset to Commit Open');
    expect(markup).toContain('dev-control--positive');
    expect(markup).toContain('Seed Past Auctions');
    expect(markup).toContain('Announce Red Day · Cancel Series');
    expect(markup).not.toContain('End Commit Stage');
    expect(markup).not.toContain('Fund wallet');
  });

  it('shows only commit-stage auction and bid actions during commit', () => {
    const markup = html(status({ targetStage: 0 }));
    expect(markup).toContain('Auction lifecycle');
    expect(markup).toContain('End Commit Stage');
    expect(markup).not.toContain('Start Clearing · Move to Issuance');
    expect(markup).not.toContain('Post Auction Result');
    expect(markup).toContain('Submit Bid for Another Bidder');
    expect(markup).toContain('Seed Random Bids');
  });

  it('shows only reveal-stage transition and reveal simulation during reveal', () => {
    const markup = html(status({ targetStage: 1 }));
    expect(markup).toContain('Start Clearing · Move to Issuance');
    expect(markup).not.toContain('End Commit Stage');
    expect(markup).toContain('Reveal Next Seeded Bid');
    expect(markup).toContain('Reveal Seeded Bids');
  });

  it('offers no-sale alone with zero revealed bids and both results with revealed bids', () => {
    const empty = html(status({ targetStage: 2, revealed: 0 }));
    expect(empty).toContain('Post Auction Result (No Sale)');
    expect(empty).not.toContain('Post Auction Result (Sale)');

    const revealed = html(status({ targetStage: 2, revealed: 2 }));
    expect(revealed).toContain('Post Auction Result (Sale)');
    expect(revealed).toContain('Post Auction Result (No Sale)');
  });

  it('hides all inapplicable auction and bid actions after completion or cancellation', () => {
    for (const targetStage of [3, 4]) {
      const markup = html(status({ targetStage }));
      expect(markup).not.toContain('End Commit Stage');
      expect(markup).not.toContain('Start Clearing · Move to Issuance');
      expect(markup).not.toContain('Post Auction Result');
      expect(markup).not.toContain('Seed Random Bids');
      expect(markup).not.toContain('Reveal Seeded Bids');
    }
  });

  it('shows the selected tester address, reset warning, and funding controls in Bidder funds', () => {
    const markup = html(status());
    expect(markup).not.toContain('Preview Clearing Result');
    expect(markup).not.toContain('Preview result');
    expect(markup).toContain('Tester wallet address');
    expect(markup).toContain(`value="${TESTER}"`);
    expect(markup).toContain('Currently inspected address');
    expect(markup).toContain('Resetting or replacing the fixture can erase funding for this wallet');
    expect(markup.indexOf('Fund wallet')).toBeGreaterThan(markup.indexOf('Bidder funds'));
    expect(markup).toContain('never approves EscrowAdapter');
  });

  it('marks malformed tester addresses invalid and disables wallet funding', () => {
    const markup = html(status(), null, 'not-an-address', 'Enter a valid EVM address.');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('Enter a valid EVM address.');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Fund wallet/);
  });

  it('shows funding success as fresh-balance feedback', () => {
    const markup = html(
      status(),
      null,
      TESTER,
      null,
      `Funding completed for ${TESTER}. Balances below are fresh; no EscrowAdapter approval was submitted.`,
    );
    expect(markup).toContain('dev-success');
    expect(markup).toContain('Balances below are fresh');
  });

  it('keeps relevant controls and the tester address disabled while a command runs', () => {
    const markup = html(status({ targetStage: 0 }), 'seed-bids 20');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>End Commit Stage/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Seed Random Bids/);
    expect(markup).toMatch(/<input[^>]*disabled=""[^>]*value="0x0000000000000000000000000000000000000001"/);
  });

  it('shows one overall Oracle availability direction at a time', () => {
    const available = html(status({ oracleAvailable: true }));
    expect(available).toContain('Oracle unavailable');
    expect(available).not.toContain('Oracle available');

    const unavailable = html(status({ oracleAvailable: false, tryRate: null }));
    expect(unavailable).toContain('Oracle available');
    expect(unavailable).not.toContain('Oracle unavailable');
    expect(unavailable).toContain('Oracle reads are unavailable');
  });

  it('reports old and unreadable TRY observations and hides redundant fault actions', () => {
    const old = html(status({ tryRate: [15_000_000_000_000_000_000n, 42, NOW - 7 * 86_400] }));
    expect(old).toContain('TRY observation is 7 days old');
    expect(old).not.toContain('Make TRY observation stale');
    expect(old).toContain('Deactivate TRY pair');

    const unreadable = html(status({ tryRate: null }));
    expect(unreadable).toContain('TRY pair cannot be read');
    expect(unreadable).not.toContain('Increase TRY rate');
    expect(unreadable).not.toContain('Make TRY observation stale');
    expect(unreadable).not.toContain('Deactivate TRY pair');
  });

  it('switches bond recovery from time advance to claim at the contract timestamp', () => {
    const waiting = html(status({ bondAmount: '10', bondClaimableAt: String(NOW + 1) }));
    expect(waiting).toContain('Advance to No-Reveal Bond Claim Time');
    expect(waiting).not.toContain('Claim No-Reveal Commit Bond');

    const claimable = html(status({ bondAmount: '10', bondClaimableAt: String(NOW) }));
    expect(claimable).toContain('Claim No-Reveal Commit Bond');
    expect(claimable).not.toContain('Advance to No-Reveal Bond Claim Time');
  });

  it('switches escrow recovery from time advance to claim and hides resolved locks', () => {
    const waiting = html(status({ lockAmount: '10', escrowClaimableAt: String(NOW + 1) }));
    expect(waiting).toContain('Advance to Escrow Refund Time');
    expect(waiting).not.toContain('Claim Escrow Refund');

    const claimable = html(status({ lockAmount: '10', escrowClaimableAt: String(NOW) }));
    expect(claimable).toContain('Claim Escrow Refund');
    expect(claimable).not.toContain('Advance to Escrow Refund Time');

    const resolved = html(status({ lockAmount: '10', lockStatus: 2, escrowClaimableAt: String(NOW) }));
    expect(resolved).not.toContain('Claim Escrow Refund');
  });
});
