import { getAddress, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { waitForTransactionConfirmation } from '../chain/transaction-confirmation';
import type { RecoveryItem, RecoveryPath } from './recovery-domain';

const STORAGE_PREFIX = 'itx-acn:recovery-attempt:v1:';
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export type RecoveryAttemptState = 'submitted' | 'replaced' | 'confirmed' | 'reverted' | 'dropped' | 'unknown';

export interface RecoveryAttemptStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RecoveryAttemptV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly recoveryItemKey: string;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly path: RecoveryPath;
  readonly worldwideDay: string;
  readonly bidder: string;
  readonly auctionContract: string;
  readonly escrowContract: string;
  readonly paymentToken: string;
  readonly paymentTokenDecimals?: number;
  readonly paymentTokenSymbol?: string;
  readonly custody: 'current' | 'historical';
  readonly expectedReturnedAmount: bigint;
  readonly expectedBurnedAmount: bigint;
  readonly transactionHash: Hash;
  readonly state: RecoveryAttemptState;
  readonly replacementAttemptId?: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly lastReconciliationError?: string;
}

export class RecoveryAttemptPersistenceError extends Error {
  readonly attempt: RecoveryAttemptV1;

  constructor(attempt: RecoveryAttemptV1, cause: unknown) {
    super(
      `Recovery transaction ${attempt.transactionHash} may already be submitted, but local transaction tracking could not be saved. The controls will use fresh contract state; this transaction may still settle or be replaced in your wallet. Storage error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'RecoveryAttemptPersistenceError';
    this.attempt = attempt;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIso = (value: unknown): value is string =>
  typeof value === 'string' && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

const asBigint = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an unsigned integer.`);
};

const PATHS = new Set<RecoveryPath>([
  'auction-commit-bond',
  'escrow-abandoned-commit-bond',
  'escrow-unfinalized-refund',
  'escrow-failed-split-refund',
  'escrow-no-split-refund',
]);
const STATES = new Set<RecoveryAttemptState>(['submitted', 'replaced', 'confirmed', 'reverted', 'dropped', 'unknown']);

export const validateRecoveryAttempt = (value: unknown): RecoveryAttemptV1 => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.length === 0 ||
    typeof value.recoveryItemKey !== 'string' ||
    value.recoveryItemKey.length === 0 ||
    typeof value.chainId !== 'number' ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    typeof value.deploymentId !== 'string' ||
    value.deploymentId.length === 0 ||
    !PATHS.has(value.path as RecoveryPath) ||
    typeof value.worldwideDay !== 'string' ||
    !/^\d{8}$/.test(value.worldwideDay) ||
    typeof value.bidder !== 'string' ||
    typeof value.auctionContract !== 'string' ||
    typeof value.escrowContract !== 'string' ||
    typeof value.paymentToken !== 'string' ||
    (value.paymentTokenDecimals !== undefined &&
      (typeof value.paymentTokenDecimals !== 'number' ||
        !Number.isInteger(value.paymentTokenDecimals) ||
        value.paymentTokenDecimals < 0 ||
        value.paymentTokenDecimals > 255)) ||
    (value.paymentTokenSymbol !== undefined &&
      (typeof value.paymentTokenSymbol !== 'string' || value.paymentTokenSymbol.trim().length === 0)) ||
    (value.custody !== 'current' && value.custody !== 'historical') ||
    typeof value.transactionHash !== 'string' ||
    !HASH_PATTERN.test(value.transactionHash) ||
    !STATES.has(value.state as RecoveryAttemptState) ||
    !isIso(value.submittedAt) ||
    !isIso(value.updatedAt) ||
    (value.replacementAttemptId !== undefined && typeof value.replacementAttemptId !== 'string') ||
    (value.lastReconciliationError !== undefined && typeof value.lastReconciliationError !== 'string')
  ) {
    throw new TypeError('Recovery transaction attempt is malformed.');
  }
  return {
    schemaVersion: 1,
    attemptId: value.attemptId,
    recoveryItemKey: value.recoveryItemKey,
    chainId: value.chainId,
    deploymentId: value.deploymentId,
    path: value.path as RecoveryPath,
    worldwideDay: value.worldwideDay,
    bidder: getAddress(value.bidder).toLowerCase(),
    auctionContract: getAddress(value.auctionContract).toLowerCase(),
    escrowContract: getAddress(value.escrowContract).toLowerCase(),
    paymentToken: getAddress(value.paymentToken).toLowerCase(),
    ...(value.paymentTokenDecimals === undefined ? {} : { paymentTokenDecimals: value.paymentTokenDecimals }),
    ...(value.paymentTokenSymbol === undefined ? {} : { paymentTokenSymbol: value.paymentTokenSymbol.trim() }),
    custody: value.custody,
    expectedReturnedAmount: asBigint(value.expectedReturnedAmount, 'Expected returned amount'),
    expectedBurnedAmount: asBigint(value.expectedBurnedAmount, 'Expected burned amount'),
    transactionHash: value.transactionHash.toLowerCase() as Hash,
    state: value.state as RecoveryAttemptState,
    ...(value.replacementAttemptId === undefined ? {} : { replacementAttemptId: value.replacementAttemptId }),
    submittedAt: value.submittedAt,
    updatedAt: value.updatedAt,
    ...(value.lastReconciliationError === undefined ? {} : { lastReconciliationError: value.lastReconciliationError }),
  };
};

