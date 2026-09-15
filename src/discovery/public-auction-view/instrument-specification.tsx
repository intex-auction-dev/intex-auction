import type { ReactNode } from 'react';
import type { CalendarWorldwideDay } from '../calendar-evidence';
import type { PublicAuctionRead } from '../load-public-auction';
import { deriveStrikeAmountMinor } from '../../oracle/multi-currency-evidence';
import { liveOracleCrossRate } from '../../oracle/oracle-conversions';
import { useCurrencyFormatters } from '../../oracle/currency-state';
import { Card, InfoTip } from '../../ui/primitives';
import {
  currencyCode,
  formatPriceMinor9,
  formatPromisAmount as formatTokenAmount18,
  integer,
} from '../../ui/display-format';
import { formatIso4217CurrencyCode } from '../../domain/iso-4217';

const referenceCurrencyName = currencyCode;

interface ProductEvidenceProps {
  auction: PublicAuctionRead;
  calendarDay?: CalendarWorldwideDay | null;
}

interface SpecTipSection {
  body: string;
  title: string;
}

type SpecTip = string | readonly SpecTipSection[];

function SpecTipContent({ tip }: { tip: SpecTip }) {
  if (typeof tip === 'string') return <>{tip}</>;
  return (
    <>
      {tip.map((section, index) => (
        <span key={section.title} style={{ display: 'block', marginTop: index ? 10 : 0 }}>
          <strong
            style={{
              display: 'block',
              marginBottom: 2,
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1.25,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            {section.title}
          </strong>
          <span style={{ display: 'block', opacity: 0.82, lineHeight: 1.42 }}>{section.body}</span>
        </span>
      ))}
    </>
  );
}

const specTipLabel = (tip: SpecTip): string =>
  typeof tip === 'string' ? tip : tip.map(({ title, body }) => `${title}: ${body}`).join(' ');

function SpecRow({
  label,
  value,
  detail,
  tip,
  last = false,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tip?: SpecTip;
  last?: boolean;
}) {
  return (
    <div className={`instrument-row ${last ? 'instrument-row--last' : ''}`.trim()}>
      <div>
        <dt>
          {label}
          {tip && (
            <InfoTip label={specTipLabel(tip)}>
              <SpecTipContent tip={tip} />
            </InfoTip>
          )}
        </dt>
        {detail && <span>{detail}</span>}
      </div>
      <dd>{value}</dd>
    </div>
  );
}

function SpecGroup({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`instrument-group ${className}`.trim()}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const period = (value: bigint): string => {
  if (value % 86_400n !== 0n) return `${integer(value)} seconds`;
  const days = value / 86_400n;
  return `${integer(days)} ${days === 1n ? 'day' : 'days'}`;
};

const relativeReferenceCopy = (prefix: string, value: bigint, entry: bigint, entryLabel: string): string => {
  if (entry === 0n) return `${prefix} when COEN reaches this reference`;
  const tenths = ((value - entry) * 1_000n) / entry;
  const direction = tenths >= 0n ? 'higher' : 'lower';
  const absolute = tenths >= 0n ? tenths : -tenths;
  const percentage = absolute % 10n === 0n ? `${absolute / 10n}` : `${absolute / 10n}.${absolute % 10n}`;
  return `${prefix} when COEN price is ${percentage}% ${direction} than ${entryLabel}`;
};

const formatHundredths = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

export function InstrumentSpecification({ auction }: ProductEvidenceProps) {
  const currency = useCurrencyFormatters();
  if (auction.venue.kind !== 'delivered') {
    return (
      <Card className="instrument-spec-card" aria-labelledby="instrument-spec-title">
        <h2 id="instrument-spec-title">Intex Details</h2>
        <p className="product-empty-state product-empty-state--embedded">
          {auction.venue.kind === 'delivery-pending'
            ? "Auction terms aren't available until the active venue receives the auction schedule."
            : 'Instrument terms are unavailable from the current venue evidence.'}
        </p>
      </Card>
    );
  }

  const venue = auction.venue.auction;
  const issuanceCurrencies = venue.params.issuanceCurrencies ?? [venue.params.issuanceCurrency];
  const strikeAmounts = venue.params.strikeAmountsMinor ?? [];
  const preferredIssuanceCurrency = issuanceCurrencies[0] ?? null;
  const strikeCurrencies = [...new Set([preferredIssuanceCurrency, venue.params.referenceCurrency])].filter(
    (currency): currency is number => currency !== null && currency !== undefined,
  );
  const strikeValues = strikeCurrencies.flatMap((isoCode) => {
    const index = issuanceCurrencies.indexOf(isoCode);
    const storedAmount = index >= 0 ? strikeAmounts[index] : undefined;
    const amount =
      storedAmount && storedAmount > 0n
        ? storedAmount
        : isoCode === venue.params.referenceCurrency &&
            venue.params.entryPriceMinor > 0n &&
            venue.params.promisLoadMinor > 0n
          ? deriveStrikeAmountMinor(venue.params.entryPriceMinor, venue.params.promisLoadMinor)
          : (() => {
              if (
                !currency.conversions ||
                !venue.params.referenceCurrency ||
                venue.params.entryPriceMinor <= 0n ||
                venue.params.promisLoadMinor <= 0n
              )
                return undefined;
              const crossRate = liveOracleCrossRate(currency.conversions, venue.params.referenceCurrency, isoCode);
              if (crossRate === null || crossRate <= 0n) return undefined;
              const issuanceEntry = (venue.params.entryPriceMinor * crossRate) / 10n ** 18n;
              return deriveStrikeAmountMinor(issuanceEntry, venue.params.promisLoadMinor);
            })();
    return amount && amount > 0n ? [`${formatPriceMinor9(amount)} ${referenceCurrencyName(isoCode)}`] : [];
  });
  const issuanceCurrencyList = issuanceCurrencies.map(formatIso4217CurrencyCode).join(', ');
  const callRelationship =
    venue.params.entryPriceMinor > 0n && venue.params.callPriceMinor > venue.params.entryPriceMinor
      ? {
          multiplier: formatHundredths((venue.params.callPriceMinor * 100n) / venue.params.entryPriceMinor),
          uplift: formatHundredths(
            ((venue.params.callPriceMinor - venue.params.entryPriceMinor) * 10_000n) / venue.params.entryPriceMinor,
          ),
        }
      : null;
  const callPriceTipBody = callRelationship
    ? `If the COEN reference rate rises +${callRelationship.uplift}% above the entry price (call price = entry price x ${callRelationship.multiplier}) and stays above it for ${venue.params.callTrigger.thresholdDays} of ${venue.params.callTrigger.windowDays} days, settlement becomes mandatory.`
    : `If the COEN reference rate rises above the call price and stays above it for ${venue.params.callTrigger.thresholdDays} of ${venue.params.callTrigger.windowDays} days, settlement becomes mandatory.`;
  return (
    <Card className="instrument-spec-card" aria-labelledby="instrument-spec-title">
      <h2 id="instrument-spec-title">Intex Details</h2>
      <dl className="instrument-auction-terms" aria-label="Auction Terms">
        <SpecRow
          label="Intex Size"
          value={`${formatTokenAmount18(venue.params.promisLoadMinor)} Promis`}
          detail="Promis per Intex"
        />
        <SpecRow
          label="Entry Price"
          value={currency.formatReferenceValue(venue.params.entryPriceMinor, venue.params.referenceCurrency)}
          detail="Price of COEN fixed at auction start"
          tip={[{ title: 'The anchor', body: 'COEN reference price captured at the start of the auction.' }]}
        />
        <SpecRow
          label="Strike Amount"
          value={strikeValues.length > 0 ? strikeValues.join(' · ') : 'Unavailable'}
          detail="per Intex"
          tip={[
            {
              title: 'Future payment',
              body: 'This is what the bidder owes per Intex to settle it and mine the Promis inside.',
            },
            {
              title: 'Currency',
              body: `The strike is stored separately in each enabled issuance currency (${issuanceCurrencyList}); ${formatIso4217CurrencyCode(venue.params.referenceCurrency)} is the reference currency used for Entry, Floor, and Call.`,
            },
            {
              title: 'How it is calculated',
              body: 'Each stored strike is calculated from the frozen WorldwideDay entry price for that issuance currency × Intex Size, then rounded up to the next 100 whole currency units. The stored auction amount is displayed directly.',
            },
            {
              title: 'When it is due',
              body: 'Strike is only due at settlement, which becomes available once the Intex is qualified or called.',
            },
          ]}
          last
        />
      </dl>
      <SpecGroup title="Settlement Conditions" className="instrument-group--references">
        <section className="instrument-subgroup">
          <h4>Qualification · Voluntary Settlement</h4>
          <dl>
            <SpecRow
              label="Floor Price"
              value={currency.formatReferenceValue(venue.params.floorPriceMinor, venue.params.referenceCurrency)}
              detail={relativeReferenceCopy(
                'Settlement is possible',
                venue.params.floorPriceMinor,
                venue.params.entryPriceMinor,
                'Entry Price',
              )}
              tip={[
                {
                  title: 'Qualification threshold',
                  body: 'COEN price must exceed this floor before an Intex can be settled voluntarily.',
                },
                { title: 'Fixed at auction start', body: 'Fixed at auction start. Derived from the entry price.' },
              ]}
              last
            />
          </dl>
        </section>
        <section className="instrument-subgroup instrument-subgroup--call">
          <h4>Call · Forced Settlement</h4>
          <dl>
            <SpecRow
              label="Call Price"
              value={currency.formatReferenceValue(venue.params.callPriceMinor, venue.params.referenceCurrency)}
              detail={relativeReferenceCopy(
                'Settlement is mandatory',
                venue.params.callPriceMinor,
                venue.params.entryPriceMinor,
                'entry price',
              )}
              tip={[
                { title: 'Forced settlement', body: callPriceTipBody },
                { title: 'Fixed at auction start', body: 'Fixed at auction start. Derived from the entry price.' },
              ]}
            />
            <SpecRow
              label="Call Event"
              value={`${venue.params.callTrigger.thresholdDays} of ${venue.params.callTrigger.windowDays} days`}
              detail="Days COEN must stay above call price to trigger"
            />
            <SpecRow
              label="Deadline"
              value={`${period(venue.params.callTrigger.intexCallPeriod)} since call`}
              detail="To pay Strike Amount and settle Intex"
              tip="After a call triggers, holders must pay the strike amount within this window or forfeit their Intex."
              last
            />
          </dl>
        </section>
      </SpecGroup>
    </Card>
  );
}
