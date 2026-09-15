import { getAddress, type Address, type Hash } from 'viem';
import { namespaceKey } from '../persistence/namespace-key';
import {
  ReceiptValidationError,
  type AuthoritativeRevealParameters,
  type RevealMaterialV1,
  validateRevealMaterial,
} from './reveal-material';

export type ReceiptStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export const RECEIPT_STORAGE_PREFIX = 'itx-acn:reveal-material:v1:';
const ATTEMPT_STORAGE_PREFIX = 'itx-acn:transaction-attempt:v1:';
const OBSOLETE_RECEIPT_PREFIXES = ['itx-acn:receipt-import-audit:v1:', 'itx-acn:receipt-backup:v1:'] as const;

export interface ReceiptSourceV1 {
  readonly kind: 'generated' | 'imported' | 'migrated';
  readonly capturedAt: string;
  readonly sourceSchemaVersion: number | null;
}

export interface StoredRevealMaterialV1 {
  readonly storageSchemaVersion: 1;
  readonly material: RevealMaterialV1;
  readonly source: ReceiptSourceV1;
}

export type PersistRevealMaterialResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly stored: StoredRevealMaterialV1;
      readonly disposition: 'stored' | 'existing';
    }
  | {
      readonly ok: false;
      readonly stage: 'validation' | 'serialization' | 'write' | 'read-back' | 'read-back-validation';
      readonly code: string;
      readonly message: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isIsoTime = (value: unknown): value is string =>
  typeof value === 'string' && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

const storageError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const activePersistKeys = new Set<string>();

// The output of this function is a compatibility surface: reveal material is the one
// record that cannot be rebuilt from chain logs, so the derived key must never change.
// tests/unit/src/receipts/receipt-store.test.ts pins it against a literal.
export const revealMaterialStorageKey = (material: RevealMaterialV1): string =>
  namespaceKey({
    prefix: 'itx-acn:reveal-material',
    version: 1,
    chainId: material.chainId,
    deploymentId: material.deploymentId,
    contract: material.auctionProxy,
    wallet: material.bidder,
    segments: [material.worldwideDay.toString(), material.commitHash.toLowerCase()],
  });

const parseSource = (value: unknown): ReceiptSourceV1 => {
  if (
    !isRecord(value) ||
    (value.kind !== 'generated' && value.kind !== 'imported' && value.kind !== 'migrated') ||
    !isIsoTime(value.capturedAt) ||
    (value.sourceSchemaVersion !== null &&
      (typeof value.sourceSchemaVersion !== 'number' ||
        !Number.isSafeInteger(value.sourceSchemaVersion) ||
        value.sourceSchemaVersion < 0))
  ) {
    throw new ReceiptValidationError('schema-failure', 'Stored receipt source metadata is malformed.');
  }
  return {
    kind: value.kind,
    capturedAt: value.capturedAt,
    sourceSchemaVersion: value.sourceSchemaVersion,
  };
};

export const parseStoredRevealMaterial = async (
  value: unknown,
  authoritativeParameters?: AuthoritativeRevealParameters,
): Promise<StoredRevealMaterialV1> => {
  if (!isRecord(value) || value.storageSchemaVersion !== 1) {
    throw new ReceiptValidationError('schema-failure', 'Stored receipt envelope version is unsupported.');
  }
  const material = await validateRevealMaterial(value.material, authoritativeParameters);
  return Object.freeze({
    storageSchemaVersion: 1,
    material,
    source: Object.freeze(parseSource(value.source)),
  });
};

const sameImmutableMaterial = (left: RevealMaterialV1, right: RevealMaterialV1): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.adapterProfile === right.adapterProfile &&
  left.deploymentId === right.deploymentId &&
  left.chainId === right.chainId &&
  left.auctionProxy.toLowerCase() === right.auctionProxy.toLowerCase() &&
  left.bidder.toLowerCase() === right.bidder.toLowerCase() &&
  left.worldwideDay === right.worldwideDay &&
  left.quantity === right.quantity &&
  left.bidRate === right.bidRate &&
  left.signature.toLowerCase() === right.signature.toLowerCase() &&
  left.commitHash.toLowerCase() === right.commitHash.toLowerCase();

const validateExisting = async (
  raw: string,
  key: string,
  material: RevealMaterialV1,
  authoritativeParameters?: AuthoritativeRevealParameters,
): Promise<StoredRevealMaterialV1> => {
  const stored = await parseStoredRevealMaterial(JSON.parse(raw), authoritativeParameters);
  if (revealMaterialStorageKey(stored.material) !== key) {
    throw new ReceiptValidationError(
      'checksum-consistency-failure',
      'Stored receipt namespace does not match its material.',
    );
  }
  if (!sameImmutableMaterial(stored.material, material)) {
    throw new ReceiptValidationError(
      'checksum-consistency-failure',
      'An existing receipt conflicts with the immutable reveal material.',
    );
  }
  return stored;
};

export const persistRevealMaterial = async (input: {
  readonly storage: ReceiptStorage;
  readonly material: unknown;
  readonly source?: ReceiptSourceV1;
  readonly authoritativeParameters?: AuthoritativeRevealParameters;
}): Promise<PersistRevealMaterialResult> => {
  let material: RevealMaterialV1;
  try {
    material = await validateRevealMaterial(input.material, input.authoritativeParameters);
  } catch (error) {
    return {
      ok: false,
      stage: 'validation',
      code: error instanceof ReceiptValidationError ? error.code : 'validation-failure',
      message: storageError(error),
    };
  }

  const key = revealMaterialStorageKey(material);
  if (activePersistKeys.has(key)) {
    return {
      ok: false,
      stage: 'write',
      code: 'storage-write-in-progress',
      message: 'Reveal material is already being persisted in this application context.',
    };
  }
  activePersistKeys.add(key);

  try {
    const source = input.source ?? {
      kind: 'generated',
      capturedAt: material.metadata.createdAt,
      sourceSchemaVersion: material.schemaVersion,
    };
    const envelope: StoredRevealMaterialV1 = {
      storageSchemaVersion: 1,
      material,
      source: {
        kind: source.kind,
        capturedAt: source.capturedAt,
        sourceSchemaVersion: source.sourceSchemaVersion,
      },
    };

    let existingRaw: string | null;
    try {
      existingRaw = input.storage.getItem(key);
    } catch (error) {
      return { ok: false, stage: 'read-back', code: 'storage-read-failure', message: storageError(error) };
    }
    if (existingRaw !== null) {
      try {
        return {
          ok: true,
          key,
          stored: await validateExisting(existingRaw, key, material, input.authoritativeParameters),
          disposition: 'existing',
        };
      } catch (error) {
        return {
          ok: false,
          stage: 'read-back-validation',
          code: error instanceof ReceiptValidationError ? error.code : 'storage-consistency-failure',
          message: storageError(error),
        };
      }
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      return { ok: false, stage: 'serialization', code: 'serialization-failure', message: storageError(error) };
    }

    try {
      const lateExisting = input.storage.getItem(key);
      if (lateExisting !== null) {
        return {
          ok: true,
          key,
          stored: await validateExisting(lateExisting, key, material, input.authoritativeParameters),
          disposition: 'existing',
        };
      }
      input.storage.setItem(key, serialized);
    } catch (error) {
      return {
        ok: false,
        stage: error instanceof ReceiptValidationError ? 'read-back-validation' : 'write',
        code: error instanceof ReceiptValidationError ? error.code : 'storage-write-failure',
        message: storageError(error),
      };
    }

    let readBack: string | null;
    try {
      readBack = input.storage.getItem(key);
    } catch (error) {
      try {
        input.storage.removeItem(key);
      } catch {
        /* best-effort cleanup of this new write */
      }
      return { ok: false, stage: 'read-back', code: 'storage-read-failure', message: storageError(error) };
    }
    if (readBack === null) {
      try {
        input.storage.removeItem(key);
      } catch {
        /* best-effort cleanup of this new write */
      }
      return {
        ok: false,
        stage: 'read-back',
        code: 'storage-read-failure',
        message: 'Stored receipt was not readable.',
      };
    }

    try {
      return {
        ok: true,
        key,
        stored: await validateExisting(readBack, key, material, input.authoritativeParameters),
        disposition: readBack === serialized ? 'stored' : 'existing',
      };
    } catch (error) {
      try {
        input.storage.removeItem(key);
      } catch {
        /* best-effort cleanup of this new write */
      }
      return {
        ok: false,
        stage: 'read-back-validation',
        code: error instanceof ReceiptValidationError ? error.code : 'storage-consistency-failure',
        message: storageError(error),
      };
    }
  } finally {
    activePersistKeys.delete(key);
  }
};

export const loadStoredRevealMaterial = async (
  storage: ReceiptStorage,
  key: string,
): Promise<StoredRevealMaterialV1 | null> => {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const stored = await parseStoredRevealMaterial(JSON.parse(raw));
  if (revealMaterialStorageKey(stored.material) !== key) {
    throw new ReceiptValidationError('checksum-consistency-failure', 'Stored receipt key does not match its material.');
  }
  return stored;
};

export const listStoredRevealMaterials = async (
  storage: ReceiptStorage,
): Promise<readonly { readonly key: string; readonly stored: StoredRevealMaterialV1 }[]> => {
  const result: { key: string; stored: StoredRevealMaterialV1 }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(RECEIPT_STORAGE_PREFIX)) continue;
    const stored = await loadStoredRevealMaterial(storage, key);
    if (stored !== null) result.push({ key, stored });
  }
  return result;
};

