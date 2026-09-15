import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, RotateCcw } from 'lucide-react';
import type { WorldwideDayKey } from '../domain/protocol-time';
import { getScheduleTimeZone } from '../domain/display-timezone';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from '../domain/protocol-constants';
import { formatRecoveryTokenAmount } from '../ui/display-format';
import { Badge, Button, Card, Icon, Notice, type PresentationTone } from '../ui/primitives';
import type {
  RecoveryController,
  RecoveryDisplayIssue,
  RecoveryDisplayRecord,
  RecoveryDisplayStatus,
} from './use-recovery-controller';
import './recovery-card.css';

export { formatRecoveryTokenAmount };
const amount = (value: bigint, record: RecoveryDisplayRecord): string =>
  formatRecoveryTokenAmount(value, record.paymentTokenDecimals, record.paymentTokenSymbol);

const statusLabel: Record<RecoveryDisplayStatus, string> = {
  waiting: 'Waiting',
  claimable: 'Claimable',
  'awaiting-wallet': 'Awaiting wallet',
  submitted: 'Submitted',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  'reconciliation-pending': 'Reconciliation pending',
  'read-failure': 'Read failure',
  'incompatible-historical-contract': 'Incompatible historical contract',
};

const statusTone = (status: RecoveryDisplayStatus): PresentationTone => {
  if (status === 'claimable' || status === 'confirmed') return 'success';
  if (
    status === 'waiting' ||
    status === 'submitted' ||
    status === 'confirming' ||
    status === 'awaiting-wallet' ||
    status === 'reconciliation-pending'
  )
    return 'warning';
  return 'danger';
};

const MAX_DISPLAY_TIMESTAMP_SECONDS = Math.floor(8.64e15 / 1000);

const recoveryTimestampFormatters = new Map<string, Intl.DateTimeFormat>();
const formatTimestamp = (value: bigint | null): string => {
  if (value === null) return 'Available immediately'; // Call sites gate this on claimable status; null otherwise means the claim time is unavailable.
  if (value < 0n || value > BigInt(MAX_DISPLAY_TIMESTAMP_SECONDS)) return `${value} unix seconds`;
  const timeZone = getScheduleTimeZone();
  const cacheKey = timeZone ?? '__default__';
  let formatter = recoveryTimestampFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    recoveryTimestampFormatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(Number(value) * 1000));
};

const formatDuration = (seconds: bigint): string => {
  const safe = seconds > 0n ? seconds : 0n;
  const days = safe / BigInt(SECONDS_PER_DAY);
  const hours = (safe % BigInt(SECONDS_PER_DAY)) / BigInt(SECONDS_PER_HOUR);
  const minutes = (safe % BigInt(SECONDS_PER_HOUR)) / 60n;
  const remainder = safe % 60n;
  if (days > 0n) return `${days}d ${hours}h ${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m ${remainder.toString().padStart(2, '0')}s`;
};

const useBrowserNow = (): bigint => {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  return now;
};

const transactionStatusCopy = (record: RecoveryDisplayRecord): string | null => {
  if (record.status === 'awaiting-wallet') return 'Review and approve the exact claim in the connected wallet.';
  if (record.status === 'submitted')
    return record.reconciliationError ?? 'The claim was broadcast and its attempt was saved locally.';
  if (record.status === 'confirming') return 'Waiting for the configured venue confirmation depth.';
  if (record.status === 'confirmed') return 'The receipt and bidder-level state reconciled.';
  if (record.status === 'reconciliation-pending')
    return (
      record.reconciliationError ??
      'The transaction is confirmed, but exact state and event reconciliation is still pending.'
    );
  if (record.status === 'read-failure')
    return (
      record.reconciliationError ?? 'The stored transaction state could not be reconciled from the current venue read.'
    );
  return null;
};

