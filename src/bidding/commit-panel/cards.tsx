import { useState } from 'react';
import { ArrowLeftRight, ChevronDown, type ShieldCheck } from 'lucide-react';
import { Button, Icon, InfoTip } from '../../ui/primitives';
import { FlowingNumberText } from '../../ui/flowing-number-text';

export interface BidDetailRow {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
  readonly tip?: ReadonlyArray<{ readonly title: string; readonly body: string }> | undefined;
}

export function CommitBidDetails({ rows }: { readonly rows: readonly BidDetailRow[] }) {
  return (
    <div className="commit-panel__bid-details">
      <div className="commit-panel__bid-details-title">Your Bid Details</div>
      <dl aria-label="Your Bid Details">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>
              {row.label}
              {row.tip && (
                <InfoTip label={row.tip.map(({ title, body }) => `${title}: ${body}`).join(' ')}>
                  {row.tip.map(({ title, body }, index) => (
                    <span key={title} style={{ display: 'block', marginTop: index ? 10 : 0 }}>
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
                        {title}
                      </strong>
                      <span style={{ display: 'block', opacity: 0.82, lineHeight: 1.42 }}>{body}</span>
                    </span>
                  ))}
                </InfoTip>
              )}
            </dt>
            <dd>
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: deferred FlowingNumberText accessible-name work */}
              <strong data-number-flow="bid-detail-primary" aria-label={row.value}>
                <FlowingNumberText value={row.value} />
              </strong>
              {row.detail && (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: deferred FlowingNumberText accessible-name work
                <small data-number-flow="bid-detail-detail" aria-label={row.detail}>
                  <FlowingNumberText value={row.detail} />
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface ConversionRateRow {
  readonly pair: string;
  readonly value: string;
}

export function CommitConversionRates({
  rows,
  defaultOpen = false,
}: {
  readonly rows: readonly ConversionRateRow[];
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="commit-panel__contracts">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon icon={ArrowLeftRight} size={14} />
        <strong>Conversion Rates</strong>
        <span>{rows.length} rates</span>
        <Icon icon={ChevronDown} size={14} />
      </Button>
      <div
        className={`commit-panel__contract-list-wrap${open ? ' commit-panel__contract-list-wrap--open' : ''}`}
        aria-hidden={!open}
      >
        <div className="commit-panel__contract-list">
          {rows.map((row) => (
            <div key={row.pair} className="commit-panel__conversion-row">
              <i>{row.pair}</i>
              <b>{row.value}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface BidderReceiptTipSection {
  readonly title: string;
  readonly body: string;
}

export interface BidderReceiptDetail {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
  readonly tip?: readonly BidderReceiptTipSection[] | undefined;
}

export function BidderReceipt({
  title,
  icon,
  primaryLabel,
  primaryValue,
  primaryDetail,
  details,
  tone = 'success',
}: {
  readonly title: string;
  readonly icon: typeof ShieldCheck;
  readonly primaryLabel: string;
  readonly primaryValue: string;
  readonly primaryDetail: string;
  readonly details: readonly BidderReceiptDetail[];
  readonly tone?: 'success' | 'neutral';
}) {
  return (
    <div className={`bidder-receipt bidder-receipt--${tone}`}>
      {tone === 'success' && (
        <div className="bidder-receipt__glow" aria-hidden="true">
          <i />
          <i />
        </div>
      )}
      <div className="bidder-receipt__content">
        <div className="bidder-receipt__header">
          <span>
            <Icon icon={icon} size={13} />
          </span>
          <strong>{title}</strong>
        </div>
        <div className="bidder-receipt__primary">
          <span>{primaryLabel}</span>
          <b>{primaryValue}</b>
          <small>{primaryDetail}</small>
        </div>
        <dl className="bidder-receipt__details">
          {details.map((detail) => (
            <div key={detail.label}>
              <dt style={detail.tip ? { display: 'flex', alignItems: 'center', gap: 5 } : undefined}>
                {detail.label}
                {detail.tip && (
                  <InfoTip label={detail.tip.map(({ title: tipTitle, body }) => `${tipTitle}: ${body}`).join(' ')}>
                    {detail.tip.map((section, index) => (
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
                  </InfoTip>
                )}
              </dt>
              <dd>
                {detail.value}
                {detail.detail && <small>{detail.detail}</small>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
