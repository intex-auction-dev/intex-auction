import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog } from '@base-ui/react/dialog';
import { describe, expect, it } from 'vitest';
import type { ResolvedVenueReadProfile } from '@/runtime-config/load-reviewed-runtime-config';
import { BidReceiptPanel, baseReceiptDetailModel, latestCommitTransaction } from '@/bidding/receipt-tools';
import { persistRevealMaterial, saveTransactionAttempt } from '@/receipts/receipt-store';
import { MemoryStorage, TEST_TIME, createTestMaterial } from '../receipts/test-fixtures';

const MINED_HASH = `0x${'ab'.repeat(32)}`;
const REPLACEMENT_HASH = `0x${'cd'.repeat(32)}`;

const profileWith = (explorerUrl: string | null): ResolvedVenueReadProfile =>
  ({ explorerUrl }) as unknown as ResolvedVenueReadProfile;

const seedReceipt = async () => {
  const storage = new MemoryStorage();
  const persisted = await persistRevealMaterial({ storage, material: await createTestMaterial() });
  if (!persisted.ok) throw new Error(persisted.message);
  return { storage, key: persisted.key, stored: persisted.stored };
};

const saveCommit = (
  storage: MemoryStorage,
  key: string,
  attemptId: string,
  transactionHash: string | undefined,
  updatedAt: string,
  kind: 'commit' | 'recommit' = 'commit',
) =>
  saveTransactionAttempt(storage, {
    schemaVersion: 1,
    attemptId,
    revealMaterialKey: key,
    kind,
    ...(transactionHash === undefined ? {} : { transactionHash: transactionHash as `0x${string}` }),
    state: transactionHash === undefined ? 'submitted' : 'confirmed',
    submittedAt: TEST_TIME,
    updatedAt,
  });

describe('receipt commit-hash explorer link', () => {
  it('links to the broadcast commit transaction when it is mined and an explorer is configured', async () => {
    const { storage, key, stored } = await seedReceipt();
    saveCommit(storage, key, 'commit-1', MINED_HASH, '2026-08-04T10:01:00.000Z');
    const model = baseReceiptDetailModel(stored, key, profileWith('https://bscscan.com'), storage);
    expect(model.commitExplorerUrl).toBe(`https://bscscan.com/tx/${MINED_HASH}`);
    expect(model.commitExplorerUrl).not.toContain(model.commitHash);
  });

  it('links a broadcast-but-not-yet-mined commit: the explorer is the authority on pending vs mined', async () => {
    const { storage, key, stored } = await seedReceipt();
    saveCommit(storage, key, 'commit-1', MINED_HASH, '2026-08-04T10:01:00.000Z');
    const model = baseReceiptDetailModel(stored, key, profileWith('https://bscscan.com'), storage);
    expect(model.commitExplorerUrl).toBe(`https://bscscan.com/tx/${MINED_HASH}`);
  });

  it('follows the replacement/recommit transaction hash, not the superseded one', async () => {
    const { storage, key, stored } = await seedReceipt();
    saveCommit(storage, key, 'commit-1', MINED_HASH, '2026-08-04T10:01:00.000Z');
    saveCommit(storage, key, 'recommit-1', REPLACEMENT_HASH, '2026-08-04T10:05:00.000Z', 'recommit');
    expect(latestCommitTransaction(storage, key)).toBe(REPLACEMENT_HASH);
    const model = baseReceiptDetailModel(stored, key, profileWith('https://bscscan.com'), storage);
    expect(model.commitExplorerUrl).toBe(`https://bscscan.com/tx/${REPLACEMENT_HASH}`);
  });

  it('renders no link when the commit was never broadcast (no transaction hash exists)', async () => {
    const { storage, key, stored } = await seedReceipt();
    saveCommit(storage, key, 'commit-1', undefined, '2026-08-04T10:01:00.000Z');
    expect(latestCommitTransaction(storage, key)).toBeNull();
    const model = baseReceiptDetailModel(stored, key, profileWith('https://bscscan.com'), storage);
    expect(model.commitExplorerUrl).toBeNull();
  });

  it('renders no link when no explorer is configured, even with a mined transaction', async () => {
    const { storage, key, stored } = await seedReceipt();
    saveCommit(storage, key, 'commit-1', MINED_HASH, '2026-08-04T10:01:00.000Z');
    const model = baseReceiptDetailModel(stored, key, profileWith(null), storage);
    expect(model.commitExplorerUrl).toBeNull();
  });
});

describe('receipt commit-hash explorer link rendering', () => {
  const render = (commitExplorerUrl: string | null): string =>
    renderToStaticMarkup(
      <Dialog.Root open>
        <BidReceiptPanel
          model={{
            auctionLabel: 'Auction 2026 08 04',
            seriesCode: 'Assigned at issuance',
            quantity: '1 Intex',
            bidRate: '5% of strike',
            totalEscrow: 'Œ5000',
            totalPromis: '100,000 Promis',
            commitHash: `0x${'11'.repeat(32)}`,
            commitExplorerUrl,
            chainId: '56',
            bidder: '0x1111111111111111111111111111111111111111',
            auctionContract: '0x2222222222222222222222222222222222222222',
            contractExplorerUrl: null,
            readFailure: null,
          }}
          busy={false}
          message={null}
          failure={null}
          onDownload={() => undefined}
        />
      </Dialog.Root>,
    );

  it('renders an Explorer link on the commit-hash row when a URL is present', () => {
    const markup = render(`https://bscscan.com/tx/0x${'ab'.repeat(32)}`);
    expect(markup).toContain(`href="https://bscscan.com/tx/0x${'ab'.repeat(32)}"`);
    expect(markup).toContain('Explorer');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('omits the Explorer link on the commit-hash row when the URL is null', () => {
    const markup = render(null);
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('href=');
  });
});