const attemptId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createRecoveryAttempt = (input: {
  readonly item: RecoveryItem;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly transactionHash: Hash;
  readonly now: string;
}): RecoveryAttemptV1 =>
  validateRecoveryAttempt({
    schemaVersion: 1,
    attemptId: `recovery-${attemptId()}`,
    recoveryItemKey: input.item.key,
    chainId: input.chainId,
    deploymentId: input.deploymentId,
    path: input.item.path,
    worldwideDay: input.item.worldwideDay,
    bidder: input.item.bidder,
    auctionContract: input.item.auctionContract,
    escrowContract: input.item.escrowContract,
    paymentToken: input.item.paymentToken,
    paymentTokenDecimals: input.item.paymentTokenDecimals,
    paymentTokenSymbol: input.item.paymentTokenSymbol,
    custody: input.item.custody,
    expectedReturnedAmount: input.item.returnedAmount,
    expectedBurnedAmount: input.item.burnedAmount,
    transactionHash: input.transactionHash,
    state: 'submitted',
    submittedAt: input.now,
    updatedAt: input.now,
  });

const storageKey = (attemptIdValue: string): string => `${STORAGE_PREFIX}${encodeURIComponent(attemptIdValue)}`;

const serialize = (attempt: RecoveryAttemptV1): string =>
  JSON.stringify({
    ...attempt,
    expectedReturnedAmount: attempt.expectedReturnedAmount.toString(),
    expectedBurnedAmount: attempt.expectedBurnedAmount.toString(),
  });

export const saveRecoveryAttempt = (storage: RecoveryAttemptStorage, value: RecoveryAttemptV1): RecoveryAttemptV1 => {
  const attempt = validateRecoveryAttempt(value);
  const key = storageKey(attempt.attemptId);
  let existingRaw: string | null;
  try {
    existingRaw = storage.getItem(key);
  } catch (error) {
    throw new RecoveryAttemptPersistenceError(attempt, error);
  }
  if (existingRaw !== null) {
    const existing = validateRecoveryAttempt(JSON.parse(existingRaw));
    if (
      existing.recoveryItemKey !== attempt.recoveryItemKey ||
      existing.path !== attempt.path ||
      existing.submittedAt !== attempt.submittedAt ||
      existing.expectedReturnedAmount !== attempt.expectedReturnedAmount ||
      existing.expectedBurnedAmount !== attempt.expectedBurnedAmount ||
      existing.paymentTokenDecimals !== attempt.paymentTokenDecimals ||
      existing.paymentTokenSymbol !== attempt.paymentTokenSymbol ||
      existing.custody !== attempt.custody
    ) {
      throw new Error('Recovery attempt identity cannot be changed.');
    }
  }
  try {
    storage.setItem(key, serialize(attempt));
    const readBack = storage.getItem(key);
    if (readBack === null) throw new Error('Recovery attempt was not readable after write.');
    return validateRecoveryAttempt(JSON.parse(readBack));
  } catch (error) {
    throw new RecoveryAttemptPersistenceError(attempt, error);
  }
};

