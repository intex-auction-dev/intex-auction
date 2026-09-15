import {
  SENSITIVE_RECEIPT_WARNING,
  ReceiptValidationError,
  type RevealMaterialV1,
  validateRevealMaterial,
} from './reveal-material';
import {
  listStoredRevealMaterials,
  loadStoredRevealMaterial,
  parseStoredRevealMaterial,
  persistRevealMaterial,
  receiptMatchesContext,
  removeObsoleteReceiptMetadata,
  type ReceiptActiveContext,
  type ReceiptSourceV1,
  type ReceiptStorage,
} from './receipt-store';

export const RECEIPT_BACKUP_SCHEMA_VERSION = 2 as const;
const LEGACY_RECEIPT_EXPORT_SCHEMA_VERSION = 1 as const;
export const MAX_RECEIPT_IMPORT_FILES = 32;
export const MAX_RECEIPT_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPTS_PER_BACKUP = 256;

export interface ReceiptBackupBundleV2 {
  readonly backupSchemaVersion: typeof RECEIPT_BACKUP_SCHEMA_VERSION;
  readonly warning: typeof SENSITIVE_RECEIPT_WARNING;
  readonly exportedAt: string;
  readonly receipts: readonly RevealMaterialV1[];
}

export type ReceiptImportOutcome =
  | 'imported'
  | 'duplicate'
  | 'valid-inactive-context'
  | 'schema-failure'
  | 'checksum-consistency-failure'
  | 'invalid-signature-or-signer'
  | 'domain-mismatch'
  | 'commit-hash-mismatch'
  | 'unsupported-profile';

export interface ReceiptImportItemResult {
  readonly outcome: ReceiptImportOutcome;
  readonly key?: string;
  readonly message: string;
}

export interface ReceiptFileImportResult {
  readonly fileName: string;
  readonly outcome: ReceiptImportOutcome | 'mixed';
  readonly items: readonly ReceiptImportItemResult[];
  readonly auditRetained: false;
}

export interface ReceiptInputFile {
  readonly name: string;
  readonly size?: number;
  text(): Promise<string>;
}

export type ReceiptDownload = (
  fileName: string,
  contents: string,
  mediaType: 'application/json',
) => void | Promise<void>;

const importFailure = (fileName: string, message: string): ReceiptFileImportResult => ({
  fileName,
  outcome: 'schema-failure',
  items: [{ outcome: 'schema-failure', message }],
  auditRetained: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const requireIsoTimestamp = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ReceiptValidationError('schema-failure', `${label} is invalid.`);
  }
  return value;
};

const backupBundle = (receipts: readonly RevealMaterialV1[], exportedAt: string): ReceiptBackupBundleV2 => ({
  backupSchemaVersion: RECEIPT_BACKUP_SCHEMA_VERSION,
  warning: SENSITIVE_RECEIPT_WARNING,
  exportedAt: requireIsoTimestamp(exportedAt, 'Export timestamp'),
  receipts,
});

export const exportOneReceipt = async (storage: ReceiptStorage, key: string, exportedAt: string): Promise<string> => {
  removeObsoleteReceiptMetadata(storage);
  const stored = await loadStoredRevealMaterial(storage, key);
  if (stored === null) throw new Error('Receipt does not exist.');
  return JSON.stringify(backupBundle([stored.material], exportedAt), null, 2);
};

export const exportAllReceipts = async (storage: ReceiptStorage, exportedAt: string): Promise<string> => {
  removeObsoleteReceiptMetadata(storage);
  const stored = await listStoredRevealMaterials(storage);
  return JSON.stringify(
    backupBundle(
      stored.map(({ stored: record }) => record.material),
      exportedAt,
    ),
    null,
    2,
  );
};

export const browserReceiptDownload: ReceiptDownload = (fileName, contents, mediaType) => {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
};

export const downloadReceipt = async (input: {
  readonly storage: ReceiptStorage;
  readonly revealMaterialKey: string;
  readonly downloadedAt: string;
  readonly download?: ReceiptDownload;
}): Promise<'downloaded' | 'failed'> => {
  try {
    const contents = await exportOneReceipt(input.storage, input.revealMaterialKey, input.downloadedAt);
    const stored = await loadStoredRevealMaterial(input.storage, input.revealMaterialKey);
    if (stored === null) throw new Error('Receipt does not exist.');
    await (input.download ?? browserReceiptDownload)(
      `intex-receipt-${stored.material.worldwideDay}-${stored.material.commitHash}.json`,
      contents,
      'application/json',
    );
    return 'downloaded';
  } catch {
    return 'failed';
  }
};

