import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Eye, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { ResolvedVenueReadProfile } from '../../runtime-config/load-reviewed-runtime-config';
import { Button, Icon } from '../../ui/primitives';

const shortAddress = (value: string): string => `${value.slice(0, 6)}…${value.slice(-4)}`;
const explorerAddressUrl = (base: string | null, address: string): string | null => {
  if (base === null) return null;
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return new URL(`address/${address}`, normalized).toString();
};

export function TransactionStep({
  number,
  title,
  body,
  state,
  status,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'waiting' | 'active' | 'complete';
  readonly status?: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className={`commit-panel__transaction-step commit-panel__transaction-step--${state}`}>
      <span className="commit-panel__transaction-number">
        {state === 'complete' ? <Icon icon={Check} size={13} /> : number}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {status && (
          <p className="commit-panel__transaction-status" role="status" aria-live="polite">
            {status}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

export function RevealStepAction({
  approvalComplete,
  submitted,
  busy,
  failed,
  onClick,
}: {
  readonly approvalComplete: boolean;
  readonly submitted: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onClick?: () => void;
}) {
  if (!approvalComplete || submitted) return null;
  return (
    <Button className="commit-panel__step-action" disabled={busy} onClick={onClick}>
      <Icon icon={busy ? LoaderCircle : Eye} size={15} />
      {busy ? 'Confirm in wallet…' : failed ? 'Retry Reveal' : 'Reveal Bid'}
    </Button>
  );
}

export function TransactionContracts({
  profile,
  defaultOpen = false,
}: {
  readonly profile: ResolvedVenueReadProfile | null;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  if (!profile) return null;

  const contracts = [
    {
      name: 'IntexAuction',
      address: profile.addresses.intexAuction,
      description: 'Auction entry point',
    },
    {
      name: 'EscrowAdapter',
      address: profile.addresses.escrowAdapter,
      description: 'Pulls the wCOEN via your approval',
    },
    ...(profile.addresses.theCompact === undefined
      ? []
      : [
          {
            name: 'Escrow',
            address: profile.addresses.theCompact,
            description: 'Uniswap resource lock vault',
          },
        ]),
    {
      name: 'wCOEN',
      address: profile.addresses.paymentToken,
      description: 'ERC-20 wrapped COEN',
    },
  ] as const;

  const copyAddress = (address: string) => {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) return;
    void clipboard
      .writeText(address)
      .then(() => {
        setCopiedAddress(address);
        globalThis.setTimeout(() => {
          setCopiedAddress((current) => (current === address ? null : current));
        }, 1_800);
      })
      .catch(() => undefined);
  };

  return (
    <div className="commit-panel__contracts">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon icon={ShieldCheck} size={14} />
        <strong>Contracts in this transaction</strong>
        <span>{contracts.length} contracts</span>
        <Icon icon={ChevronDown} size={14} />
      </Button>
      <div
        className={`commit-panel__contract-list-wrap${open ? ' commit-panel__contract-list-wrap--open' : ''}`}
        aria-hidden={!open}
      >
        <div className="commit-panel__contract-list">
          {contracts.map((contract) => {
            const explorerUrl = explorerAddressUrl(profile.explorerUrl, contract.address);
            const copied = copiedAddress === contract.address;
            return (
              <div key={contract.name}>
                <div className="commit-panel__contract-identity">
                  <strong>{contract.name}</strong>
                  <code title={contract.address}>{shortAddress(contract.address)}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Copy ${contract.name} address`}
                    className={copied ? 'commit-panel__contract-copy--copied' : undefined}
                    onClick={() => copyAddress(contract.address)}
                  >
                    <Icon icon={copied ? Check : Copy} size={12} />
                  </Button>
                </div>
                <div className="commit-panel__contract-details">
                  <small>{contract.description}</small>
                  <span className="commit-panel__contract-links">
                    {explorerUrl && (
                      <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
                        <Icon icon={ExternalLink} size={12} />
                        Explorer
                      </a>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
