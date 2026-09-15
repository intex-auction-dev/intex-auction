import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuctionRecoveryPanel, formatRecoveryTokenAmount, recoveryEvidenceHasDay } from '@/recovery/recovery-card';
import type {
  RecoveryController,
  RecoveryControllerEvidence,
  RecoveryDisplayRecord,
} from '@/recovery/use-recovery-controller';
import { parseWorldwideDayKey } from '@/domain/protocol-time';

const loaded = (
  overrides: Partial<Extract<RecoveryControllerEvidence, { kind: 'loaded' }>> = {},
): Extract<RecoveryControllerEvidence, { kind: 'loaded' }> => ({
  kind: 'loaded',
  index: {} as Extract<RecoveryControllerEvidence, { kind: 'loaded' }>['index'],
  records: [],
  issues: [],
  storageWarning: null,
  ...overrides,
});

const day = (value: string) => {
  const parsed = parseWorldwideDayKey(value);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
};

const commitBondRecord = (overrides: Partial<RecoveryDisplayRecord> = {}): RecoveryDisplayRecord => ({
  key: 'bond',
  worldwideDay: day('20260804'),
  path: 'auction-commit-bond',
  label: 'Auction commit-bond claim',
  bidder: '0x1111111111111111111111111111111111111111',
  auctionContract: '0x2222222222222222222222222222222222222222',
  escrowContract: '0x3333333333333333333333333333333333333333',
  paymentToken: '0x4444444444444444444444444444444444444444',
  paymentTokenDecimals: 18,
  paymentTokenSymbol: 'wCOEN',
  custody: 'current',
  returnedAmount: 100_000_000n * 10n ** 18n,
  burnedAmount: 0n,
  claimableAt: null,
  latestBlockTimestamp: 1n,
  explanation: 'test',
  status: 'claimable',
  transactionHash: null,
  reconciliationError: null,
  claimableItem: {} as never,
  ...overrides,
});

const controllerWith = (record: RecoveryDisplayRecord): RecoveryController => ({
  evidence: loaded({ records: [record] }),
  busy: false,
  activeItemKey: null,
  failure: null,
  result: null,
  refresh: async () => {},
  claim: async () => {},
});

const escrowRefundRecord = (overrides: Partial<RecoveryDisplayRecord> = {}): RecoveryDisplayRecord => ({
  ...commitBondRecord({ key: 'refund' }),
  path: 'escrow-unfinalized-refund',
  status: 'waiting',
  claimableItem: null,
  ...overrides,
});

describe('recovery action-rail selection', () => {
  it('selects the recovery panel only for records or issues on the viewed auction', () => {
    const record = { worldwideDay: '20260804' } as Extract<
      RecoveryControllerEvidence,
      { kind: 'loaded' }
    >['records'][number];
    const issue = { worldwideDay: '20260805' } as Extract<
      RecoveryControllerEvidence,
      { kind: 'loaded' }
    >['issues'][number];
    const evidence = loaded({ records: [record], issues: [issue] });

    expect(recoveryEvidenceHasDay(evidence, day('20260804'))).toBe(true);
    expect(recoveryEvidenceHasDay(evidence, day('20260805'))).toBe(true);
    expect(recoveryEvidenceHasDay(evidence, day('20260806'))).toBe(false);
    expect(recoveryEvidenceHasDay({ kind: 'loading' }, day('20260804'))).toBe(false);
  });

  it('formats recovery economics with token decimals instead of raw minor units', () => {
    expect(formatRecoveryTokenAmount(100_000_000n * 10n ** 18n, 18, 'wCOEN')).toBe('100,000,000 wCOEN');
    expect(formatRecoveryTokenAmount(123n, null, null)).toBe('123 token minor units');
  });

  it('renders the immediate auction-cancellation claim separately from missed reveal', () => {
    const cancelled = renderToStaticMarkup(
      <AuctionRecoveryPanel controller={controllerWith(commitBondRecord())} worldwideDay={day('20260804')} />,
    );
    expect(cancelled).toContain('Auction cancelled — bond claimable now.');
    expect(cancelled).toContain('100,000,000 wCOEN');
    expect(cancelled).toContain('Claim Bond');
    expect(cancelled).not.toContain('lock period have elapsed');

    const waiting = renderToStaticMarkup(
      <AuctionRecoveryPanel
        controller={controllerWith(
          commitBondRecord({
            status: 'waiting',
            claimableAt: 4_000_000_000n,
            claimableItem: null,
          }),
        )}
        worldwideDay={day('20260804')}
      />,
    );
    expect(waiting).toContain('You committed but did not reveal.');
    expect(waiting).toContain('Bond locked');
    expect(waiting).not.toContain('>Claim Bond<');
  });

  it('keeps a fresh claim actionable while an earlier recovery transaction is unresolved', () => {
    const unresolved = renderToStaticMarkup(
      <AuctionRecoveryPanel
        controller={controllerWith(
          commitBondRecord({
            status: 'submitted',
            transactionHash: `0x${'a'.repeat(64)}`,
            reconciliationError:
              'A previous recovery transaction has an unresolved network result. The controls below reflect fresh contract state.',
            claimableItem: {} as never,
          }),
        )}
        worldwideDay={day('20260804')}
      />,
    );

    expect(unresolved).toContain('notice notice--warning');
    expect(unresolved).toContain('Transaction status unresolved.');
    expect(unresolved).toContain('controls below reflect fresh contract state');
    expect(unresolved).toContain('>Claim Bond<');
  });

  it('shows no immediate-claim claim for a persisted attempt without live state', () => {
    const attempt = renderToStaticMarkup(
      <AuctionRecoveryPanel
        controller={controllerWith(
          commitBondRecord({
            status: 'submitted',
            claimableAt: null,
            claimableItem: null,
          }),
        )}
        worldwideDay={day('20260804')}
      />,
    );
    expect(attempt).not.toContain('Claimable: now');
    expect(attempt).not.toContain('Available immediately');
    expect(attempt).not.toContain('>Claim Bond<');
    expect(attempt).toContain('Claim time unavailable');
  });

  it('hides the claimable-at row for a non-commit-bond attempt without live state', () => {
    const attempt = renderToStaticMarkup(
      <AuctionRecoveryPanel
        controller={controllerWith(
          escrowRefundRecord({
            status: 'submitted',
            claimableAt: null,
          }),
        )}
        worldwideDay={day('20260804')}
      />,
    );
    expect(attempt).not.toContain('Claimable at');
    expect(attempt).not.toContain('Available immediately');
    expect(attempt).not.toContain('>Claim recorded funds<');
  });

  it('shows the claimable-at row as now for a cancelled-auction non-commit-bond claim', () => {
    const claimable = renderToStaticMarkup(
      <AuctionRecoveryPanel
        controller={controllerWith(
          escrowRefundRecord({
            status: 'claimable',
            claimableAt: null,
            claimableItem: {} as never,
          }),
        )}
        worldwideDay={day('20260804')}
      />,
    );
    expect(claimable).toContain('<dt>Claimable at</dt><dd>now</dd>');
    expect(claimable).toContain('>Claim recorded funds<');
  });

  it('keeps the immediate claim for a cancelled-auction bond without a claim time', () => {
    const cancelled = renderToStaticMarkup(
      <AuctionRecoveryPanel controller={controllerWith(commitBondRecord())} worldwideDay={day('20260804')} />,
    );
    expect(cancelled).toContain('<dt>Claimable</dt><dd>now</dd>');
    expect(cancelled).not.toContain('Claim time unavailable');
    expect(cancelled).toContain('>Claim Bond<');
  });
});