interface ImportCandidate {
  readonly material: RevealMaterialV1;
  readonly sourceSchemaVersion: number;
  readonly kind: ReceiptSourceV1['kind'];
}

type ExtractedCandidate =
  | { readonly ok: true; readonly candidate: ImportCandidate }
  | { readonly ok: false; readonly outcome: ReceiptImportOutcome; readonly message: string };

const importMetadata = (
  material: RevealMaterialV1,
  source: 'imported' | 'migrated',
  importedAt: string,
): RevealMaterialV1 => ({
  ...material,
  metadata: {
    ...material.metadata,
    source,
    importedAt,
  },
});

const validationOutcome = (
  error: unknown,
): Exclude<ReceiptImportOutcome, 'imported' | 'duplicate' | 'valid-inactive-context'> => {
  if (error instanceof ReceiptValidationError) return error.code;
  return 'schema-failure';
};

const failedCandidate = (error: unknown): ExtractedCandidate => ({
  ok: false,
  outcome: validationOutcome(error),
  message: error instanceof Error ? error.message : String(error),
});

const importedCandidate = async (value: unknown, importedAt: string): Promise<ImportCandidate> => {
  const material = await validateRevealMaterial(value);
  return {
    material: await validateRevealMaterial(importMetadata(material, 'imported', importedAt)),
    sourceSchemaVersion: material.schemaVersion,
    kind: 'imported',
  };
};

const extractLegacyV1Candidate = async (value: unknown, importedAt: string): Promise<ImportCandidate> => {
  if (!isRecord(value) || !isRecord(value.stored)) {
    throw new ReceiptValidationError('schema-failure', 'Legacy receipt export entry is malformed.');
  }
  const stored = await parseStoredRevealMaterial(value.stored);
  return importedCandidate(stored.material, importedAt);
};

const requireBackupCardinality = (receipts: readonly unknown[]): void => {
  if (receipts.length > MAX_RECEIPTS_PER_BACKUP) {
    throw new ReceiptValidationError(
      'schema-failure',
      `Receipt backup contains more than ${MAX_RECEIPTS_PER_BACKUP} receipts.`,
    );
  }
};

const extractCandidates = async (parsed: unknown, importedAt: string): Promise<readonly ExtractedCandidate[]> => {
  if (isRecord(parsed) && parsed.backupSchemaVersion === RECEIPT_BACKUP_SCHEMA_VERSION) {
    if (
      parsed.warning !== SENSITIVE_RECEIPT_WARNING ||
      !Array.isArray(parsed.receipts) ||
      parsed.receipts.length === 0
    ) {
      throw new ReceiptValidationError('schema-failure', 'Receipt backup envelope is malformed.');
    }
    requireBackupCardinality(parsed.receipts);
    requireIsoTimestamp(parsed.exportedAt, 'Export timestamp');
    const results: ExtractedCandidate[] = [];
    for (const receipt of parsed.receipts) {
      try {
        results.push({ ok: true, candidate: await importedCandidate(receipt, importedAt) });
      } catch (error) {
        results.push(failedCandidate(error));
      }
    }
    return results;
  }

  if (isRecord(parsed) && parsed.exportSchemaVersion === LEGACY_RECEIPT_EXPORT_SCHEMA_VERSION) {
    if (
      parsed.warning !== SENSITIVE_RECEIPT_WARNING ||
      !Array.isArray(parsed.receipts) ||
      parsed.receipts.length === 0
    ) {
      throw new ReceiptValidationError('schema-failure', 'Legacy receipt export envelope is malformed.');
    }
    requireBackupCardinality(parsed.receipts);
    requireIsoTimestamp(parsed.exportedAt, 'Export timestamp');
    const results: ExtractedCandidate[] = [];
    for (const receipt of parsed.receipts) {
      try {
        results.push({ ok: true, candidate: await extractLegacyV1Candidate(receipt, importedAt) });
      } catch (error) {
        results.push(failedCandidate(error));
      }
    }
    return results;
  }

  if (isRecord(parsed) && parsed.storageSchemaVersion === 1) {
    const stored = await parseStoredRevealMaterial(parsed);
    return [{ ok: true, candidate: await importedCandidate(stored.material, importedAt) }];
  }

  if (isRecord(parsed) && parsed.schemaVersion === 0) {
    return [{ ok: false, outcome: 'unsupported-profile', message: 'Legacy v0 receipts are no longer supported.' }];
  }

  return [{ ok: true, candidate: await importedCandidate(parsed, importedAt) }];
};

