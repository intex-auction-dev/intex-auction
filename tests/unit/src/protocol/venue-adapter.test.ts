import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { VenueAuctionAdapter } from '@/protocol/venue-adapter';
import { VenueAuctionNotFoundError } from '@/chain/revert-classify';
import {
  AUCTION,
  ESCROW,
  FakeClient,
  IMPLEMENTATION,
  NFT,
  PAYMENT,
  TARGET_ROUTER,
  address,
  codeMap,
  decodedRevert,
  implementationStorage,
  key,
  reviewedVenueProfile,
  reviewedVenueReads,
  venueProfile,
  worldwideDay,
} from './adapter-fixtures';

describe('venue auction adapter', () => {
  it('validates bytecode and bidirectional wiring', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(TARGET_ROUTER, 'auction'), AUCTION],
        [key(TARGET_ROUTER, 'escrowAdapter'), ESCROW],
        [key(TARGET_ROUTER, 'intex'), NFT],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(ESCROW, 'intexAuctionContract'), AUCTION],
        [key(ESCROW, 'paymentToken'), PAYMENT],
      ]),
      codeMap(AUCTION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).validateDeployment()).resolves.toBeUndefined();
  });

  it('validates the reviewed proxy implementation and EIP-712 domain when configured', async () => {
    const client = new FakeClient(
      31337,
      reviewedVenueReads(),
      codeMap(AUCTION, IMPLEMENTATION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
      [],
      implementationStorage(IMPLEMENTATION),
    );

    await expect(new VenueAuctionAdapter(client, reviewedVenueProfile()).validateDeployment()).resolves.toBeUndefined();
  });

  it('rejects a proxy implementation that differs from reviewed evidence', async () => {
    const client = new FakeClient(
      31337,
      reviewedVenueReads(),
      codeMap(AUCTION, IMPLEMENTATION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
      [],
      implementationStorage(address('c')),
    );

    await expect(new VenueAuctionAdapter(client, reviewedVenueProfile()).validateDeployment()).rejects.toThrow(
      'proxy implementation',
    );
  });

  it('rejects an EIP-712 domain that differs from the reviewed proxy domain', async () => {
    const client = new FakeClient(
      31337,
      reviewedVenueReads(
        new Map([
          [key(AUCTION, 'eip712Domain'), ['0x0f', 'IntexAuction', '2', 31337n, AUCTION, `0x${'0'.repeat(64)}`, []]],
        ]),
      ),
      codeMap(AUCTION, IMPLEMENTATION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
      [],
      implementationStorage(IMPLEMENTATION),
    );

    await expect(new VenueAuctionAdapter(client, reviewedVenueProfile()).validateDeployment()).rejects.toThrow(
      'EIP-712 domain',
    );
  });

  it('validates a venue adapter instance only once', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(TARGET_ROUTER, 'auction'), AUCTION],
        [key(TARGET_ROUTER, 'escrowAdapter'), ESCROW],
        [key(TARGET_ROUTER, 'intex'), NFT],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(ESCROW, 'intexAuctionContract'), AUCTION],
        [key(ESCROW, 'paymentToken'), PAYMENT],
      ]),
      codeMap(AUCTION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
    );
    const adapter = new VenueAuctionAdapter(client, venueProfile());

    await Promise.all([adapter.validateDeployment(), adapter.validateDeployment()]);
    await adapter.validateDeployment();

    expect(client.chainReads).toBe(1);
    expect(client.bytecodeReads).toBe(5);
    expect(client.readNames).toHaveLength(6);
  });

  it('rejects missing bytecode and incompatible wiring', async () => {
    const noCode = new FakeClient(31337, new Map<string, unknown>());
    await expect(new VenueAuctionAdapter(noCode, venueProfile()).validateDeployment()).rejects.toThrow(
      'has no bytecode',
    );

    const wrongWiring = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(TARGET_ROUTER, 'auction'), address('b')],
        [key(TARGET_ROUTER, 'escrowAdapter'), ESCROW],
        [key(TARGET_ROUTER, 'intex'), NFT],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(ESCROW, 'intexAuctionContract'), AUCTION],
        [key(ESCROW, 'paymentToken'), PAYMENT],
      ]),
      codeMap(AUCTION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
    );
    await expect(new VenueAuctionAdapter(wrongWiring, venueProfile()).validateDeployment()).rejects.toThrow(
      'TargetRouter auction wiring',
    );
  });

  it('rejects payment-token wiring that does not match configuration', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(TARGET_ROUTER, 'auction'), AUCTION],
        [key(TARGET_ROUTER, 'escrowAdapter'), ESCROW],
        [key(TARGET_ROUTER, 'intex'), NFT],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(ESCROW, 'intexAuctionContract'), AUCTION],
        [key(ESCROW, 'paymentToken'), address('b')],
      ]),
      codeMap(AUCTION, ESCROW, TARGET_ROUTER, NFT, PAYMENT),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).validateDeployment()).rejects.toThrow(
      'payment-token wiring',
    );
  });

  it('classifies only the exact AuctionNotFound custom error as venue absence', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), decodedRevert('AuctionNotFound')],
        [key(AUCTION, 'getAuctionInfo'), decodedRevert('AuctionNotFound')],
        [key(AUCTION, 'auctionRunningCounts'), decodedRevert('AuctionNotFound')],
      ]),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).readAuction(worldwideDay())).rejects.toBeInstanceOf(
      VenueAuctionNotFoundError,
    );
  });

  it('classifies AuctionNotFound as venue absence for recovery-state reads', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), decodedRevert('AuctionNotFound')],
        [key(AUCTION, 'getAuctionInfo'), decodedRevert('AuctionNotFound')],
        [key(AUCTION, 'escrowContract'), ESCROW],
        [key(AUCTION, 'UNREVEALED_BOND_LOCK_PERIOD'), 86_400],
      ]),
    );

    await expect(
      new VenueAuctionAdapter(client, venueProfile()).readAuctionRecoveryState(worldwideDay()),
    ).rejects.toBeInstanceOf(VenueAuctionNotFoundError);
  });

  it('keeps an unknown venue revert as a technical failure', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), decodedRevert('UnexpectedFailure')],
        [key(AUCTION, 'getAuctionInfo'), decodedRevert('UnexpectedFailure')],
        [key(AUCTION, 'auctionRunningCounts'), decodedRevert('UnexpectedFailure')],
      ]),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).readAuction(worldwideDay())).rejects.toThrow(
      'UnexpectedFailure',
    );
  });

  it('maps the current venue schedule, reference prices and result', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), 0],
        [key(AUCTION, 'auctionRunningCounts'), [3, 1]],
        [
          key(AUCTION, 'getAuctionInfo'),
          {
            worldwideDayState: 1,
            schedule: {
              commitEnd: 1_000n,
              revealEnd: 2_000n,
              issuanceEnd: 3_000n,
            },
            params: {
              prices: [
                {
                  isoCode: 840,
                  entryPriceMinor: 100n,
                  floorPriceMinor: 108n,
                  callPriceMinor: 228n,
                },
              ],
              promisLoadMinor: 1_000n,
              callTrigger: {
                callWindow: 2_592_000,
                callThreshold: 1_814_400,
                callNoticePeriod: 604_800n,
              },
              minIntexBidRate: 500_000,
              minIntexBidQuantity: 2,
              commitBondMinor: 10n,
            },
            runningCounts: {
              committedBids: 3,
              revealedBids: 1,
            },
            result: {
              auctionClearingRate: 700_000n,
              wonBidsCount: 2,
              issuedIntexCount: 50,
              issuedIntexLoadedPromis: 50_000n,
            },
          },
        ],
      ]),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).readAuction(worldwideDay())).resolves.toEqual({
      worldwideDay: '20260803',
      stage: 'committing-bids',
      dayType: 'green',
      paymentToken: getAddress(PAYMENT),
      schedule: {
        commitEnd: 1_000n,
        revealEnd: 2_000n,
        issuanceEnd: 3_000n,
      },
      params: {
        issuanceCurrency: 0,
        issuanceCurrencies: [],
        referenceCurrency: 840,
        referenceCurrencies: [840],
        referenceEntryPrices: [100n],
        promisLoadMinor: 1_000n,
        minIntexBidRate: 500_000,
        minIntexBidQuantity: 2,
        entryPriceMinor: 100n,
        floorPriceMinor: 108n,
        callPriceMinor: 228n,
        commitBondMinor: 10n,
        callTrigger: {
          windowDays: 30,
          thresholdDays: 21,
          intexCallPeriod: 604_800n,
        },
      },
      runningCounts: {
        committedBids: 3,
        revealedBids: 1,
      },
      result: {
        auctionClearingRate: 700_000n,
        wonBidsCount: 2,
        issuedIntexCount: 50,
        issuedIntexLoadedPromis: 50_000n,
      },
    });
  });

  it('rejects an impossible delivered unknown day state', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(AUCTION, 'getAuctionStage'), 0],
        [key(AUCTION, 'auctionRunningCounts'), [0, 0]],
        [
          key(AUCTION, 'getAuctionInfo'),
          {
            worldwideDayState: 0,
            schedule: { commitEnd: 1n, revealEnd: 2n, issuanceEnd: 3n },
            params: {
              prices: [{ isoCode: 840, entryPriceMinor: 1n, floorPriceMinor: 1n, callPriceMinor: 1n }],
              promisLoadMinor: 1n,
              callTrigger: { callWindow: 86_400, callThreshold: 86_400, callNoticePeriod: 1n },
              minIntexBidRate: 1,
              minIntexBidQuantity: 1,
              commitBondMinor: 0n,
            },
            result: {
              auctionClearingRate: 0n,
              wonBidsCount: 0,
              issuedIntexCount: 0,
              issuedIntexLoadedPromis: 0n,
            },
          },
        ],
      ]),
    );

    await expect(new VenueAuctionAdapter(client, venueProfile()).readAuction(worldwideDay())).rejects.toThrow(
      'cannot persist an unknown WorldwideDay state',
    );
  });
});
