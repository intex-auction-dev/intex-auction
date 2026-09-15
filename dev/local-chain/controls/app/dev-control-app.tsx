import type { ReactNode } from 'react';

export type JsonNumber = string | number | bigint;

export interface LocalStatus {
  chain: { chainId: number; blockNumber: JsonNumber; timestamp: JsonNumber };
  scenario: { name: string; worldwideDay: number } | null;
  tester: {
    address: string;
    native: string;
    wcoen: string;
    allowance: string;
    commitHash?: string;
    revealed?: boolean;
    commitBond?: { amount: string; lockedAt: number } | null;
    bidLock?: {
      lockedAmount: string;
      lockedAt: number;
      status: number;
      failedRefund: string;
      splitRecorded: boolean;
    } | null;
    recoveryClaimableAt?: string | null;
    abandonedBondClaimableAt?: string | null;
    escrowRecoveryClaimableAt?: string | null;
  };
  oracle?: {
    available: boolean;
    pairs: readonly unknown[] | null;
    rates: Record<string, readonly JsonNumber[] | null>;
    walkRunning?: boolean;
  };
  protocol?: {
    worldwideDay: readonly JsonNumber[] | null;
    globalStage: number | null;
    targetStage: number | null;
    schedule: { commitEnd: JsonNumber; revealEnd: JsonNumber; issuanceEnd: JsonNumber } | null;
    parameters: Record<string, unknown> | null;
    result: {
      auctionClearingRate: JsonNumber;
      wonBidsCount: JsonNumber;
      issuedIntexCount: JsonNumber;
      issuedIntexLoadedPromis: JsonNumber;
    } | null;
    runningCounts: readonly JsonNumber[] | null;
    escrow: readonly unknown[] | null;
    canonicalSeries: Record<string, unknown> | null;
    targetSeriesIds: readonly JsonNumber[];
    ownedTokenIds: readonly JsonNumber[];
    ownedBalances: readonly JsonNumber[];
  };
}

export interface DevControlViewProps {
  status: LocalStatus | null;
  busy: string | null;
  error: string | null;
  fundingMessage: string | null;
  seedCount: number;
  testerAddress: string;
  testerAddressError: string | null;
  onRefresh: () => void;
  onRun: (command: string, count?: number) => void;
  onSeedCountChange: (count: number) => void;
  onTesterAddressChange: (address: string) => void;
}

const GLOBAL_STAGES = ['None', 'Briefed', 'Started', 'Revealing', 'Clearing', 'Cleared', 'Cancelled'];
const TARGET_STAGES = ['CommittingBids', 'RevealingBids', 'Issuance', 'Completed', 'Cancelled'];
const LOCK_STATES = ['None', 'Locked', 'Finalized'];
const WWD_STATUS: Record<number, string> = { 6: 'Completed', 7: 'Failed' };
const DAY_TYPE: Record<number, string> = { 0: 'Unknown', 1: 'Green', 2: 'Red' };
const SERIES_STATE = ['Issued', 'Qualified', 'Called'];
const SEVEN_DAYS_SECONDS = 7n * 86_400n;

const integer = (value: JsonNumber | undefined | null): string =>
  value === undefined || value === null ? 'Unavailable' : BigInt(value).toLocaleString('en-GB');