const combinedOutcome = (items: readonly ReceiptImportItemResult[]): ReceiptImportOutcome | 'mixed' => {
  const outcomes = new Set(items.map(({ outcome }) => outcome));
  return outcomes.size === 1 ? items[0]!.outcome : 'mixed';
};

export const importReceiptJson = async (input: {
  readonly storage: ReceiptStorage;
  readonly fileName: string;
  readonly originalJson: string;
  readonly importedAt: string;
  readonly activeContext?: ReceiptActiveContext;
  readonly auditId: string;
}): Promise<ReceiptFileImportResult> => {
  removeObsoleteReceiptMetadata(input.storage);
  let extracted: readonly ExtractedCandidate[];
  try {
    extracted = await extractCandidates(JSON.parse(input.originalJson), input.importedAt);
  } catch (error) {
    const outcome = validationOutcome(error);
    const message = error instanceof Error ? error.message : String(error);
    return { fileName: input.fileName, outcome, items: [{ outcome, message }], auditRetained: false };
  }

  const items: ReceiptImportItemResult[] = [];
  for (const extractedCandidate of extracted) {
    if (!extractedCandidate.ok) {
      items.push({ outcome: extractedCandidate.outcome, message: extractedCandidate.message });
      continue;
    }
    const candidate = extractedCandidate.candidate;
    const source: ReceiptSourceV1 = {
      kind: candidate.kind,
      capturedAt: input.importedAt,
      sourceSchemaVersion: candidate.sourceSchemaVersion,
    };
    const persisted = await persistRevealMaterial({
      storage: input.storage,
      material: candidate.material,
      source,
    });
    if (!persisted.ok) {
      const outcome = validationOutcome(
        new ReceiptValidationError(
          persisted.code === 'unsupported-profile' ||
            persisted.code === 'domain-mismatch' ||
            persisted.code === 'commit-hash-mismatch' ||
            persisted.code === 'invalid-signature-or-signer' ||
            persisted.code === 'checksum-consistency-failure'
            ? persisted.code
            : 'schema-failure',
          persisted.message,
        ),
      );
      items.push({ outcome, message: persisted.message });
      continue;
    }

    if (persisted.disposition === 'existing') {
      items.push({ outcome: 'duplicate', key: persisted.key, message: 'Receipt already exists.' });
      continue;
    }
    const active = input.activeContext === undefined || receiptMatchesContext(candidate.material, input.activeContext);
    items.push({
      outcome: active ? 'imported' : 'valid-inactive-context',
      key: persisted.key,
      message: active ? 'Receipt imported.' : 'Receipt retained for its inactive wallet, chain, or deployment context.',
    });
  }

  return {
    fileName: input.fileName,
    outcome: combinedOutcome(items),
    items,
    auditRetained: false,
  };
};

const preflightReceiptFiles = (files: readonly ReceiptInputFile[]): void => {
  if (files.length > MAX_RECEIPT_IMPORT_FILES) {
    throw new Error(`Select at most ${MAX_RECEIPT_IMPORT_FILES} receipt files at a time.`);
  }
  for (const file of files) {
    if (file.size === undefined) continue;
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Receipt file "${file.name}" has an invalid byte size.`);
    }
    if (file.size > MAX_RECEIPT_IMPORT_FILE_BYTES) {
      throw new Error(`Receipt file "${file.name}" exceeds the ${MAX_RECEIPT_IMPORT_FILE_BYTES}-byte import limit.`);
    }
  }
};

export const importReceiptFiles = async (input: {
  readonly storage: ReceiptStorage;
  readonly files: readonly ReceiptInputFile[];
  readonly importedAt: string;
  readonly activeContext?: ReceiptActiveContext;
  readonly auditId: (fileName: string, index: number) => string;
}): Promise<readonly ReceiptFileImportResult[]> => {
  preflightReceiptFiles(input.files);
  const results: ReceiptFileImportResult[] = [];
  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index]!;
    try {
      results.push(
        await importReceiptJson({
          storage: input.storage,
          fileName: file.name,
          originalJson: await file.text(),
          importedAt: input.importedAt,
          ...(input.activeContext === undefined ? {} : { activeContext: input.activeContext }),
          auditId: input.auditId(file.name, index),
        }),
      );
    } catch (error) {
      results.push(importFailure(file.name, error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
};
