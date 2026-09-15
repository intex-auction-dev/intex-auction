import type { Hash, PublicClient, TransactionReceipt } from 'viem';
import { waitForTransactionConfirmation } from '../chain/transaction-confirmation';
import { emitDiagnostic } from '../diagnostics/local-diagnostics';
import {
  saveTransactionAttempt,
  type ReceiptStorage,
  type TransactionAttemptKind,
  type TransactionAttemptState,
  type TransactionAttemptV1,
} from '../receipts/receipt-store';

const attemptId = (kind: TransactionAttemptKind): string => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind}-${random}`;
};

const journalAttempt = (attempt: TransactionAttemptV1): void => {
  emitDiagnostic({
    category: 'transaction',
    event: 'state',
    kind: attempt.kind,
    state: attempt.state,
    transactionHash: attempt.transactionHash ?? null,
  });
};

export const createTransactionAttempt = (input: {
  readonly kind: TransactionAttemptKind;
  readonly revealMaterialKey: string;
  readonly transactionHash: Hash;
  readonly now: string;
}): TransactionAttemptV1 => {
  const attempt: TransactionAttemptV1 = {
    schemaVersion: 1,
    attemptId: attemptId(input.kind),
    revealMaterialKey: input.revealMaterialKey,
    kind: input.kind,
    transactionHash: input.transactionHash,
    state: 'submitted',
    submittedAt: input.now,
    updatedAt: input.now,
  };
  journalAttempt(attempt);
  return attempt;
};

export const updateTransactionAttempt = (
  storage: ReceiptStorage,
  attempt: TransactionAttemptV1,
  state: TransactionAttemptState,
  now: string,
  extra: Pick<TransactionAttemptV1, 'replacementAttemptId' | 'lastReconciliationError'> = {},
): TransactionAttemptV1 => {
  const saved = saveTransactionAttempt(storage, {
    ...attempt,
    state,
    updatedAt: now,
    ...(extra.replacementAttemptId === undefined ? {} : { replacementAttemptId: extra.replacementAttemptId }),
    ...(extra.lastReconciliationError === undefined ? {} : { lastReconciliationError: extra.lastReconciliationError }),
  });
  journalAttempt(saved);
  return saved;
};

export const waitForTransactionAttempt = async (input: {
  readonly publicClient: PublicClient;
  readonly storage: ReceiptStorage;
  readonly initialAttempt: TransactionAttemptV1;
  readonly confirmations: number;
  readonly label: string;
  readonly now: () => string;
}): Promise<{ readonly receipt: TransactionReceipt; readonly attempt: TransactionAttemptV1 }> =>
  waitForTransactionConfirmation({
    publicClient: input.publicClient,
    initialAttempt: input.initialAttempt,
    confirmations: input.confirmations,
    label: input.label,
    now: input.now,
    adapter: {
      transactionHash: (attempt) => {
        if (attempt.transactionHash === undefined) {
          throw new Error('Transaction attempt has no transaction hash.');
        }
        return attempt.transactionHash;
      },
      update: (attempt, state, now, error) =>
        updateTransactionAttempt(
          input.storage,
          attempt,
          state,
          now,
          error === undefined ? {} : { lastReconciliationError: error },
        ),
      reprice: (attempt, replacementHash, replacementNow) => {
        const next = saveTransactionAttempt(
          input.storage,
          createTransactionAttempt({
            kind: attempt.kind,
            revealMaterialKey: attempt.revealMaterialKey,
            transactionHash: replacementHash,
            now: replacementNow,
          }),
        );
        updateTransactionAttempt(input.storage, attempt, 'replaced', replacementNow, {
          replacementAttemptId: next.attemptId,
        });
        return next;
      },
    },
  });

export const persistTransactionReconciliationError = (input: {
  readonly storage: ReceiptStorage;
  readonly attempt: TransactionAttemptV1;
  readonly message: string;
  readonly now: string;
  readonly kind?: 'contract-mismatch' | 'transient-read-failure';
}): TransactionAttemptV1 => {
  if (input.kind !== 'contract-mismatch') {
    return updateTransactionAttempt(input.storage, input.attempt, 'confirmed', input.now);
  }
  const saved = saveTransactionAttempt(input.storage, {
    ...input.attempt,
    state: 'confirmed',
    updatedAt: input.now,
    lastReconciliationError: input.message,
    reconciliationErrorKind: 'contract-mismatch',
  });
  journalAttempt(saved);
  return saved;
};