export const updateRecoveryAttempt = (
  storage: RecoveryAttemptStorage,
  attempt: RecoveryAttemptV1,
  state: RecoveryAttemptState,
  now: string,
  extra: Pick<RecoveryAttemptV1, 'replacementAttemptId' | 'lastReconciliationError'> = {},
): RecoveryAttemptV1 =>
  saveRecoveryAttempt(storage, {
    ...attempt,
    state,
    updatedAt: now,
    ...(extra.replacementAttemptId === undefined ? {} : { replacementAttemptId: extra.replacementAttemptId }),
    ...(extra.lastReconciliationError === undefined ? {} : { lastReconciliationError: extra.lastReconciliationError }),
  });

export const listRecoveryAttempts = (
  storage: RecoveryAttemptStorage,
  context?: { readonly chainId: number; readonly deploymentId: string; readonly bidder: string },
): readonly RecoveryAttemptV1[] => {
  const result: RecoveryAttemptV1[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(STORAGE_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const attempt = validateRecoveryAttempt(JSON.parse(raw));
    if (
      context &&
      (attempt.chainId !== context.chainId ||
        attempt.deploymentId !== context.deploymentId ||
        attempt.bidder !== context.bidder.toLowerCase())
    )
      continue;
    result.push(attempt);
  }
  return result.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
};

export const latestRecoveryAttempt = (
  attempts: readonly RecoveryAttemptV1[],
  recoveryItemKey: string,
): RecoveryAttemptV1 | null =>
  [...attempts]
    .filter((attempt) => attempt.recoveryItemKey === recoveryItemKey && attempt.replacementAttemptId === undefined)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1) ?? null;

export const waitForRecoveryAttempt = async (input: {
  readonly publicClient: PublicClient;
  readonly storage: RecoveryAttemptStorage;
  readonly initialAttempt: RecoveryAttemptV1;
  readonly confirmations: number;
  readonly now: () => string;
}): Promise<{ readonly receipt: TransactionReceipt; readonly attempt: RecoveryAttemptV1 }> =>
  waitForTransactionConfirmation({
    publicClient: input.publicClient,
    initialAttempt: input.initialAttempt,
    confirmations: input.confirmations,
    label: 'Recovery',
    now: input.now,
    adapter: {
      transactionHash: (attempt) => attempt.transactionHash,
      update: (attempt, state, now, error) =>
        updateRecoveryAttempt(
          input.storage,
          attempt,
          state,
          now,
          error === undefined ? {} : { lastReconciliationError: error },
        ),
      reprice: (attempt, replacementHash, replacementNow) => {
        const { replacementAttemptId: _replacement, lastReconciliationError: _error, ...identity } = attempt;
        const next = saveRecoveryAttempt(input.storage, {
          ...identity,
          attemptId: `recovery-${attemptId()}`,
          transactionHash: replacementHash,
          state: 'submitted',
          submittedAt: replacementNow,
          updatedAt: replacementNow,
        });
        updateRecoveryAttempt(input.storage, attempt, 'replaced', replacementNow, {
          replacementAttemptId: next.attemptId,
        });
        return next;
      },
    },
  });

export const persistRecoveryReconciliationError = (input: {
  readonly storage: RecoveryAttemptStorage;
  readonly attempt: RecoveryAttemptV1;
  readonly message: string;
  readonly now: string;
}): RecoveryAttemptV1 =>
  updateRecoveryAttempt(input.storage, input.attempt, 'confirmed', input.now, {
    lastReconciliationError: input.message,
  });
