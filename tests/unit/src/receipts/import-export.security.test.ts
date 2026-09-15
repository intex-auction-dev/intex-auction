import { describe, expect, it, vi } from 'vitest';
import { SENSITIVE_RECEIPT_WARNING } from '@/receipts/reveal-material';
import {
  MAX_RECEIPT_IMPORT_FILE_BYTES,
  MAX_RECEIPT_IMPORT_FILES,
  MAX_RECEIPTS_PER_BACKUP,
  importReceiptFiles,
  importReceiptJson,
} from '@/receipts/import-export';
import { MemoryStorage, TEST_TIME, createTestMaterial } from './test-fixtures';

describe('receipt import resource limits', () => {
  it('rejects too many selected files before reading any input', async () => {
    const read = vi.fn().mockResolvedValue('{}');
    const files = Array.from({ length: MAX_RECEIPT_IMPORT_FILES + 1 }, (_, index) => ({
      name: `receipt-${index}.json`,
      size: 2,
      text: read,
    }));

    await expect(
      importReceiptFiles({
        storage: new MemoryStorage(),
        files,
        importedAt: TEST_TIME,
        auditId: (_, index) => `audit-${index}`,
      }),
    ).rejects.toThrow(`at most ${MAX_RECEIPT_IMPORT_FILES}`);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an oversized selection before reading any selected file', async () => {
    const firstRead = vi.fn().mockResolvedValue('{}');
    const oversizedRead = vi.fn().mockResolvedValue('{}');

    await expect(
      importReceiptFiles({
        storage: new MemoryStorage(),
        files: [
          { name: 'first.json', size: 2, text: firstRead },
          { name: 'oversized.json', size: MAX_RECEIPT_IMPORT_FILE_BYTES + 1, text: oversizedRead },
        ],
        importedAt: TEST_TIME,
        auditId: (_, index) => `audit-${index}`,
      }),
    ).rejects.toThrow('oversized.json');
    expect(firstRead).not.toHaveBeenCalled();
    expect(oversizedRead).not.toHaveBeenCalled();
  });

  it('rejects over-cardinality backup envelopes before persisting any receipt', async () => {
    const material = await createTestMaterial();
    const storage = new MemoryStorage();
    const result = await importReceiptJson({
      storage,
      fileName: 'too-many.json',
      originalJson: JSON.stringify({
        backupSchemaVersion: 2,
        warning: SENSITIVE_RECEIPT_WARNING,
        exportedAt: TEST_TIME,
        receipts: Array.from({ length: MAX_RECEIPTS_PER_BACKUP + 1 }, () => material),
      }),
      importedAt: TEST_TIME,
      auditId: 'audit-too-many',
    });

    expect(result.outcome).toBe('schema-failure');
    expect(result.items[0]?.message).toContain(`${MAX_RECEIPTS_PER_BACKUP}`);
    expect(storage.data.size).toBe(0);
  });
});
