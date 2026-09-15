import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import {
  buildRevealBidTypedData,
  createRevealMaterial,
  hashRevealBidTypedData,
  validateRevealMaterial,
} from '@/receipts/reveal-material';
import { OTHER_ACCOUNT, TEST_ACCOUNT, TEST_AUCTION, TEST_TIME, createTestMaterial } from './test-fixtures';

type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

describe('reveal material cryptographic profile', () => {
  it('matches the upstream Solidity golden EIP-712 digest for the canonical multi-issuance profile', () => {
    const typedData = buildRevealBidTypedData({
      chainId: 56,
      auctionProxy: '0x000000000000000000000000000000000000cafE',
      bidder: '0x000000000000000000000000000000000000ABcD',
      worldwideDay: 20260108,
      quantity: 5,
      bidRate: 1_100,
      issuanceCurrency: 949,
      referenceCurrency: 840,
    });
    expect(hashRevealBidTypedData(typedData)).toBe(
      '0xa64fee35708ed37432c1f65e0304f42c5825a0962079c9801ee04eb082eadec3',
    );
  });

  it('binds issuance and reference currency in the digest, signature and receipt', async () => {
    const build = (issuanceCurrency: number, referenceCurrency: number) =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 5,
        bidRate: 1_100,
        issuanceCurrency,
        referenceCurrency,
      });
    const tryTyped = build(949, 840);
    const eurTyped = build(978, 840);
    expect(hashRevealBidTypedData(tryTyped)).not.toBe(hashRevealBidTypedData(eurTyped));
    const signature = await TEST_ACCOUNT.signTypedData(tryTyped);
    const material = await createRevealMaterial(
      {
        deploymentId: 'venue-upstream',
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        issuanceCurrency: 949,
        referenceCurrency: 840,
        quantity: 5,
        bidRate: 1_100,
        signature,
        createdAt: TEST_TIME,
      },
      { promisLoadMinor: 10n ** 18n },
    );
    expect(material.adapterProfile).toBe('multi-issuance-usd-reference');
    expect(material.schemaVersion).toBe(3);
    expect(material.issuanceCurrency).toBe(949);
    expect(material.referenceCurrency).toBe(840);
    expect(material.typedData.domain.version).toBe('1');
    await expect(validateRevealMaterial(material, { promisLoadMinor: 10n ** 18n })).resolves.toMatchObject({
      issuanceCurrency: 949,
      referenceCurrency: 840,
    });
  });

  it('creates and revalidates exact immutable reveal material', async () => {
    const material = await createTestMaterial();
    expect(Object.isFrozen(material)).toBe(true);
    expect(material.commitHash).toBe(keccak256(material.signature));
    expect((await validateRevealMaterial(material)).bidder).toBe(TEST_ACCOUNT.address);
  });

  it('rejects an altered signature byte', async () => {
    const material = clone(await createTestMaterial());
    material.signature = `${material.signature.slice(0, 4)}ff${material.signature.slice(6)}` as Hex;
    material.commitHash = keccak256(material.signature);
    await expect(validateRevealMaterial(material)).rejects.toMatchObject({
      code: 'invalid-signature-or-signer',
    });
  });

  it('rejects compact signatures, invalid v, and high-s malleability', async () => {
    const base = clone(await createTestMaterial());
    const compact = clone(base);
    compact.signature = compact.signature.slice(0, -2) as Hex;
    await expect(validateRevealMaterial(compact)).rejects.toMatchObject({ code: 'invalid-signature-or-signer' });

    const invalidV = clone(base);
    invalidV.signature = `${invalidV.signature.slice(0, -2)}00` as Hex;
    await expect(validateRevealMaterial(invalidV)).rejects.toMatchObject({ code: 'invalid-signature-or-signer' });

    const highS = clone(base);
    const canonicalS = BigInt(`0x${highS.signature.slice(66, 130)}`);
    const malleableS = (SECP256K1_N - canonicalS).toString(16).padStart(64, '0');
    const v = highS.signature.slice(-2).toLowerCase() === '1b' ? '1c' : '1b';
    highS.signature = `${highS.signature.slice(0, 66)}${malleableS}${v}` as Hex;
    highS.commitHash = keccak256(highS.signature);
    await expect(validateRevealMaterial(highS)).rejects.toMatchObject({ code: 'invalid-signature-or-signer' });
  });

  it('rejects signer mismatch', async () => {
    await expect(createTestMaterial({ bidder: OTHER_ACCOUNT.address, signer: TEST_ACCOUNT })).rejects.toMatchObject({
      code: 'invalid-signature-or-signer',
    });
  });

  it('rejects chain and verifying-contract domain mismatches', async () => {
    const material = clone(await createTestMaterial());
    material.typedData.domain.chainId = 1;
    await expect(validateRevealMaterial(material)).rejects.toMatchObject({ code: 'domain-mismatch' });

    const other = clone(await createTestMaterial());
    other.typedData.domain.verifyingContract = OTHER_ACCOUNT.address;
    await expect(validateRevealMaterial(other)).rejects.toMatchObject({ code: 'domain-mismatch' });
  });

  it('rejects a stored commit-hash mismatch', async () => {
    const material = clone(await createTestMaterial());
    material.commitHash = `0x${'11'.repeat(32)}`;
    await expect(validateRevealMaterial(material)).rejects.toMatchObject({ code: 'commit-hash-mismatch' });
  });

  it('enforces WWD, quantity, rate, issuance-currency, and chain boundaries', async () => {
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260229,
        quantity: 5,
        bidRate: 1_100,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('possible eight-digit');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 0,
        bidRate: 1_100,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('Quantity');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 65_536,
        bidRate: 1_100,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('Quantity');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 5,
        bidRate: 0,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('Bid rate');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 5,
        bidRate: 0x1_0000_0000,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('Bid rate');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 56,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 5,
        bidRate: 1_100,
        issuanceCurrency: 1_000,
        referenceCurrency: 840,
      }),
    ).toThrow('Issuance currency');
    expect(() =>
      buildRevealBidTypedData({
        chainId: 0,
        auctionProxy: TEST_AUCTION,
        bidder: TEST_ACCOUNT.address,
        worldwideDay: 20260108,
        quantity: 5,
        bidRate: 1_100,
        issuanceCurrency: 949,
        referenceCurrency: 840,
      }),
    ).toThrow('Chain ID');

    const boundary = await createTestMaterial({ quantity: 65_535, bidRate: 1_000_000, issuanceCurrency: 999 });
    expect(boundary.quantity).toBe(65_535);
    expect(boundary.bidRate).toBe(1_000_000);
    expect(boundary.issuanceCurrency).toBe(999);
  });

  it('rejects zero and overflowing authoritative reveal locks', async () => {
    const zeroLockTypedData = buildRevealBidTypedData({
      chainId: 56,
      auctionProxy: TEST_AUCTION,
      bidder: TEST_ACCOUNT.address,
      worldwideDay: 20260108,
      quantity: 1,
      bidRate: 1,
      issuanceCurrency: 949,
      referenceCurrency: 840,
    });
    const zeroLockSignature = await TEST_ACCOUNT.signTypedData(zeroLockTypedData);
    await expect(
      createRevealMaterial(
        {
          deploymentId: 'bsc-mainnet-v1',
          chainId: 56,
          auctionProxy: TEST_AUCTION,
          bidder: TEST_ACCOUNT.address,
          worldwideDay: 20260108,
          quantity: 1,
          bidRate: 1,
          issuanceCurrency: 949,
          referenceCurrency: 840,
          signature: zeroLockSignature,
          createdAt: TEST_TIME,
        },
        { promisLoadMinor: 1n },
      ),
    ).rejects.toMatchObject({ code: 'checksum-consistency-failure' });

    const overflow = await createTestMaterial({ quantity: 65_535, bidRate: 1_000_000 });
    await expect(validateRevealMaterial(overflow, { promisLoadMinor: (1n << 128n) - 1n })).rejects.toMatchObject({
      code: 'checksum-consistency-failure',
    });
  });

  it('rejects unsupported adapter profiles and unreviewed typed fields', async () => {
    const material = clone(await createTestMaterial()) as unknown as Record<string, unknown>;
    material.adapterProfile = 'future-profile';
    await expect(validateRevealMaterial(material)).rejects.toMatchObject({ code: 'unsupported-profile' });

    const typed = clone(await createTestMaterial()) as unknown as {
      typedData: { types: { RevealBid: { name: string; type: string }[] } };
    };
    typed.typedData.types.RevealBid.push({ name: 'salt', type: 'bytes32' });
    await expect(validateRevealMaterial(typed)).rejects.toMatchObject({ code: 'unsupported-profile' });

    const extraMessageField = clone(await createTestMaterial()) as unknown as {
      typedData: { message: Record<string, unknown> };
    };
    extraMessageField.typedData.message.destinationChainId = 56;
    await expect(validateRevealMaterial(extraMessageField)).rejects.toMatchObject({ code: 'unsupported-profile' });
  });
});