function RecoverySummary({ rows }: { rows: readonly (readonly [string, string, 'success'?])[] }) {
  return (
    <dl className="summary-list">
      {rows.map(([label, value, ...tone]) => (
        <div key={label} className="summary-row">
          <dt>{label}</dt>
          <dd className={tone[0] === 'success' ? 'summary-row__success' : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CommitBondRecoveryItem({
  record,
  controller,
}: {
  record: RecoveryDisplayRecord;
  controller: RecoveryController;
}) {
  const browserNow = useBrowserNow();
  const remaining = record.claimableAt === null ? 0n : record.claimableAt - browserNow;
  const claimable = record.claimableItem !== null;
  const canClaim = claimable && !controller.busy;
  const working = controller.busy && controller.activeItemKey === record.key;

  if (record.status === 'confirmed') {
    return (
      <div className="recovery-claim-stack">
        <Notice tone="success">
          <strong>Bond returned to wallet.</strong> The commit-bond claim is confirmed.
        </Notice>
        <RecoverySummary
          rows={[
            ['Bond returned', amount(record.returnedAmount, record), 'success'],
            ['Auction series', String(record.worldwideDay)],
            ['Status', 'claimed'],
          ]}
        />
      </div>
    );
  }

  const auctionCancelled = claimable && record.claimableAt === null;
  return (
    <div className="recovery-claim-stack">
      <Notice tone={claimable ? 'success' : 'warning'}>
        {claimable ? (
          auctionCancelled ? (
            <>
              <strong>Auction cancelled — bond claimable now.</strong> The auction contract allows the live commit bond
              to be released immediately.
            </>
          ) : (
            <>
              <strong>Commit bond claimable.</strong> The stored reveal deadline and contract lock period have elapsed.
            </>
          )
        ) : (
          <>
            <strong>You committed but did not reveal.</strong> The commit bond remains locked until the contract claim
            time.
          </>
        )}
      </Notice>
      {record.reconciliationError && (
        <Notice tone="warning" live="polite">
          <strong>Transaction status unresolved.</strong> {record.reconciliationError}
        </Notice>
      )}
      <RecoverySummary
        rows={[
          [claimable ? 'Bond available' : 'Bond locked', amount(record.returnedAmount, record)],
          [
            'Claimable',
            record.claimableAt === null
              ? claimable
                ? 'now'
                : 'Claim time unavailable'
              : formatTimestamp(record.claimableAt),
          ],
          ...(claimable ? [] : [['Time remaining', formatDuration(remaining)] as const]),
          ['Auction series', String(record.worldwideDay)],
        ]}
      />
      {claimable && (
        <Button
          className="recovery-claim-button"
          disabled={!canClaim}
          onClick={() => record.claimableItem && void controller.claim(record.claimableItem)}
        >
          <Icon icon={working ? LoaderCircle : RotateCcw} size={15} />
          {working ? 'Claiming…' : 'Claim Bond'}
        </Button>
      )}
      <p className="recovery-claim-note">
        {claimable
          ? 'Anyone may submit the on-chain claim; the bond is returned to your wallet.'
          : `The claim time is contract-derived. This venue currently unlocks the unrevealed commit bond at ${record.claimableAt === null ? 'the cancellation' : formatTimestamp(record.claimableAt)}.`}
      </p>
    </div>
  );
}

function RecoveryItemCard({ record, controller }: { record: RecoveryDisplayRecord; controller: RecoveryController }) {
  const browserNow = useBrowserNow();
  const remaining = record.claimableAt === null ? 0n : record.claimableAt - browserNow;
  const claimable = record.claimableItem !== null;
  const canClaim = claimable && !controller.busy;
  const statusCopy = transactionStatusCopy(record);
  return (
    <article className={`recovery-item recovery-item--${record.status}`} aria-labelledby={`recovery-${record.key}`}>
      <div className="recovery-item__heading">
        <div>
          <span>{record.label}</span>
          <h3 id={`recovery-${record.key}`}>WorldwideDay {record.worldwideDay}</h3>
        </div>
        <Badge tone={statusTone(record.status)}>{statusLabel[record.status]}</Badge>
      </div>
      <p className="recovery-item__explanation">{record.explanation}</p>
      <dl className="summary-list" aria-label="Recovery economic outcome">
        <div className="summary-row">
          <dt>You receive</dt>
          <dd>
            <strong>{amount(record.returnedAmount, record)}</strong>
          </dd>
        </div>
        <div className="summary-row">
          <dt>Burned remainder</dt>
          <dd>
            <strong>{amount(record.burnedAmount, record)}</strong>
          </dd>
        </div>
      </dl>
      <dl className="recovery-deadline">
        {(record.claimableAt !== null || claimable) && (
          <div className="summary-row">
            <dt>Claimable at</dt>
            <dd>{record.claimableAt === null ? 'now' : formatTimestamp(record.claimableAt)}</dd>
          </div>
        )}
        {record.status === 'waiting' && record.claimableAt !== null && (
          <div className="summary-row">
            <dt>Display countdown</dt>
            <dd>{formatDuration(remaining)}</dd>
          </div>
        )}
      </dl>
      {record.transactionHash && (
        <div className="recovery-transaction" role="status" aria-live="polite">
          <span>Transaction</span>
          <code title={record.transactionHash}>{record.transactionHash}</code>
        </div>
      )}
      {statusCopy && (
        <Notice tone={record.status === 'confirmed' ? 'success' : 'warning'} live="polite">
          {statusCopy}
        </Notice>
      )}
      {claimable && (
        <Button
          className="recovery-item__claim"
          disabled={!canClaim}
          onClick={() => record.claimableItem && void controller.claim(record.claimableItem)}
        >
          <Icon
            icon={controller.busy && controller.activeItemKey === record.key ? LoaderCircle : RotateCcw}
            size={15}
          />
          Claim recorded funds
        </Button>
      )}
    </article>
  );
}

function RecoveryIssueCard({ issue }: { issue: RecoveryDisplayIssue }) {
  return (
    <article className="recovery-issue" role="status">
      <Notice tone="danger">
        <Icon icon={AlertTriangle} size={17} />
        <strong>{statusLabel[issue.status]}</strong>
      </Notice>
      {issue.worldwideDay && <span>WorldwideDay {issue.worldwideDay}</span>}
      {issue.escrowContract && <code title={issue.escrowContract}>{issue.escrowContract}</code>}
      <p>{issue.message}</p>
    </article>
  );
}

export function AuctionRecoveryPanel({
  controller,
  worldwideDay,
}: {
  controller: RecoveryController;
  worldwideDay: WorldwideDayKey;
}) {
  if (controller.evidence.kind === 'blocked') {
    return (
      <Card className="recovery-card recovery-card--auction">
        <h2>Commit bond</h2>
        <Notice tone="neutral">{controller.evidence.message}</Notice>
      </Card>
    );
  }
  if (controller.evidence.kind === 'loading') {
    return (
      <Card className="recovery-card recovery-card--auction">
        <h2>Commit bond</h2>
        <Notice tone="neutral">Checking your recoverable funds…</Notice>
      </Card>
    );
  }
  if (controller.evidence.kind === 'failure') {
    return (
      <Card className="recovery-card recovery-card--auction">
        <h2>Commit bond</h2>
        <Notice tone="danger" live="assertive">
          {controller.evidence.message}
        </Notice>
      </Card>
    );
  }

  const records = controller.evidence.records.filter((record) => record.worldwideDay === worldwideDay);
  const issues = controller.evidence.issues.filter((issue) => issue.worldwideDay === worldwideDay);
  const commitBond = records.find((record) => record.path === 'auction-commit-bond');
  if (commitBond) {
    return (
      <Card className="recovery-card recovery-card--auction recovery-card--claim" aria-labelledby="recovery-card-title">
        <h2 id="recovery-card-title">Commit bond</h2>
        <CommitBondRecoveryItem record={commitBond} controller={controller} />
      </Card>
    );
  }

  return (
    <Card className="recovery-card recovery-card--auction" aria-labelledby="recovery-card-title">
      <div className="recovery-card__heading">
        <Icon icon={records.some((record) => record.status === 'claimable') ? RotateCcw : CheckCircle2} />
        <div>
          <span>Wallet-specific</span>
          <h2 id="recovery-card-title">Bidder Recovery</h2>
        </div>
      </div>
      {records.length === 0 && issues.length === 0 && (
        <p className="recovery-empty">No unresolved recovery for this wallet and auction.</p>
      )}
      <div className="recovery-list">
        {records.map((record) => (
          <RecoveryItemCard key={record.key} record={record} controller={controller} />
        ))}
        {issues.map((issue) => (
          <RecoveryIssueCard key={issue.key} issue={issue} />
        ))}
      </div>
    </Card>
  );
}

export const recoveryEvidenceHasDay = (
  evidence: RecoveryController['evidence'],
  worldwideDay: WorldwideDayKey,
): boolean =>
  evidence.kind === 'loaded' &&
  (evidence.records.some((record) => record.worldwideDay === worldwideDay) ||
    evidence.issues.some((issue) => issue.worldwideDay === worldwideDay));
