import { describe, expect, it } from 'vitest';
import { exportAllReceipts, exportOneReceipt, importReceiptJson } from '@/receipts/import-export';
import { listStoredRevealMaterials, persistRevealMaterial, revealMaterialStorageKey } from '@/receipts/receipt-store';
import { MemoryStorage, TEST_TIME, createTestMaterial } from './test-fixtures';

describe('receipt safety regressions', () => {
  it('treats an existing immutable record as set-once and preserves its first source', async () => {
    const storage = new MemoryStorage();
    const material = await createTestMaterial();
    const first = await persistRevealMaterial({ storage, material });
    expect(first).toMatchObject({ ok: true, disposition: 'stored' });
    if (!first.ok) throw new Error(first.message);
    const rawBefore = storage.getItem(first.key);

    const duplicate = await persistRevealMaterial({
      storage,
      material,
      source: {
        kind: 'imported',
        capturedAt: TEST_TIME,
        sourceSchemaVersion: 1,
      },
    });
    expect(duplicate).toMatchObject({ ok: true, disposition: 'existing' });
    expect(storage.getItem(first.key)).toBe(rawBefore);
    expect(JSON.parse(storage.getItem(first.key)!).source.kind).toBe('generated');
  });

  it('blocks on a corrupt existing record without overwriting or deleting it', async () => {
    const storage = new MemoryStorage();
    const material = await createTestMaterial();
    const key = revealMaterialStorageKey(material);
    storage.setItem(key, '{corrupt');

    const result = await persistRevealMaterial({ storage, material });
    expect(result).toMatchObject({ ok: false, stage: 'read-back-validation' });
    expect(storage.getItem(key)).toBe('{corrupt');
  });

  it('exports only the selected receipt after importing a multi-receipt bundle without raw audit copies', async () => {
    const source = new MemoryStorage();
    const firstMaterial = await createTestMaterial({ worldwideDay: 20260108, quantity: 5 });
    const secondMaterial = await createTestMaterial({ worldwideDay: 20260109, quantity: 7 });
    expect((await persistRevealMaterial({ storage: source, material: firstMaterial })).ok).toBe(true);
    expect((await persistRevealMaterial({ storage: source, material: secondMaterial })).ok).toBe(true);
    const bundle = await exportAllReceipts(source, TEST_TIME);

    const target = new MemoryStorage();
    const imported = await importReceiptJson({
      storage: target,
      fileName: 'bundle.json',
      originalJson: bundle,
      importedAt: TEST_TIME,
      auditId: 'bundle-audit',
    });
    expect(imported.items).toHaveLength(2);
    const records = await listStoredRevealMaterials(target);
    const first = records.find(({ stored }) => stored.material.worldwideDay === firstMaterial.worldwideDay);
    expect(first).toBeDefined();

    const exportedFirst = await exportOneReceipt(target, first!.key, TEST_TIME);
    expect(exportedFirst).toContain(firstMaterial.signature);
    expect(exportedFirst).toContain(firstMaterial.commitHash);
    expect(exportedFirst).not.toContain(secondMaterial.signature);
    expect(exportedFirst).not.toContain(secondMaterial.commitHash);

    const rawEnvelope = target.getItem(first!.key);
    expect(rawEnvelope).not.toContain(secondMaterial.signature);
    expect(rawEnvelope).not.toContain(secondMaterial.commitHash);
    expect([...target.data.keys()].some((key) => key.startsWith('itx-acn:receipt-import-audit:v1:'))).toBe(false);
  });
});
