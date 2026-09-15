import { describe, expect, it } from 'vitest';
import { SENSITIVE_RECEIPT_WARNING } from '@/receipts/reveal-material';
import {
  downloadReceipt,
  exportAllReceipts,
  exportOneReceipt,
  importReceiptFiles,
  importReceiptJson,
} from '@/receipts/import-export';
import {
  listTransactionAttempts,
  loadStoredRevealMaterial,
  persistRevealMaterial,
  saveTransactionAttempt,
} from '@/receipts/receipt-store';
import {
  MemoryStorage,
  OTHER_ACCOUNT,
  TEST_ACCOUNT,
  TEST_AUCTION,
  TEST_TIME,
  createTestMaterial,
} from './test-fixtures';

const TX_HASH = `0x${'aa'.repeat(32)}` as const;

const persistTestMaterial = async (storage: MemoryStorage) => {
  const result = await persistRevealMaterial({ storage, material: await createTestMaterial() });
  if (!result.ok) throw new Error(result.message);
  return result;
};

describe('receipt import and export', () => {
  it('exports one immutable-only backup schema for individual and bulk backups', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistTestMaterial(storage);
    saveTransactionAttempt(storage, {
      schemaVersion: 1,
      attemptId: 'commit-1',
      revealMaterialKey: persisted.key,
      kind: 'commit',
      transactionHash: TX_HASH,
      state: 'confirmed',
      submittedAt: TEST_TIME,
      updatedAt: TEST_TIME,
    });
    storage.setItem(
      'itx-acn:receipt-backup:v1:legacy',
      JSON.stringify({
        schemaVersion: 1,
        revealMaterialKey: persisted.key,
        status: 'downloaded',
        updatedAt: TEST_TIME,
      }),
    );

    const one = JSON.parse(await exportOneReceipt(storage, persisted.key, TEST_TIME)) as {
      backupSchemaVersion?: number;
      warning?: string;
      receipts?: unknown[];
    };
    const all = JSON.parse(await exportAllReceipts(storage, TEST_TIME)) as {
      backupSchemaVersion?: number;
      receipts?: unknown[];
    };

    expect(one.backupSchemaVersion).toBe(2);
    expect(one.warning).toBe(SENSITIVE_RECEIPT_WARNING);
    expect(one.receipts).toEqual([persisted.stored.material]);
    expect(all.backupSchemaVersion).toBe(2);
    expect(all.receipts).toEqual([persisted.stored.material]);
    expect(JSON.stringify(one)).not.toContain('transactionAttempts');
    expect(JSON.stringify(one)).not.toContain('backupState');
    expect(JSON.stringify(one)).not.toContain('originalJson');
    expect(JSON.stringify(one)).not.toContain('auditId');
  });

  it('imports, reports duplicates, and keeps inactive contexts', async () => {
    const source = new MemoryStorage();
    const persisted = await persistTestMaterial(source);
    const json = await exportOneReceipt(source, persisted.key, TEST_TIME);
    const target = new MemoryStorage();
    const activeContext = {
      chainId: 31_337,
      deploymentId: 'local-v1',
      auctionProxy: TEST_AUCTION,
      bidder: OTHER_ACCOUNT.address,
    };

    const first = await importReceiptJson({
      storage: target,
      fileName: 'receipt.json',
      originalJson: json,
      importedAt: TEST_TIME,
      activeContext,
      auditId: 'audit-1',
    });
    expect(first.outcome).toBe('valid-inactive-context');
    const key = first.items[0]?.key;
    expect(key).toBeDefined();
    expect((await loadStoredRevealMaterial(target, key!))?.material.bidder).toBe(TEST_ACCOUNT.address);

    const duplicate = await importReceiptJson({
      storage: target,
      fileName: 'receipt.json',
      originalJson: json,
      importedAt: TEST_TIME,
      activeContext,
      auditId: 'audit-2',
    });
    expect(duplicate.outcome).toBe('duplicate');
  });

  it('validates separately selected files without retaining rejected raw JSON', async () => {
    const source = new MemoryStorage();
    const persisted = await persistTestMaterial(source);
    const valid = await exportOneReceipt(source, persisted.key, TEST_TIME);
    const target = new MemoryStorage();
    const results = await importReceiptFiles({
      storage: target,
      files: [
        { name: 'valid.json', text: async () => valid },
        { name: 'broken.json', text: async () => '{' },
      ],
      importedAt: TEST_TIME,
      auditId: (_, index) => `audit-${index}`,
    });
    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe('imported');
    expect(results[1]?.outcome).toBe('schema-failure');
    expect(results[1]?.auditRetained).toBe(false);
    expect([...target.data.keys()].some((key) => key.startsWith('itx-acn:receipt-import-audit:v1:'))).toBe(false);
  });

  it('does not persist browser download attempts as receipt authority', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistTestMaterial(storage);
    expect(
      await downloadReceipt({
        storage,
        revealMaterialKey: persisted.key,
        downloadedAt: TEST_TIME,
        download: () => {
          throw new Error('browser blocked download');
        },
      }),
    ).toBe('failed');
    expect([...storage.data.keys()].some((key) => key.startsWith('itx-acn:receipt-backup:v1:'))).toBe(false);
  });

  it('imports current v1 backups for reveal material only and ignores mutable state', async () => {
    const source = new MemoryStorage();
    const sourceRecord = await persistTestMaterial(source);
    const v1 = JSON.stringify({
      exportSchemaVersion: 1,
      warning: SENSITIVE_RECEIPT_WARNING,
      exportedAt: TEST_TIME,
      receipts: [
        {
          stored: sourceRecord.stored,
          transactionAttempts: [
            {
              schemaVersion: 1,
              attemptId: 'commit-1',
              revealMaterialKey: sourceRecord.key,
              kind: 'commit',
              transactionHash: TX_HASH,
              state: 'confirmed',
              submittedAt: TEST_TIME,
              updatedAt: TEST_TIME,
            },
          ],
          backupState: {
            schemaVersion: 1,
            revealMaterialKey: sourceRecord.key,
            status: 'user-confirmed-backup',
            updatedAt: TEST_TIME,
          },
        },
      ],
    });

    const target = new MemoryStorage();
    const result = await importReceiptJson({
      storage: target,
      fileName: 'v1.json',
      originalJson: v1,
      importedAt: '2026-08-04T10:10:00.000Z',
      auditId: 'v1-audit',
    });
    expect(result.outcome).toBe('imported');
    const key = result.items[0]?.key;
    expect(key).toBeDefined();
    expect((await loadStoredRevealMaterial(target, key!))?.material.commitHash).toBe(
      sourceRecord.stored.material.commitHash,
    );
    expect(listTransactionAttempts(target, key!)).toEqual([]);
    expect([...target.data.keys()].some((storageKey) => storageKey.startsWith('itx-acn:receipt-backup:v1:'))).toBe(
      false,
    );
  });

  it('rejects legacy v0 receipts as unsupported', async () => {
    const material = await createTestMaterial();
    const legacyJson = JSON.stringify({
      schemaVersion: 0,
      profile: material.adapterProfile,
      deploymentId: material.deploymentId,
      chainId: material.chainId,
      auctionProxy: material.auctionProxy,
      bidder: material.bidder,
      worldwideDay: material.worldwideDay,
      quantity: material.quantity,
      bidRate: material.bidRate,
      signature: material.signature,
      commitHash: material.commitHash,
      createdAt: material.metadata.createdAt,
    });
    const storage = new MemoryStorage();
    const result = await importReceiptJson({
      storage,
      fileName: 'legacy.json',
      originalJson: legacyJson,
      importedAt: TEST_TIME,
      auditId: 'legacy-audit',
    });
    expect(result.outcome).toBe('unsupported-profile');
  });
});