const token = (value: JsonNumber | undefined | null): string => {
  if (value === undefined || value === null) return 'Unavailable';
  const amount = BigInt(value);
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole.toLocaleString('en-GB')}${fraction ? `.${fraction}` : ''}`;
};
const devTimestampFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
const timestamp = (value: JsonNumber | undefined | null): string => {
  if (value === undefined || value === null) return 'Unavailable';
  return devTimestampFormatter.format(new Date(Number(value) * 1000));
};
const shortHash = (value: string | undefined): string =>
  !value || /^0x0+$/.test(value) ? 'None' : `${value.slice(0, 10)}…${value.slice(-8)}`;
const activeAmount = (value: string | undefined): boolean => value !== undefined && BigInt(value) > 0n;
const timeReached = (now: JsonNumber, target: string | null | undefined): boolean =>
  target !== null && target !== undefined && BigInt(target) <= BigInt(now);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dev-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Panel({
  eyebrow,
  title,
  children,
  className = '',
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`dev-panel ${className}`.trim()}>
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function ControlButton({
  label,
  command,
  disabled,
  danger,
  positive,
  onRun,
}: {
  label: string;
  command: string;
  disabled?: boolean;
  danger?: boolean;
  positive?: boolean;
  onRun: (command: string) => void;
}) {
  const classes = ['dev-control', danger ? 'dev-control--danger' : '', positive ? 'dev-control--positive' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={disabled} onClick={() => onRun(command)}>
      {label}
      <span>→</span>
    </button>
  );
}

export function DevControlView({
  status,
  busy,
  error,
  fundingMessage,
  seedCount,
  testerAddress,
  testerAddressError,
  onRefresh,
  onRun,
  onSeedCountChange,
  onTesterAddressChange,
}: DevControlViewProps) {
  const protocol = status?.protocol;
  const targetStage = protocol?.targetStage ?? null;
  const globalStage = protocol?.globalStage ?? null;
  const lock = status?.tester.bidLock;
  const bond = status?.tester.commitBond;
  const hasScenario = status?.scenario !== null && status?.scenario !== undefined;
  const isBusy = busy !== null;
  const testerAddressValid = testerAddress.trim() !== '' && testerAddressError === null;
  const walletControlDisabled = isBusy || !testerAddressValid;
  const hasAnyRevealedBid = Number(protocol?.runningCounts?.[1] ?? 0) > 0;
  const resultApplied = targetStage === 3;
  const canSeed = hasScenario && (targetStage === 0 || targetStage === 1);
  const now = status?.chain.timestamp ?? 0;
  const hasUnrevealedBond = activeAmount(bond?.amount) && status?.tester.revealed !== true;
  const bondClaimable = hasUnrevealedBond && timeReached(now, status?.tester.recoveryClaimableAt);
  const abandonedBondClaimable = hasUnrevealedBond && timeReached(now, status?.tester.abandonedBondClaimableAt);
  const hasActiveLock = activeAmount(lock?.lockedAmount) && lock?.status === 1;
  const refundClaimable = hasActiveLock && timeReached(now, status?.tester.escrowRecoveryClaimableAt);
  const wwd = protocol?.worldwideDay;
  const oracle = status?.oracle;
  const oracleAvailable = oracle?.available === true;
  const tryRate = oracle?.rates?.TRY ?? null;
  const tryObservationAge = tryRate?.[2] === undefined ? null : BigInt(now) - BigInt(tryRate[2]);
  const tryObservationOld = tryObservationAge !== null && tryObservationAge >= SEVEN_DAYS_SECONDS;

  return (
    <div className="dev-page">
      <header className="dev-header">
        <div>
          <span>LOCAL ANVIL · DEV ONLY</span>
          <h1>Auction control panel</h1>
          <p>Operator controls and authority-specific diagnostics are isolated from the bidder product.</p>
        </div>
        <div className="dev-header__links">
          {status?.scenario && <a href={`/auction/${status.scenario.worldwideDay}`}>Open auction</a>}
          <button type="button" onClick={onRefresh} disabled={isBusy || !testerAddressValid}>
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="dev-error" role="alert">
          {error}
        </div>
      )}
      {fundingMessage && (
        <div className="dev-success" role="status">
          {fundingMessage}
        </div>
      )}
      {busy && (
        <div className="dev-busy" role="status">
          Running {busy}…
        </div>
      )}

      <main className="dev-grid">
        <Panel eyebrow="Scenario setup" title="Fixture controls" className="dev-panel--controls dev-panel--compact">
          <div className="dev-control-list">
            <ControlButton label="Reset to Commit Open" command="reset" positive onRun={onRun} disabled={isBusy} />
            <ControlButton label="Seed Past Auctions" command="past-auctions" onRun={onRun} disabled={isBusy} />
            <ControlButton
              label="Announce Red Day · Cancel Series"
              command="red-day"
              danger
              onRun={onRun}
              disabled={isBusy}
            />
          </div>
          <p className="dev-note">
            Each action replaces the current local fixture. Resetting or replacing the fixture can erase funding for
            this wallet; fund the selected wallet again after reset.
          </p>
        </Panel>

        <Panel
          eyebrow="Auction lifecycle"
          title={targetStage === null ? 'No auction loaded' : (TARGET_STAGES[targetStage] ?? `Stage ${targetStage}`)}
          className="dev-panel--controls dev-panel--compact"
        >
          {targetStage === null && (
            <p className="dev-hint">Load a scenario to expose its valid lifecycle transition.</p>
          )}
          <div className="dev-control-list">
            {targetStage === 0 && (
              <ControlButton label="End Commit Stage" command="reveal" onRun={onRun} disabled={isBusy} />
            )}
            {targetStage === 1 && (
              <ControlButton
                label="Start Clearing · Move to Issuance"
                command="clearing"
                onRun={onRun}
                disabled={isBusy}
              />
            )}
            {targetStage === 2 && hasAnyRevealedBid && (
              <ControlButton
                label="Post Auction Result (Sale)"
                command="complete-sale"
                onRun={onRun}
                disabled={isBusy}
              />
            )}
            {targetStage === 2 && (
              <ControlButton label="Post Auction Result (No Sale)" command="no-sale" onRun={onRun} disabled={isBusy} />
            )}
          </div>
          {(targetStage === 3 || targetStage === 4) && (
            <p className="dev-empty dev-empty--inverse">This venue auction has no further target-stage transition.</p>
          )}
        </Panel>

        <Panel eyebrow="Bid simulation" title="Seeded bids" className="dev-panel--actions">
          {!canSeed && <p className="dev-empty">Seeded bids are available only during Commit or Reveal.</p>}
          {canSeed && (
            <div className="dev-control-list">
              <ControlButton
                label={targetStage === 1 ? 'Reveal Next Seeded Bid' : 'Submit Bid for Another Bidder'}
                command="seed-bid"
                onRun={onRun}
                disabled={isBusy}
              />
              <div className="dev-seed-row">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={seedCount}
                  aria-label={targetStage === 1 ? 'Number of bids to reveal' : 'Number of random bids'}
                  onChange={(event) => {
                    const value = Math.floor(Number(event.target.value));
                    onSeedCountChange(Number.isFinite(value) ? Math.max(1, Math.min(200, value)) : 1);
                  }}
                  disabled={isBusy}
                />
                <button
                  type="button"
                  className="dev-control"
                  disabled={isBusy}
                  onClick={() => onRun('seed-bids', seedCount)}
                >
                  {targetStage === 1 ? 'Reveal Seeded Bids' : 'Seed Random Bids'}
                  <span>→</span>
                </button>
              </div>
              <p className="dev-note dev-note--light">
                {targetStage === 1
                  ? 'Reveal the synthetic bids committed earlier so the ladder and revealed counter react.'
                  : 'Commit synthetic sealed bids so the sealed-bid counter reacts; reveal them during the next stage.'}
              </p>
            </div>
          )}
        </Panel>

        <Panel eyebrow="Oracle simulation" title="Live FX controls" className="dev-panel--controls dev-panel--oracle">
          {!hasScenario && <p className="dev-hint">Load a scenario to control its Oracle fixtures.</p>}
          {hasScenario && (
            <>
              <h3 className="dev-subheading">Price walk</h3>
              <div className="dev-control-list">
                {oracle?.walkRunning ? (
                  <ControlButton
                    label="Stop Price Walk"
                    command="oracle-walk-stop"
                    danger
                    onRun={onRun}
                    disabled={isBusy}
                  />
                ) : (
                  <ControlButton
                    label="Start Price Walk"
                    command="oracle-walk-start"
                    positive
                    onRun={onRun}
                    disabled={isBusy}
                  />
                )}
              </div>
              <p className="dev-note dev-note--light">
                {oracle?.walkRunning
                  ? 'COEN/USD price updates every 30 seconds with small random fluctuations.'
                  : 'Price walk is stopped. COEN price remains static until started.'}
              </p>

              {oracleAvailable && (
                <>
                  <h3 className="dev-subheading">Rate simulation</h3>
                  <div className="dev-control-list">
                    <ControlButton label="Increase USD rate" command="oracle-usd-up" onRun={onRun} disabled={isBusy} />
                    {tryRate !== null && (
                      <ControlButton
                        label="Increase TRY rate"
                        command="oracle-try-up"
                        onRun={onRun}
                        disabled={isBusy}
                      />
                    )}
                    <ControlButton label="Increase EUR rate" command="oracle-eur-up" onRun={onRun} disabled={isBusy} />
                    <ControlButton
                      label="Reset FX defaults"
                      command="oracle-defaults"
                      onRun={onRun}
                      disabled={isBusy}
                    />
                  </div>
                </>
              )}

              <h3 className="dev-subheading">Fault simulation</h3>
              <div className="dev-control-list">
                {oracleAvailable && tryRate !== null && !tryObservationOld && (
                  <ControlButton
                    label="Make TRY observation stale"
                    command="oracle-stale"
                    onRun={onRun}
                    disabled={isBusy}
                  />
                )}
                {oracleAvailable && tryRate !== null && (
                  <ControlButton
                    label="Deactivate TRY pair"
                    command="oracle-try-inactive"
                    onRun={onRun}
                    disabled={isBusy}
                  />
                )}
                {oracleAvailable ? (
                  <ControlButton
                    label="Oracle unavailable"
                    command="oracle-unavailable"
                    danger
                    onRun={onRun}
                    disabled={isBusy}
                  />
                ) : (
                  <ControlButton
                    label="Oracle available"
                    command="oracle-available"
                    positive
                    onRun={onRun}
                    disabled={isBusy}
                  />
                )}
              </div>

              {!oracleAvailable && (
                <p className="dev-diagnostic dev-diagnostic--danger">
                  Oracle reads are unavailable. Restore availability to inspect or change rates.
                </p>
              )}
              {oracleAvailable && tryRate === null && (
                <p className="dev-diagnostic">TRY pair cannot be read. Reset FX defaults to restore it.</p>
              )}
              {oracleAvailable && tryObservationOld && (
                <p className="dev-diagnostic">
                  TRY observation is {integer(tryObservationAge! / 86_400n)} days old. This describes the local fault
                  fixture, not a production validity rule.
                </p>
              )}
            </>
          )}
          <dl className="dev-fields dev-fields--inverse">
            {Object.entries(oracle?.rates ?? {}).map(([currency, value]) => (
              <Field key={currency} label={`COEN / ${currency}`}>
                {value ? `${token(value[0])} · block ${integer(value[1])} · ${timestamp(value[2])} UTC` : 'Unavailable'}
              </Field>
            ))}
          </dl>
        </Panel>

        <Panel eyebrow="Contract variables" title="Current chain state">
          <dl className="dev-fields">
            <Field label="Chain ID">{status?.chain.chainId ?? '—'}</Field>
            <Field label="Block">{integer(status?.chain.blockNumber)}</Field>
            <Field label="Block time">{timestamp(status?.chain.timestamp)} UTC</Field>
            <Field label="Scenario">{status?.scenario?.name ?? 'None'}</Field>
            <Field label="WorldwideDay">{status?.scenario?.worldwideDay ?? '—'}</Field>
            <Field label="Global stage">
              {globalStage === null ? 'Unavailable' : (GLOBAL_STAGES[globalStage] ?? globalStage)}
            </Field>
            <Field label="Target stage">
              {targetStage === null ? 'Unavailable' : (TARGET_STAGES[targetStage] ?? targetStage)}
            </Field>
            <Field label="Committed / revealed">
              {protocol?.runningCounts
                ? `${integer(protocol.runningCounts[0])} / ${integer(protocol.runningCounts[1])}`
                : 'Unavailable'}
            </Field>
          </dl>
        </Panel>

        <Panel eyebrow="Independent protocol outcomes" title="Result & delivery">
          <dl className="dev-fields">
            <Field label="Result">{resultApplied ? 'Applied at target' : 'Awaiting result'}</Field>
            <Field label="Issued intexes">{integer(protocol?.result?.issuedIntexCount)}</Field>
            <Field label="Winning bids">{integer(protocol?.result?.wonBidsCount)}</Field>
            <Field label="Clearing rate">{integer(protocol?.result?.auctionClearingRate)}</Field>
            <Field label="Canonical series">
              {protocol?.canonicalSeries ? `Series ${status?.scenario?.worldwideDay}` : 'No series evidence'}
            </Field>
            <Field label="Target series">
              {protocol?.targetSeriesIds.length
                ? protocol.targetSeriesIds.map(String).join(', ')
                : 'No series evidence'}
            </Field>
          </dl>
          <div className="dev-schedule">
            <strong>Authoritative schedule</strong>
            <span>Commit end · {timestamp(protocol?.schedule?.commitEnd)} UTC</span>
            <span>Reveal end · {timestamp(protocol?.schedule?.revealEnd)} UTC</span>
            <span>Issuance end · {timestamp(protocol?.schedule?.issuanceEnd)} UTC</span>
          </div>
        </Panel>

        <Panel eyebrow="Protocol evidence" title="Authority-specific diagnostics">
          <dl className="dev-fields">
            <Field label="WWD lifecycle">
              {wwd ? (WWD_STATUS[Number(wwd[0])] ?? `Status ${wwd[0]}`) : 'Unavailable'}
            </Field>
            <Field label="Day type">{wwd ? (DAY_TYPE[Number(wwd[1])] ?? `Type ${wwd[1]}`) : 'Unavailable'}</Field>
            <Field label="Escrow finalized">
              {protocol?.escrow ? (protocol.escrow[3] ? 'Yes' : 'No') : 'Unavailable'}
            </Field>
            <Field label="Escrow total locked">
              {protocol?.escrow ? integer(protocol.escrow[0] as JsonNumber) : 'Unavailable'}
            </Field>
            <Field label="Issuance instructions received">{protocol?.targetSeriesIds.length ? 'Yes' : 'No'}</Field>
            <Field label="Canonical lifecycle state">
              {protocol?.canonicalSeries
                ? (SERIES_STATE[Number(protocol.canonicalSeries.state)] ?? `State ${protocol.canonicalSeries.state}`)
                : 'Not available'}
            </Field>
          </dl>
          <details>
            <summary>Raw auction parameters</summary>
            <pre>{JSON.stringify(protocol?.parameters ?? null, null, 2)}</pre>
          </details>
        </Panel>

        <Panel eyebrow="Tester wallet" title="Bidder funds" className="dev-panel--actions">
          <label className="dev-wallet-field">
            <span>Tester wallet address</span>
            <input
              type="text"
              value={testerAddress}
              aria-invalid={testerAddressError !== null}
              aria-describedby={testerAddressError ? 'tester-wallet-error' : undefined}
              autoComplete="off"
              spellCheck={false}
              disabled={isBusy}
              onChange={(event) => onTesterAddressChange(event.target.value)}
            />
          </label>
          {testerAddressError && (
            <p id="tester-wallet-error" className="dev-wallet-error" role="alert">
              {testerAddressError}
            </p>
          )}
          <span className="dev-address-label">Currently inspected address</span>
          <code className="dev-address">{status?.tester.address ?? (testerAddressValid ? testerAddress : '—')}</code>
          <dl className="dev-fields">
            <Field label="Native balance">{status ? `${status.tester.native} COEN` : 'Unavailable'}</Field>
            <Field label="wCOEN balance">{status ? `${token(status.tester.wcoen)} wCOEN` : 'Unavailable'}</Field>
            <Field label="Escrow allowance">{status ? `${token(status.tester.allowance)} wCOEN` : 'Unavailable'}</Field>
            <Field label="Commit hash">
              <code title={status?.tester.commitHash}>{shortHash(status?.tester.commitHash)}</code>
            </Field>
            <Field label="Revealed">{status?.tester.revealed ? 'Yes' : 'No'}</Field>
            <Field label="Active bid lock">
              {lock ? `${integer(lock.lockedAmount)} minor · ${LOCK_STATES[lock.status] ?? lock.status}` : 'None'}
            </Field>
          </dl>
          {hasScenario && (
            <div className="dev-control-list dev-control-list--spaced">
              <ControlButton label="Fund wallet" command="fund" onRun={onRun} disabled={walletControlDisabled} />
            </div>
          )}
          <p className="dev-note dev-note--light">
            Funding sets local native COEN for gas and mints the deployed local wCOEN payment token. It never approves
            EscrowAdapter or submits bidder transactions.
          </p>
        </Panel>

        <Panel eyebrow="Wallet-specific" title="Bidder Recovery" className="dev-panel--actions">
          <dl className="dev-fields">
            <Field label="Commit bond">{bond ? `${integer(bond.amount)} minor` : 'None'}</Field>
            <Field label="Bond locked at">{bond?.lockedAt ? `${timestamp(bond.lockedAt)} UTC` : 'Not locked'}</Field>
            <Field label="No-reveal claim time">{timestamp(status?.tester.recoveryClaimableAt)}</Field>
            <Field label="Escrow refund claim time">{timestamp(status?.tester.escrowRecoveryClaimableAt)}</Field>
            <Field label="Failed refund">{lock ? integer(lock.failedRefund) : 'None'}</Field>
            <Field label="Split recorded">{lock ? String(lock.splitRecorded) : 'No'}</Field>
          </dl>
          <div className="dev-control-list dev-control-list--spaced">
            {hasUnrevealedBond && !bondClaimable && (
              <ControlButton
                label="Advance to No-Reveal Bond Claim Time"
                command="advance-bond"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
            {bondClaimable && (
              <ControlButton
                label="Claim No-Reveal Commit Bond (IntexAuction)"
                command="claim-bond"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
            {hasUnrevealedBond && status?.tester.abandonedBondClaimableAt && !abandonedBondClaimable && (
              <ControlButton
                label="Advance to Escrow Abandoned Bond Time"
                command="advance-abandoned-bond"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
            {abandonedBondClaimable && (
              <ControlButton
                label="Claim Abandoned Commit Bond (EscrowAdapter)"
                command="claim-abandoned-bond"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
            {hasActiveLock && status?.tester.escrowRecoveryClaimableAt && !refundClaimable && (
              <ControlButton
                label="Advance to Escrow Refund Time"
                command="advance-refund"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
            {refundClaimable && (
              <ControlButton
                label="Claim Escrow Refund (EscrowAdapter)"
                command="claim-refund"
                onRun={onRun}
                disabled={walletControlDisabled}
              />
            )}
          </div>
        </Panel>

        <Panel eyebrow="Current target balances" title="Portfolio" className="dev-panel--wide">
          {!protocol?.ownedTokenIds.length && (
            <p className="dev-empty">Inspected wallet has no current Intex balance.</p>
          )}
          {protocol?.ownedTokenIds.length ? (
            <table>
              <thead>
                <tr>
                  <th>Token ID</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {protocol.ownedTokenIds.map((id, index) => (
                  <tr key={String(id)}>
                    <td>
                      <code>{String(id)}</code>
                    </td>
                    <td>{integer(protocol.ownedBalances[index])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Panel>
      </main>
    </div>
  );
}
