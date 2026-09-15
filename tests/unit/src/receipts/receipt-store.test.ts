import { describe, expect, it } from 'vitest';
import {
  RECEIPT_STORAGE_PREFIX,
  listStoredRevealMaterials,
  listTransactionAttempts,
  loadStoredRevealMaterial,
  persistRevealMaterial,
  removeObsoleteReceiptMetadata,
  revealMaterialStorageKey,
  saveTransactionAttempt,
} from '@/receipts/receipt-store';
import { MemoryStorage, TEST_TIME, createTestMaterial } from './test-fixtures';

const TX_A = `0x${'aa'.repeat(32)}` as const;
const TX_B = `0x${'bb'.repeat(32)}` as const;

describe('receipt persistence boundary', () => {
  it('writes, reads back, parses, and cryptographically revalidates before success', async () => {
    const storage = new MemoryStorage();
    const material = await createTestMaterial();
    const result = await persistRevealMaterial({ storage, material });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.key).toContain(`${RECEIPT_STORAGE_PREFIX.slice(0, -1)}:56:bsc-mainnet-v1:`);
    expect(result.key).toContain(':20260108:');
    expect((await loadStoredRevealMaterial(storage, result.key))?.material.commitHash).toBe(material.commitHash);
  });

  it('blocks on storage write failure without an actionable key', async () => {
    const storage = new MemoryStorage();
    storage.failSet = true;
    const result = await persistRevealMaterial({ storage, material: await createTestMaterial() });
    expect(result).toMatchObject({ ok: false, stage: 'write', code: 'storage-write-failure' });
    expect('key' in result).toBe(false);
  });

  // Reveal material is the one record that cannot be rebuilt from chain logs, so this
  // key is a permanent compatibility surface. If this literal has to change, existing
  // users' receipts become unreadable and an explicit migration is required first.
  it('derives a byte-identical storage key across releases', async () => {
    expect(revealMaterialStorageKey(await createTestMaterial())).toBe(
      'itx-acn:reveal-material:v1:56:bsc-mainnet-v1' +
        ':0x000000000000000000000000000000000000cafe' +
        ':0x7e5f4552091a69125d5dfcb7b8c2659029395bdf' +
        ':20260108' +
        ':0x7e1c3d4a80475b2543d904220bc17b660e86de0800a7aafffc5b8bc6dd123b97',
    );
  });

  it('escapes a deployment id that contains the key separator', async () => {
    const key = revealMaterialStorageKey(await createTestMaterial({ deploymentId: 'a:b' }));
    expect(key).toContain(':a%3Ab:');
  });

  it('blocks and removes a partial write when read-back fails', async () => {
    const storage = new MemoryStorage();
    storage.returnNullAfterSet = true;
    const material = await createTestMaterial();
    const key = revealMaterialStorageKey(material);
    const result = await persistRevealMaterial({ storage, material });
    expect(result).toMatchObject({ ok: false, stage: 'read-back' });
    expect(storage.data.has(key)).toBe(false);
    expect('key' in result).toBe(false);
  });

  it('blocks and removes a cryptographically inconsistent read-back', async () => {
    class CorruptingStorage extends MemoryStorage {
      override getItem(key: string): string | null {
        const raw = super.getItem(key);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { material: { commitHash: string } };
        parsed.material.commitHash = `0x${'11'.repeat(32)}`;
        return JSON.stringify(parsed);
      }
    }
    const storage = new CorruptingStorage();
    const material = await createTestMaterial();
    const result = await persistRevealMaterial({ storage, material });
    expect(result).toMatchObject({ ok: false, stage: 'read-back-validation', code: 'commit-hash-mismatch' });
    expect(storage.data.has(revealMaterialStorageKey(material))).toBe(false);
  });

  it('rejects malformed stored JSON', async () => {
    const storage = new MemoryStorage();
    const material = await createTestMaterial();
    const key = revealMaterialStorageKey(material);
    storage.data.set(key, '{');
    await expect(loadStoredRevealMaterial(storage, key)).rejects.toThrow();
  });

  it('retains records across wallet and chain changes', async () => {
    const storage = new MemoryStorage();
    const bsc = await createTestMaterial();
    const local = await createTestMaterial({ chainId: 31_337, deploymentId: 'local-v1' });
    expect((await persistRevealMaterial({ storage, material: bsc })).ok).toBe(true);
    expect((await persistRevealMaterial({ storage, material: local })).ok).toBe(true);
    const records = await listStoredRevealMaterials(storage);
    expect(records.map(({ stored }) => stored.material.chainId).sort((a, b) => a - b)).toEqual([56, 31_337]);
  });

  it('reads legacy source metadata without reattaching raw imported JSON', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistRevealMaterial({ storage, material: await createTestMaterial() });
    if (!persisted.ok) throw new Error(persisted.message);
    storage.setItem(
      persisted.key,
      JSON.stringify({
        ...persisted.stored,
        source: { ...persisted.stored.source, auditId: 'legacy-audit-id' },
      }),
    );
    storage.setItem(
      'itx-acn:receipt-import-audit:v1:legacy-audit-id',
      JSON.stringify({
        id: 'legacy-audit-id',
        originalJson: '{"secret":"legacy duplicate"}',
      }),
    );

    const loaded = await loadStoredRevealMaterial(storage, persisted.key);
    expect(loaded?.material.commitHash).toBe(persisted.stored.material.commitHash);
    expect(loaded?.source).not.toHaveProperty('auditId');
    expect(loaded?.source).not.toHaveProperty('originalJson');
  });
});