export const removeObsoleteReceiptMetadata = (storage: ReceiptStorage): void => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && OBSOLETE_RECEIPT_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
  }
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Legacy cleanup is best-effort and must never block receipt access or transaction safety.
    }
  }
};

export type TransactionAttemptKind = 'approval' | 'commit' | 'cancellation' | 'recommit' | 'reveal';
export type TransactionAttemptState = 'submitted' | 'replaced' | 'confirmed' | 'reverted' | 'dropped' | 'unknown';

export interface TransactionAttemptV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly revealMaterialKey: string;
  readonly kind: TransactionAttemptKind;
  readonly transactionHash?: Hash;
  readonly state: TransactionAttemptState;
  readonly replacementAttemptId?: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly lastReconciliationError?: string;
  readonly reconciliationErrorKind?: 'contract-mismatch';
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ATTEMPT_KINDS = new Set<TransactionAttemptKind>(['approval', 'commit', 'cancellation', 'recommit', 'reveal']);
const ATTEMPT_STATES = new Set<TransactionAttemptState>([
  'submitted',
  'replaced',
  'confirmed',
  'reverted',
  'dropped',
  'unknown',
]);

export const validateTransactionAttempt = (value: unknown): TransactionAttemptV1 => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.length === 0 ||
    typeof value.revealMaterialKey !== 'string' ||
    !value.revealMaterialKey.startsWith(RECEIPT_STORAGE_PREFIX) ||
    !ATTEMPT_KINDS.has(value.kind as TransactionAttemptKind) ||
    !ATTEMPT_STATES.has(value.state as TransactionAttemptState) ||
    !isIsoTime(value.submittedAt) ||
    !isIsoTime(value.updatedAt)
  ) {
    throw new TypeError('Transaction attempt is malformed.');
  }
  const transactionHash =
    value.transactionHash === undefined
      ? undefined
      : typeof value.transactionHash === 'string' && HASH_PATTERN.test(value.transactionHash)
        ? (value.transactionHash.toLowerCase() as Hash)
        : null;
  if (transactionHash === null) throw new TypeError('Transaction hash is malformed.');
  if (value.replacementAttemptId !== undefined && typeof value.replacementAttemptId !== 'string') {
    throw new TypeError('Replacement attempt ID is malformed.');
  }
  if (value.lastReconciliationError !== undefined && typeof value.lastReconciliationError !== 'string') {
    throw new TypeError('Reconciliation error is malformed.');
  }
  if (value.reconciliationErrorKind !== undefined && value.reconciliationErrorKind !== 'contract-mismatch') {
    throw new TypeError('Reconciliation error kind is malformed.');
  }
  const state = value.state as TransactionAttemptState;
  const lastReconciliationError =
    typeof value.lastReconciliationError === 'string' ? value.lastReconciliationError : null;
  const keepReconciliationError =
    lastReconciliationError !== null &&
    (state !== 'confirmed' || value.reconciliationErrorKind === 'contract-mismatch');
  return {
    schemaVersion: 1,
    attemptId: value.attemptId,
    revealMaterialKey: value.revealMaterialKey,
    kind: value.kind as TransactionAttemptKind,
    ...(transactionHash === undefined ? {} : { transactionHash }),
    state,
    ...(value.replacementAttemptId === undefined ? {} : { replacementAttemptId: value.replacementAttemptId }),
    submittedAt: value.submittedAt,
    updatedAt: value.updatedAt,
    ...(keepReconciliationError ? { lastReconciliationError } : {}),
    ...(keepReconciliationError && value.reconciliationErrorKind === 'contract-mismatch'
      ? { reconciliationErrorKind: value.reconciliationErrorKind }
      : {}),
  };
};

