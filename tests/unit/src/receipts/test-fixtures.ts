import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { buildRevealBidTypedData, createRevealMaterial, type RevealMaterialV1 } from '@/receipts/reveal-material';
import type { ReceiptStorage } from '@/receipts/receipt-store';

export const TEST_PRIVATE_KEY = `0x${'01'.padStart(64, '0')}` as Hex;
export const OTHER_PRIVATE_KEY = `0x${'02'.padStart(64, '0')}` as Hex;
export const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
export const OTHER_ACCOUNT = privateKeyToAccount(OTHER_PRIVATE_KEY);
export const TEST_AUCTION = '0x000000000000000000000000000000000000cafE' as Address;
export const TEST_TIME = '2026-08-04T10:00:00.000Z';

export const createTestMaterial = async (
  overrides: Partial<{
    deploymentId: string;
    chainId: number;
    auctionProxy: Address;
    bidder: Address;
    worldwideDay: number;
    quantity: number;
    bidRate: number;
    issuanceCurrency: number;
    referenceCurrency: number;
    signer: typeof TEST_ACCOUNT;
  }> = {},
): Promise<RevealMaterialV1> => {
  const signer = overrides.signer ?? TEST_ACCOUNT;
  const bidder = overrides.bidder ?? signer.address;
  const typedData = buildRevealBidTypedData({
    chainId: overrides.chainId ?? 56,
    auctionProxy: overrides.auctionProxy ?? TEST_AUCTION,
    bidder,
    worldwideDay: overrides.worldwideDay ?? 20260108,
    quantity: overrides.quantity ?? 5,
    bidRate: overrides.bidRate ?? 1_100,
    issuanceCurrency: overrides.issuanceCurrency ?? 949,
    referenceCurrency: overrides.referenceCurrency ?? 840,
  });
  const signature = await signer.signTypedData(typedData);
  return createRevealMaterial({
    deploymentId: overrides.deploymentId ?? 'bsc-mainnet-v1',
    chainId: typedData.domain.chainId,
    auctionProxy: typedData.domain.verifyingContract,
    bidder,
    worldwideDay: typedData.message.worldwideDay,
    quantity: typedData.message.quantity,
    bidRate: typedData.message.bidRate,
    issuanceCurrency: typedData.message.issuanceCurrency,
    referenceCurrency: typedData.message.referenceCurrency,
    signature,
    createdAt: TEST_TIME,
  });
};

export class MemoryStorage implements ReceiptStorage {
  readonly data = new Map<string, string>();
  failSet = false;
  failGet = false;
  returnNullAfterSet = false;

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (this.failGet) throw new Error('read failed');
    if (this.returnNullAfterSet) return null;
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('write failed');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}