describe('transaction-attempt separation', () => {
  it('keeps multiple transaction cycles referencing one immutable reveal record', async () => {
    const storage = new MemoryStorage();
    const material = await createTestMaterial();
    const persisted = await persistRevealMaterial({ storage, material });
    if (!persisted.ok) throw new Error(persisted.message);

    saveTransactionAttempt(storage, {
      schemaVersion: 1,
      attemptId: 'commit-cycle-1',
      revealMaterialKey: persisted.key,
      kind: 'commit',
      transactionHash: TX_A,
      state: 'confirmed',
      submittedAt: TEST_TIME,
      updatedAt: TEST_TIME,
    });
    saveTransactionAttempt(storage, {
      schemaVersion: 1,
      attemptId: 'commit-cycle-2',
      revealMaterialKey: persisted.key,
      kind: 'recommit',
      transactionHash: TX_B,
      state: 'submitted',
      submittedAt: '2026-08-04T10:05:00.000Z',
      updatedAt: '2026-08-04T10:05:00.000Z',
    });

    const attempts = listTransactionAttempts(storage, persisted.key);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(({ attemptId }) => attemptId)).toEqual(['commit-cycle-1', 'commit-cycle-2']);
    expect((await loadStoredRevealMaterial(storage, persisted.key))?.material).toEqual(material);
  });

  it('updates attempt state but never changes attempt identity', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistRevealMaterial({ storage, material: await createTestMaterial() });
    if (!persisted.ok) throw new Error(persisted.message);
    const base = {
      schemaVersion: 1 as const,
      attemptId: 'approval-1',
      revealMaterialKey: persisted.key,
      kind: 'approval' as const,
      state: 'submitted' as const,
      submittedAt: TEST_TIME,
      updatedAt: TEST_TIME,
    };
    saveTransactionAttempt(storage, base);
    expect(
      saveTransactionAttempt(storage, {
        ...base,
        transactionHash: TX_A,
        state: 'confirmed',
        updatedAt: '2026-08-04T10:01:00.000Z',
      }).state,
    ).toBe('confirmed');
    expect(() => saveTransactionAttempt(storage, { ...base, kind: 'commit' })).toThrow('identity cannot be changed');
  });
});

class PartialCleanupFailureStorage extends MemoryStorage {
  override removeItem(key: string): void {
    if (key.endsWith('blocked')) throw new Error('cleanup blocked');
    super.removeItem(key);
  }
}

describe('obsolete receipt metadata cleanup', () => {
  it('removes only obsolete receipt metadata and preserves canonical receipt and attempt records', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistRevealMaterial({ storage, material: await createTestMaterial() });
    if (!persisted.ok) throw new Error(persisted.message);
    saveTransactionAttempt(storage, {
      schemaVersion: 1,
      attemptId: 'cleanup-commit',
      revealMaterialKey: persisted.key,
      kind: 'commit',
      state: 'submitted',
      submittedAt: TEST_TIME,
      updatedAt: TEST_TIME,
    });
    storage.setItem('itx-acn:receipt-import-audit:v1:legacy', '{"raw":"secret"}');
    storage.setItem('itx-acn:receipt-backup:v1:legacy', '{"status":"downloaded"}');
    storage.setItem('unrelated:key', 'keep');

    removeObsoleteReceiptMetadata(storage);

    expect(storage.getItem('itx-acn:receipt-import-audit:v1:legacy')).toBeNull();
    expect(storage.getItem('itx-acn:receipt-backup:v1:legacy')).toBeNull();
    expect(storage.getItem(persisted.key)).not.toBeNull();
    expect(listTransactionAttempts(storage, persisted.key)).toHaveLength(1);
    expect(storage.getItem('unrelated:key')).toBe('keep');
  });

  it('keeps cleanup best-effort when one obsolete key cannot be removed', () => {
    const storage = new PartialCleanupFailureStorage();
    storage.setItem('itx-acn:receipt-import-audit:v1:blocked', 'secret');
    storage.setItem('itx-acn:receipt-backup:v1:removable', 'obsolete');

    expect(() => removeObsoleteReceiptMetadata(storage)).not.toThrow();
    expect(storage.getItem('itx-acn:receipt-import-audit:v1:blocked')).toBe('secret');
    expect(storage.getItem('itx-acn:receipt-backup:v1:removable')).toBeNull();
  });
});
