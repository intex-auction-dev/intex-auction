import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShieldCheck } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import type { PublicAuctionRead } from '@/discovery/load-public-auction';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import type { OracleConversions } from '@/oracle/oracle-conversions';
import {
  BidderReceipt,
  BidderTransactionNotice,
  CommitBidDetails,
  CommitConversionRates,
  CommitPanel,
  CommitStepper,
  IssuanceCurrencyField,
  RevealStepAction,
  TransactionContracts,
  commitFormCopy,
  currencyPickerItems,
  formatFixedRate18,
  formatPaymentTokenAmount,
  formatPromisAmount,
  liveEntryPriceCopy,
} from '@/bidding/commit-panel';

describe('commit action rail presentation', () => {
  it('labels the bid rate as a percentage of strike on the primary auction UI only', () => {
    expect(commitFormCopy.quantityHint(2)).toBe('Min – 2 Intexes.');
    expect(commitFormCopy.bidRateHint(50_000)).toBe('Percent of strike. Min – 5%.');
    expect(commitFormCopy.bidRate(50_000)).toBe('5% of strike');
    expect(commitFormCopy.bond('Œ100')).toBe('Committing locks a refundable Œ100 bond.');
    expect(formatPaymentTokenAmount(100_000_000n * 10n ** 18n, 18, 'WCOEN')).toBe('Œ100,000,000');
    expect(formatPromisAmount(100_000n * 10n ** 6n)).toBe('100,000');
    expect(formatFixedRate18(34n * 10n ** 18n)).toBe('34.00');
    expect(formatFixedRate18(34_005n * 10n ** 15n)).toBe('34.01');
  });

  it('renders unresolved transaction status as a right-side warning notice', () => {
    const markup = renderToStaticMarkup(
      <BidderTransactionNotice message="A previous approval transaction has an unresolved network result. The controls below reflect fresh contract state." />,
    );

    expect(markup).toContain('notice notice--warning');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Transaction status unresolved.');
    expect(markup).toContain('controls below reflect fresh contract state');
  });

  it('does not describe commit confirmation as an automatic receipt download', () => {
    const source = readFileSync(new URL('../../../../src/bidding/commit-panel.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('Automatic receipt download failed.');
    expect(source).not.toContain('Receipt download was initiated.');
    expect(source).toContain('confirmed. Receipt is stored in this browser.');
  });

  it('renders the approved bid-detail order and secondary strike copy', () => {
    const markup = renderToStaticMarkup(
      <CommitBidDetails
        rows={[
          { label: 'Quantity', value: '10 Intexes', detail: '1,000,000 Promis' },
          { label: 'Bid rate', value: '5% of strike' },
          { label: 'Bid amount per Intex', value: 'Œ5,000', detail: '170 TRY · 5 USD' },
          { label: 'Total bid amount', value: 'Œ50,000', detail: '1,700 TRY · 50 USD' },
          { label: 'Promis', value: '1,000,000' },
          { label: 'Strike amount', value: '3,400 TRY', detail: '100 USD · per Intex' },
          { label: 'Total strike amount', value: '34,000 TRY', detail: '1,000 USD' },
        ]}
      />,
    );

    const labels = [
      'Quantity',
      'Bid rate',
      'Bid amount per Intex',
      'Total bid amount',
      'Promis',
      'Strike amount',
      'Total strike amount',
    ];
    labels.reduce((previous, label) => {
      const position = markup.indexOf(`<dt>${label}</dt>`);
      expect(position).toBeGreaterThan(previous);
      return position;
    }, -1);
    expect(markup).toContain('data-number-flow="bid-detail-primary"');
    expect(markup).toContain('data-number-flow="bid-detail-detail"');
    expect(markup).toContain('data-flow-group="1"');
    expect(markup).toContain('5% of strike');
    expect(markup).toContain('100 USD · per Intex');
    expect(markup).toContain('1,000 USD');
    expect(markup).not.toContain('paid if won');
  });

  it('renders the approved strike tooltip in the sealed bid receipt', () => {
    const markup = renderToStaticMarkup(
      <BidderReceipt
        title="Sealed Bid Committed"
        icon={ShieldCheck}
        primaryLabel="Bid rate"
        primaryValue="5%"
        primaryDetail="of strike"
        details={[
          {
            label: 'Strike amount',
            value: '3,400 TRY',
            detail: '100 USD · per Intex',
            tip: [
              {
                title: 'Currency',
                body: 'The strike is set in USD (reference currency) and shown in TRY (issuance currency).',
              },
              {
                title: 'How it is calculated',
                body: 'Entry Price 0.001 USD × Intex Size 100,000 × FX USD→TRY 34 = 3,400 TRY.',
              },
            ],
          },
        ]}
      />,
    );

    expect(markup).toContain('Sealed Bid Committed');
    expect(markup).toContain('Strike amount');
    expect(markup).toContain('class="info-tip"');
    expect(markup).toContain('The strike is set in USD (reference currency) and shown in TRY (issuance currency).');
    expect(markup).toContain('Entry Price 0.001 USD × Intex Size 100,000 × FX USD→TRY 34 = 3,400 TRY.');
  });

  it('renders the expected series label and issuance window tooltip on the series-to-be-issued row', () => {
    const markup = renderToStaticMarkup(
      <BidderReceipt
        title="Sealed Bid Committed"
        icon={ShieldCheck}
        primaryLabel="Bid rate"
        primaryValue="5%"
        primaryDetail="of strike"
        details={[
          {
            label: 'Intex series to be issued',
            value: '2026-08-04-TRY-U',
            tip: [
              {
                title: 'Issuance window',
                body: 'The origin series is created once global clearing runs, within 12h after the reveal window closes. Delivery to this venue is expected during the issuance stage but is not time-guaranteed.',
              },
            ],
          },
        ]}
      />,
    );

    expect(markup).toContain('Intex series to be issued');
    expect(markup).toContain('2026-08-04-TRY-U');
    expect(markup).toContain('class="info-tip"');
    expect(markup).toContain('within 12h after the reveal window closes');
    expect(markup).toContain('not time-guaranteed');
  });

  it('renders the conversion rates as an accordion with per-pair rows', () => {
    const markup = renderToStaticMarkup(
      <CommitConversionRates
        rows={[
          { pair: 'Œ / TRY', value: '1 Œ ≈ 15.00 TRY' },
          { pair: 'Œ / USD', value: '1 Œ ≈ 1.19 USD' },
          { pair: 'USD / TRY', value: '1 USD ≈ 12.60 TRY' },
        ]}
      />,
    );

    expect(markup).toContain('Conversion Rates');
    expect(markup).toContain('3 rates');
    expect(markup).toContain('Œ / TRY');
    expect(markup).toContain('1 Œ ≈ 15.00 TRY');
    expect(markup).toContain('Œ / USD');
    expect(markup).toContain('1 Œ ≈ 1.19 USD');
    expect(markup).toContain('1 USD ≈ 12.60 TRY');
  });

  it('links the Entry Price to the live COEN oracle rate and falls back to the contract entry price', () => {
    const conversions: OracleConversions = {
      byIsoCode: new Map([
        [
          840,
          {
            kind: 'available',
            isoCode: 840,
            denomination: 'USD',
            rate: 1_050_000_000_000_000_000n,
            sourceBlock: null,
            sourceTimestamp: null,
          },
        ],
      ]),
    };

    expect(
      liveEntryPriceCopy({
        referenceCurrency: 840,
        contractEntryPriceMinor: 1_000_000n,
        liveOracleConversions: conversions,
        paymentTokenSymbol: 'wCOEN',
      }),
    ).toBe('1 Œ ≈ 1.05 USD');
    expect(
      liveEntryPriceCopy({
        referenceCurrency: 840,
        contractEntryPriceMinor: 1_000_000n,
        liveOracleConversions: null,
        paymentTokenSymbol: 'wCOEN',
      }),
    ).toBe('1 Œ ≈ 1.00 USD');
    expect(
      liveEntryPriceCopy({
        referenceCurrency: 840,
        contractEntryPriceMinor: 1_000_000n,
        liveOracleConversions: { byIsoCode: new Map() },
        paymentTokenSymbol: 'wCOEN',
      }),
    ).toBe('1 Œ ≈ 1.00 USD');
    expect(
      liveEntryPriceCopy({
        referenceCurrency: 840,
        contractEntryPriceMinor: 1_000_000n,
        liveOracleConversions: null,
        paymentTokenSymbol: 'Wrapped COEN',
      }),
    ).toBe('1 Wrapped COEN ≈ 1.00 USD');
  });

  it('matches the approved contract chain content and controls', () => {
    const address = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
    const profile = {
      explorerUrl: 'https://explorer.example',
      addresses: {
        intexAuction: address('1'),
        escrowAdapter: address('2'),
        theCompact: address('3'),
        paymentToken: address('4'),
      },
    } as ResolvedVenueReadProfile;

    const markup = renderToStaticMarkup(<TransactionContracts profile={profile} defaultOpen />);

    expect(markup).toContain('4 contracts');
    expect(markup).toContain('Auction entry point');
    expect(markup).toContain('Pulls the wCOEN via your approval');
    expect(markup).toContain('Uniswap resource lock vault');
    expect(markup).toContain('ERC-20 wrapped COEN');
    expect(markup).not.toContain('Exact wCOEN approval spender');
    expect(markup).not.toContain('payment token');
    expect(markup).not.toContain('Payment token');
    expect(markup).toContain('>wCOEN<');
    expect(markup).toContain('0x1111…1111');
    expect(markup.match(/aria-label="Copy [^"]+ address"/g)).toHaveLength(4);
    expect(markup.match(/>Explorer<\/a>/g)).toHaveLength(4);
    expect(markup.match(/>Audit<\/a>/g)).toBeNull();
    expect(markup).toContain(`https://explorer.example/address/${address('1')}`);
    expect(markup.indexOf('IntexAuction')).toBeLessThan(markup.indexOf('EscrowAdapter'));
    expect(markup.indexOf('EscrowAdapter')).toBeLessThan(markup.indexOf('>Escrow<'));
    expect(markup.indexOf('>Escrow<')).toBeLessThan(markup.indexOf('>wCOEN<'));
  });

  it('renders centered editable steppers with both side controls', () => {
    const markup = renderToStaticMarkup(
      <CommitStepper
        label="Quantity"
        value="10"
        minimum={1}
        step={1}
        suffix="Intexes"
        hint="Min – 1 Intex."
        inputMode="numeric"
        disabled={false}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('class="commit-panel__stepper"');
    expect(markup).toContain('aria-label="Decrease"');
    expect(markup).toContain('aria-label="Increase"');
    expect(markup).toContain('aria-label="Quantity"');
    expect(markup).toContain('style="width:2ch"');
    expect(markup).toContain('>Intexes</i>');
    expect(markup).not.toContain('<label class="commit-panel__field">');
  });

  it('renders the COEN symbol before the editable bid amount', () => {
    const markup = renderToStaticMarkup(
      <CommitStepper
        label="Bid per Intex"
        value="5000"
        minimum={5}
        step={0.5}
        prefix="Œ"
        hint="≈ 170 TRY · 5 USD"
        inputMode="decimal"
        disabled={false}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('>Œ</i>');
    expect(markup.indexOf('>Œ</i>')).toBeLessThan(markup.indexOf('aria-label="Bid per Intex"'));
    expect(markup).not.toContain('WCOEN');
  });

  it('keeps a reveal action available after approval and turns it into retry after wallet rejection', () => {
    const revealMarkup = renderToStaticMarkup(
      <RevealStepAction approvalComplete submitted={false} busy={false} failed={false} />,
    );
    const retryMarkup = renderToStaticMarkup(
      <RevealStepAction approvalComplete submitted={false} busy={false} failed />,
    );
    const pendingMarkup = renderToStaticMarkup(
      <RevealStepAction approvalComplete submitted={false} busy failed={false} />,
    );
    const submittedMarkup = renderToStaticMarkup(
      <RevealStepAction approvalComplete submitted busy={false} failed={false} />,
    );

    expect(revealMarkup).toContain('Reveal Bid');
    expect(retryMarkup).toContain('Retry Reveal');
    expect(pendingMarkup).toContain('Confirm in wallet…');
    expect(pendingMarkup).toContain('disabled');
    expect(submittedMarkup).toBe('');
  });

  it('spins the loader icon shown while a transaction is awaiting wallet confirmation', () => {
    const pendingMarkup = renderToStaticMarkup(
      <RevealStepAction approvalComplete submitted={false} busy failed={false} />,
    );
    const appCss = readFileSync(new URL('../../../../src/app/app.css', import.meta.url), 'utf8');

    expect(pendingMarkup).toContain('lucide-loader-circle');
    expect(appCss).toMatch(/\.lucide-loader-circle\s*{[^}]*animation:\s*spin[^}]*}/);
  });

  it('starts with the compact approved action instead of exposing the full form', () => {
    const markup = renderToStaticMarkup(
      <CommitPanel
        auction={{ worldwideDay: '20260804', venue: { kind: 'delivery-pending' } } as PublicAuctionRead}
        calendarDay={null}
        walletState={{ kind: 'disconnected', providers: [] }}
        profile={null}
        publicClient={null}
        contextToken="test:disconnected"
        isContextCurrent={() => true}
      />,
    );

    expect(markup).toContain('Place your bid');
    expect(markup).toContain('Commit Sealed Bid');
    expect(markup).toContain('commit-panel--prompt');
    expect(markup).not.toContain('Auction timing');
    expect(markup).not.toContain('protocol-evidence');
  });
});

describe('IssuanceCurrencyField closed-label rendering', () => {
  const fieldMarkup = (selected: number): string =>
    renderToStaticMarkup(
      <IssuanceCurrencyField allowed={[840, 949]} selected={selected} disabled={false} onSelect={() => {}} />,
    );

  it('shows only the three-character code in the closed trigger', () => {
    const markup = fieldMarkup(949);
    expect(markup).toContain('commit-panel__currency-trigger__code');
    expect(markup).toMatch(/currency-trigger__code">TRY<\/span>/);
    expect(markup).not.toContain('Turkish Lira');
  });

  it('also shows only the three-character code for the other allowed currency', () => {
    const markup = fieldMarkup(840);
    expect(markup).toMatch(/currency-trigger__code">USD<\/span>/);
    expect(markup).not.toContain('Turkish Lira');
  });

  it('lists the alpha + numeric ISO code in the option labels so the picker shows the stored numeric code', () => {
    const items = currencyPickerItems([840, 949]);
    const tryItem = items.find((item) => item.value === 949);
    const usdItem = items.find((item) => item.value === 840);
    expect(tryItem?.label).toContain('TRY · 949');
    expect(usdItem?.label).toContain('USD · 840');
  });
});
