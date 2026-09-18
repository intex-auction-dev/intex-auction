import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog } from '@base-ui/react/dialog';
import { describe, expect, it } from 'vitest';
import { BidReceiptPanel, type BidReceiptDetailModel } from '@/bidding/receipt-tools';

const model: BidReceiptDetailModel = {
  auctionLabel: 'Auction 2026 08 04',
  seriesCode: 'Assigned at issuance',
  quantity: '10 Intexes',
  bidRate: '8% of escrow basis · Œ80 / Intex',
  totalEscrow: 'Œ800 · 28,000 TRY',
  totalPromis: '10,000,000 Promis',
  commitHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  commitExplorerUrl: 'https://example.test/tx/0x1234',
  chainId: '97',
  bidder: '0x1111111111111111111111111111111111111111',
  auctionContract: '0x2222222222222222222222222222222222222222',
  contractExplorerUrl: 'https://example.test/address/0x2222',
  readFailure: null,
};

describe('bid receipt detail', () => {
  it('shows the bid receipt instead of the saved-receipts manager', () => {
    const markup = renderToStaticMarkup(
      <Dialog.Root open>
        <BidReceiptPanel model={model} busy={false} message={null} failure={null} onDownload={() => undefined} />
      </Dialog.Root>,
    );

    expect(markup).toContain('Bid Receipt');
    expect(markup).toContain('Auction 2026 08 04');
    expect(markup).toContain('Intex Series');
    expect(markup).toContain('Assigned at issuance');
    expect(markup).toContain('Quantity');
    expect(markup).toContain('10 Intexes');
    expect(markup).toContain('Bid rate');
    expect(markup).toContain('8% of escrow basis');
    expect(markup).toContain('Total escrow at reveal');
    expect(markup).toContain('Total Promis');
    expect(markup).toContain('Commit hash');
    expect(markup).toContain('Chain ID');
    expect(markup).toContain('Bidder');
    expect(markup).toContain('Auction Contract');
    expect(markup).toContain('Your bid is stored in local storage by default.');
    expect(markup).toContain('Download bid receipt');

    expect(markup).not.toContain('Local safety records');
    expect(markup).not.toContain('Import JSON files');
    expect(markup).not.toContain('Export all receipts');
  });
});
