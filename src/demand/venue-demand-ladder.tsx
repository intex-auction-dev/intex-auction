import { Badge, Card } from '../ui/primitives';
import { intexUnit } from '../ui/display-format';
import { ladderPromisSummary, type VenueDemandModel, type VenueLadderOutcome } from './venue-demand-model';
import { DemandCurve } from './venue-demand-ladder/demand-curve';
import './venue-demand-ladder.css';

export {
  buildBidRateAxis,
  buildDisplaySegments,
  buildLadderBidDetail,
  ladderDetailText,
  resolveLadderLabelOverlaps,
} from './venue-demand-model';
export type { LadderDetailRow, LadderLabelRect, VenueLadderOutcome } from './venue-demand-model';

export type VenueLadderViewState =
  | { kind: 'loading' }
  | {
      kind: 'loaded';
      model: VenueDemandModel;
      outcome?: VenueLadderOutcome;
      warning?: string;
      explorerUrl?: string | null;
    }
  | { kind: 'failure'; message: string }
  | {
      kind: 'unavailable';
      reason: 'no-venue-auction' | 'delivery-pending' | 'venue-skipped' | 'not-applicable' | 'unsupported-chain';
    };

const unavailableCopy: Record<Extract<VenueLadderViewState, { kind: 'unavailable' }>['reason'], string> = {
  'no-venue-auction': 'No active-venue auction record exists for this WorldwideDay.',
  'delivery-pending': 'Origin evidence says the auction is applicable, but the active venue has not received it yet.',
  'venue-skipped': 'The active venue was explicitly skipped and has no participating demand ladder.',
  'not-applicable': 'This WorldwideDay has no applicable active-venue auction.',
  'unsupported-chain': 'The connected wallet network is unsupported, so no active-venue demand is loaded.',
};

function LadderHeader({ title, subtitle, trailing }: { title: string; subtitle: string; trailing?: React.ReactNode }) {
  return (
    <div className="ladder-heading">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {trailing}
    </div>
  );
}

export function VenueDemandLadder({ state }: { state: VenueLadderViewState }) {
  if (state.kind === 'loading')
    return (
      <Card className="venue-demand-card">
        <p className="product-empty-state">Loading revealed bids…</p>
      </Card>
    );
  if (state.kind === 'failure') {
    return (
      <Card className="venue-demand-card venue-demand-card--failure" aria-labelledby="venue-demand-failure-title">
        <LadderHeader
          title="Revealed Bids"
          subtitle="Cumulative Promis Demand"
          trailing={<Badge tone="danger">Ladder only</Badge>}
        />
        <p className="product-empty-state" id="venue-demand-failure-title">
          {state.message}
        </p>
      </Card>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <Card className="venue-demand-card" aria-labelledby="venue-demand-unavailable-title">
        <LadderHeader title="Revealed Bids" subtitle="Cumulative Promis Demand" trailing={<Badge>Unavailable</Badge>} />
        <p className="product-empty-state" id="venue-demand-unavailable-title">
          {unavailableCopy[state.reason]}
        </p>
      </Card>
    );
  }

  const { model, outcome } = state;
  const title = model.stage === 'revealing-bids' ? 'Revealed Bids' : 'Final Bid Ladder';
  const subtitle =
    model.stage === 'revealing-bids'
      ? 'Live revealed demand'
      : model.stage === 'issuance'
        ? 'Clearing in progress · final allocation pending'
        : 'public record · sorted by % of escrow basis';
  const cumulativeQuantity = model.rows.at(-1)?.cumulativeQuantity ?? 0;
  const finalOutcome = model.authoritativeClearingRate !== null ? outcome : undefined;
  const summary = finalOutcome
    ? `${cumulativeQuantity} ${intexUnit(cumulativeQuantity)} demand · ${finalOutcome.supply} ${intexUnit(finalOutcome.supply)} supply (${ladderPromisSummary(finalOutcome.loadedPromis)} Promis)`
    : `${cumulativeQuantity} ${intexUnit(cumulativeQuantity)} demand`;
  return (
    <Card className="venue-demand-card" aria-labelledby="venue-demand-title">
      <LadderHeader
        title={title}
        subtitle={subtitle}
        trailing={model.rows.length > 0 ? <Badge>{summary}</Badge> : undefined}
      />
      {state.warning && (
        <p className="component-warning" role="status">
          Latest confirmed ladder retained while refresh failed: {state.warning}
        </p>
      )}
      {model.rows.length > 0 ? (
        <DemandCurve
          model={model}
          explorerUrl={state.explorerUrl ?? null}
          {...(finalOutcome === undefined ? {} : { outcome: finalOutcome })}
        />
      ) : (
        <p className="product-empty-state">No revealed bids yet</p>
      )}
    </Card>
  );
}