const attemptKey = (attemptId: string): string => `${ATTEMPT_STORAGE_PREFIX}${encodeURIComponent(attemptId)}`;

const saveTransactionAttemptUnchecked = (
  storage: ReceiptStorage,
  value: TransactionAttemptV1,
): TransactionAttemptV1 => {
  const attempt = validateTransactionAttempt(value);
  if (storage.getItem(attempt.revealMaterialKey) === null) {
    throw new Error('Transaction attempt must reference an existing reveal-material record.');
  }
  const key = attemptKey(attempt.attemptId);
  const existingRaw = storage.getItem(key);
  if (existingRaw !== null) {
    const existing = validateTransactionAttempt(JSON.parse(existingRaw));
    if (
      existing.revealMaterialKey !== attempt.revealMaterialKey ||
      existing.kind !== attempt.kind ||
      existing.submittedAt !== attempt.submittedAt
    ) {
      throw new Error('Transaction attempt identity cannot be changed.');
    }
  }
  storage.setItem(key, JSON.stringify(attempt));
  const readBack = storage.getItem(key);
  if (readBack === null) throw new Error('Transaction attempt was not readable after write.');
  return validateTransactionAttempt(JSON.parse(readBack));
};

const listTransactionAttemptsUnchecked = (
  storage: ReceiptStorage,
  revealMaterialKey: string,
): readonly TransactionAttemptV1[] => {
  const result: TransactionAttemptV1[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(ATTEMPT_STORAGE_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const attempt = validateTransactionAttempt(JSON.parse(raw));
    if (attempt.revealMaterialKey === revealMaterialKey) result.push(attempt);
  }
  return result.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
};

export class TransactionAttemptPersistenceError extends Error {
  readonly attempt: TransactionAttemptV1;

  constructor(attempt: TransactionAttemptV1, cause: unknown) {
    const hash = attempt.transactionHash ?? 'unknown hash';
    super(
      `Transaction ${hash} may already be submitted, but local transaction tracking could not be saved. The controls will use fresh contract state; this transaction may still settle or be replaced in your wallet. Storage error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'TransactionAttemptPersistenceError';
    this.attempt = attempt;
  }
}

export const saveTransactionAttempt = (storage: ReceiptStorage, value: TransactionAttemptV1): TransactionAttemptV1 => {
  const attempt = validateTransactionAttempt(value);
  try {
    return saveTransactionAttemptUnchecked(storage, attempt);
  } catch (error) {
    throw new TransactionAttemptPersistenceError(attempt, error);
  }
};

export const listTransactionAttempts = (
  storage: ReceiptStorage,
  revealMaterialKey: string,
): readonly TransactionAttemptV1[] => {
  try {
    return listTransactionAttemptsUnchecked(storage, revealMaterialKey);
  } catch {
    return [];
  }
};

export interface ReceiptActiveContext {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly auctionProxy: Address;
  readonly bidder: Address;
}

export const receiptMatchesContext = (material: RevealMaterialV1, context: ReceiptActiveContext): boolean =>
  material.chainId === context.chainId &&
  material.deploymentId === context.deploymentId &&
  getAddress(material.auctionProxy) === getAddress(context.auctionProxy) &&
  getAddress(material.bidder) === getAddress(context.bidder);
