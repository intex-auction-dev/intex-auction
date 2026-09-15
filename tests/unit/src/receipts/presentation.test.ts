import { describe, expect, it } from 'vitest';
import { createReceiptPresentation, deriveLocalReceiptMatch } from '@/receipts/presentation';
import { persistRevealMaterial, saveTransactionAttempt } from '@/receipts/receipt-store';
import {
  MemoryStorage,
  OTHER_ACCOUNT,
  TEST_ACCOUNT,
  TEST_AUCTION,
  TEST_TIME,
  createTestMaterial,
} from './test-fixtures';

describe('receipt presentation', () => {
  it('distinguishes sealed-bid identity from transaction activity', async () => {
    const storage = new MemoryStorage();
    const persisted = await persistRevealMaterial({ storage, material: await createTestMaterial() });
    if (!persisted.ok) throw new Error(persisted.message);
    const attempt = saveTransactionAttempt(storage, {
      schemaVersion: 1,
      attemptId: 'commit-1',
      revealMaterialKey: persisted.key,
      kind: 'commit',
      transactionHash: `0x${'aa'.repeat(32)}`,
      state: 'confirmed',
      submittedAt: TEST_TIME,
      updatedAt: TEST_TIME,
    });
    const presentation = createReceiptPresentation({
      material: persisted.stored.material,
      attempts: [attempt],
      explorer: { explorerUrl: 'https://example.invalid/' },
      commitBondMinor: 100n,
      revealLockMinor: 550n,
      currentRevealDeadline: 1_800_000_000n,
    });
    expect(presentation.sealedBid.commitHash).toBe(persisted.stored.material.commitHash);
    expect(presentation.sealedBid.explorerUrl).toBeNull();
    expect(presentation.attempts.commit[0]?.explorerUrl).toContain('/tx/');
    expect(presentation.transactionStatus).toBe('confirmed');
    expect(presentation.revealLockMinor).toBe(550n);
    expect(presentation.issuanceCurrency).toBe(949);
    expect(presentation).not.toHaveProperty('backupStatus');
    expect(presentation.sensitiveMaterialWarning).toContain('Sensitive reveal material');
  });

  it('omits explorer links when metadata is unavailable', async () => {
    const material = await createTestMaterial();
    const presentation = createReceiptPresentation({
      material,
      attempts: [],
    });
    expect(presentation.sealedBid.explorerUrl).toBeNull();
    expect(presentation.transactionStatus).toBe('none');
  });
});

describe('local receipt recovery state', () => {
  it('marks an on-chain commitment without local material as critical and non-regenerable', async () => {
    const material = await createTestMaterial();
    const result = deriveLocalReceiptMatch({
      liveCommitHash: material.commitHash,
      records: [],
      activeContext: {
        chainId: material.chainId,
        deploymentId: material.deploymentId,
        auctionProxy: material.auctionProxy,
        bidder: material.bidder,
      },
    });
    expect(result).toMatchObject({
      state: 'missing-local-receipt',
      severity: 'critical',
      canRegenerateSignature: false,
    });
    if (result.state !== 'missing-local-receipt') throw new Error('Expected missing receipt.');
    expect(result.message).toContain('exact signature cannot be regenerated safely');
  });

  it('keeps a matching receipt inactive until wallet context matches', async () => {
    const material = await createTestMaterial();
    const result = deriveLocalReceiptMatch({
      liveCommitHash: material.commitHash,
      records: [{ key: 'receipt-key', material }],
      activeContext: {
        chainId: material.chainId,
        deploymentId: material.deploymentId,
        auctionProxy: TEST_AUCTION,
        bidder: OTHER_ACCOUNT.address,
      },
    });
    expect(result).toMatchObject({ state: 'matching-inactive-receipt', severity: 'warning' });

    expect(
      deriveLocalReceiptMatch({
        liveCommitHash: material.commitHash,
        records: [{ key: 'receipt-key', material }],
        activeContext: {
          chainId: material.chainId,
          deploymentId: material.deploymentId,
          auctionProxy: TEST_AUCTION,
          bidder: TEST_ACCOUNT.address,
        },
      }),
    ).toMatchObject({ state: 'matching-actionable-receipt', severity: 'none' });
  });
});
