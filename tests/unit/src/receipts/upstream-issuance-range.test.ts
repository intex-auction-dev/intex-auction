import { describe, expect, it } from 'vitest';
import { importReceiptJson } from '@/receipts/import-export';
import { RECEIPT_STORAGE_PREFIX } from '@/receipts/receipt-store';
import { validateRevealMaterial } from '@/receipts/reveal-material';
import { MemoryStorage, createTestMaterial } from './test-fixtures';

type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;

describe('pinned upstream issuance-currency boundary', () => {
  it('rejects stored reveal material with issuanceCurrency 1000 as a schema failure', async () => {
    const material = clone(await createTestMaterial({ issuanceCurrency: 999, referenceCurrency: 840 }));
    material.issuanceCurrency = 1_000;
    material.typedData.message.issuanceCurrency = 1_000;

    await expect(validateRevealMaterial(material)).rejects.toMatchObject({ code: 'schema-failure' });
  });

  it('rejects imported receipt material with issuanceCurrency 1000 before canonical persistence', async () => {
    const material = clone(await createTestMaterial({ issuanceCurrency: 999, referenceCurrency: 840 }));
    material.issuanceCurrency = 1_000;
    material.typedData.message.issuanceCurrency = 1_000;
    const storage = new MemoryStorage();

    const result = await importReceiptJson({
      storage,
      fileName: 'invalid-issuance.json',
      originalJson: JSON.stringify(material),
      importedAt: '2026-08-24T20:00:00.000Z',
      auditId: 'test-import',
    });

    expect(result.outcome).toBe('schema-failure');
    expect([...storage.data.keys()].filter((key) => key.startsWith(RECEIPT_STORAGE_PREFIX))).toEqual([]);
  });
});
