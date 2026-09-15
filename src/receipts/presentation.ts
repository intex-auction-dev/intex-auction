import type { Hash } from 'viem';
import { SENSITIVE_RECEIPT_WARNING, type RevealMaterialV1 } from './reveal-material';
import {
  receiptMatchesContext,
  type ReceiptActiveContext,
  type TransactionAttemptKind,
  type TransactionAttemptState,
  type TransactionAttemptV1,
} from './receipt-store';

export interface ExplorerMetadata {
  readonly explorerUrl: string;
}

export interface ReceiptAttemptPresentation {
  readonly attemptId: string;
  readonly kind: TransactionAttemptKind;
  readonly transactionHash: Hash | null;
  readonly explorerUrl: string | null;
  readonly state: TransactionAttemptState;
  readonly replacementAttemptId: string | null;
}

export interface ReceiptPresentationModel {
  readonly sensitiveMaterialWarning: typeof SENSITIVE_RECEIPT_WARNING;
  readonly sealedBid: {
    readonly commitHash: Hash;
    readonly explorerUrl: null;
  };
  readonly wallet: RevealMaterialV1['bidder'];
  readonly chainId: number;
  readonly deploymentId: string;
  readonly auctionProxy: RevealMaterialV1['auctionProxy'];
  readonly worldwideDay: number;
  readonly quantity: number;
  readonly contractBidRate: number;
  readonly issuanceCurrency: number;
  readonly referenceCurrency: number;
  readonly commitBondMinor: bigint | null;
  readonly revealLockMinor: bigint | null;
  readonly currentRevealDeadline: bigint | null;
  readonly attempts: Readonly<Record<TransactionAttemptKind, readonly ReceiptAttemptPresentation[]>>;
  readonly transactionStatus: TransactionAttemptState | 'none';
  /** @deprecated legacy commit-panel read only; no runtime producer or persistence authority remains. */
  readonly backupStatus?: 'failed';
}

const explorerTransactionUrl = (hash: Hash, metadata?: ExplorerMetadata): string | null => {
  if (metadata === undefined) return null;
  try {
    const base = new URL(metadata.explorerUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
    const normalized = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`;
    return new URL(`tx/${hash}`, normalized).toString();
  } catch {
    return null;
  }
};

export const createReceiptPresentation = (input: {
  readonly material: RevealMaterialV1;
  readonly attempts: readonly TransactionAttemptV1[];
  readonly explorer?: ExplorerMetadata;
  readonly commitBondMinor?: bigint;
  readonly revealLockMinor?: bigint;
  readonly currentRevealDeadline?: bigint;
}): ReceiptPresentationModel => {
  const byKind: Record<TransactionAttemptKind, ReceiptAttemptPresentation[]> = {
    approval: [],
    commit: [],
    cancellation: [],
    recommit: [],
    reveal: [],
  };
  const sorted = [...input.attempts].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  for (const attempt of sorted) {
    byKind[attempt.kind].push({
      attemptId: attempt.attemptId,
      kind: attempt.kind,
      transactionHash: attempt.transactionHash ?? null,
      explorerUrl:
        attempt.transactionHash === undefined ? null : explorerTransactionUrl(attempt.transactionHash, input.explorer),
      state: attempt.state,
      replacementAttemptId: attempt.replacementAttemptId ?? null,
    });
  }
  return {
    sensitiveMaterialWarning: SENSITIVE_RECEIPT_WARNING,
    sealedBid: { commitHash: input.material.commitHash, explorerUrl: null },
    wallet: input.material.bidder,
    chainId: input.material.chainId,
    deploymentId: input.material.deploymentId,
    auctionProxy: input.material.auctionProxy,
    worldwideDay: input.material.worldwideDay,
    quantity: input.material.quantity,
    contractBidRate: input.material.bidRate,
    issuanceCurrency: input.material.issuanceCurrency,
    referenceCurrency: input.material.referenceCurrency,
    commitBondMinor: input.commitBondMinor ?? null,
    revealLockMinor: input.revealLockMinor ?? null,
    currentRevealDeadline: input.currentRevealDeadline ?? null,
    attempts: byKind,
    transactionStatus: sorted.at(-1)?.state ?? 'none',
  };
};

export interface ApplicableRevealMaterial {
  readonly key: string;
  readonly material: RevealMaterialV1;
}

export type LocalReceiptMatch =
  | { readonly state: 'no-live-commitment'; readonly severity: 'none' }
  | { readonly state: 'matching-actionable-receipt'; readonly severity: 'none'; readonly key: string }
  | { readonly state: 'matching-inactive-receipt'; readonly severity: 'warning'; readonly key: string }
  | {
      readonly state: 'missing-local-receipt';
      readonly severity: 'critical';
      readonly canRegenerateSignature: false;
      readonly message: string;
    };

const ZERO_HASH = `0x${'0'.repeat(64)}`;

export const deriveLocalReceiptMatch = (input: {
  readonly liveCommitHash: Hash | null;
  readonly records: readonly ApplicableRevealMaterial[];
  readonly activeContext: ReceiptActiveContext;
}): LocalReceiptMatch => {
  if (input.liveCommitHash === null || input.liveCommitHash.toLowerCase() === ZERO_HASH) {
    return { state: 'no-live-commitment', severity: 'none' };
  }
  const matches = input.records.filter(
    ({ material }) => material.commitHash.toLowerCase() === input.liveCommitHash!.toLowerCase(),
  );
  const actionable = matches.find(({ material }) => receiptMatchesContext(material, input.activeContext));
  if (actionable !== undefined) {
    return { state: 'matching-actionable-receipt', severity: 'none', key: actionable.key };
  }
  if (matches[0] !== undefined) {
    return { state: 'matching-inactive-receipt', severity: 'warning', key: matches[0].key };
  }
  return {
    state: 'missing-local-receipt',
    severity: 'critical',
    canRegenerateSignature: false,
    message:
      'The live commitment has no matching local reveal material. The exact signature cannot be regenerated safely; import the original receipt backup.',
  };
};
