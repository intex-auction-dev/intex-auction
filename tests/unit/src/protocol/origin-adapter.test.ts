import { describe, expect, it } from 'vitest';
import { OutbeAuctionAdapter } from '@/protocol/origin-adapter';
import {
  DESIS,
  FakeClient,
  INTEX,
  METADOSIS,
  ORIGIN_ROUTER,
  ORACLE,
  codeMap,
  decodedRevert,
  key,
  metadosisEventAbi,
  outbeProfile,
  worldwideDay,
} from './adapter-fixtures';

describe('Outbe auction adapter', () => {
  it('validates chain, OriginRouter code and Desis wiring', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([[key(ORIGIN_ROUTER, 'desis'), DESIS]]),
      codeMap(METADOSIS, DESIS, ORIGIN_ROUTER, ORACLE, INTEX),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).validateDeployment()).resolves.toBeUndefined();
  });

  it('validates an adapter instance only once', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([[key(ORIGIN_ROUTER, 'desis'), DESIS]]),
      codeMap(METADOSIS, DESIS, ORIGIN_ROUTER, ORACLE, INTEX),
    );
    const adapter = new OutbeAuctionAdapter(client, outbeProfile());

    await Promise.all([adapter.validateDeployment(), adapter.validateDeployment()]);
    await adapter.validateDeployment();

    expect(client.chainReads).toBe(1);
    expect(client.bytecodeReads).toBe(5);
    expect(client.readNames).toEqual(['desis']);
  });

  it('rejects a wrong chain before reading authority state', async () => {
    const client = new FakeClient(
      56,
      new Map<string, unknown>(),
      codeMap(METADOSIS, DESIS, ORIGIN_ROUTER, ORACLE, INTEX),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).validateDeployment()).rejects.toThrow(
      'Outbe chain mismatch',
    );
  });

  it('maps WorldwideDay lifecycle and type independently', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getWorldwideDay'), [6, 1, 1_000n, 1_100n, 1_200n, 1_300n, 1_400n, 990_000n, 995_000n]],
      ]),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).readWorldwideDay(worldwideDay())).resolves.toEqual({
      worldwideDay: '20260803',
      lifecycle: 'completed',
      dayType: 'green',
      formingStart: 1_000n,
      formingEnd: 1_100n,
      lookbackEnd: 1_200n,
      offeringEnd: 1_300n,
      scheduledProcessTime: 1_400n,
      previousVwap: 990_000n,
      currentVwap: 995_000n,
    });
  });

  it('discovers and validates retained WorldwideDay keys from active and closed records', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getActiveWorldwideDays'), [20260803, 20260801]],
        [
          key(METADOSIS, 'getWorldwideDaysByStatus'),
          (request: { args?: readonly unknown[] }) => (request.args?.[0] === 6 ? [20260802, 20260803] : [20260801]),
        ],
      ]),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).readRetainedWorldwideDays()).resolves.toEqual([
      '20260801',
      '20260802',
      '20260803',
    ]);
    expect(client.readNames).toEqual([
      'getActiveWorldwideDays',
      'getWorldwideDaysByStatus',
      'getWorldwideDaysByStatus',
    ]);
  });

  it('rejects malformed retained WorldwideDay keys', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getActiveWorldwideDays'), [20260229]],
        [key(METADOSIS, 'getWorldwideDaysByStatus'), []],
      ]),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).readRetainedWorldwideDays()).rejects.toThrow(
      'valid WorldwideDay key',
    );
  });

  it('rejects the reserved Metadosis lifecycle tag', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([[key(METADOSIS, 'getWorldwideDay'), [5, 1, 0, 0, 0, 0, 0, 0, 0]]]),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).readWorldwideDay(worldwideDay())).rejects.toThrow(
      'tag 5 is reserved',
    );
  });

  it('keeps global stage, venue intake and target inclusion separate', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(DESIS, 'getAuctionStage'), 4],
        [key(DESIS, 'getBidsCount'), 12n],
        [key(DESIS, 'getChainBidsCount'), 5n],
        [key(DESIS, 'isChainDone'), true],
        [key(ORIGIN_ROUTER, 'targetsOf'), [31337, 56]],
      ]),
    );

    await expect(
      new OutbeAuctionAdapter(client, outbeProfile()).readGlobalAuction(worldwideDay(), 31337),
    ).resolves.toEqual({
      stage: 'clearing',
      totalBids: 12n,
      venueBids: 5n,
      venueIntakeComplete: true,
      venueInTargetSnapshot: true,
    });
  });

  it('returns absent or mapped canonical series without inventing venue state', async () => {
    const absent = new FakeClient(31337, new Map<string, unknown>([[key(INTEX, 'seriesExists'), false]]));
    await expect(
      new OutbeAuctionAdapter(absent, outbeProfile()).readCanonicalSeries(
        `0x${(20260803).toString(16).padStart(28, '0')}`,
      ),
    ).resolves.toBeNull();

    const present = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(INTEX, 'seriesExists'), true],
        [
          key(INTEX, 'seriesData'),
          {
            seriesId: `0x${(20260803).toString(16).padStart(28, '0')}`,
            promisLoadMinor: 1_000n,
            entryPriceMinor: 100n,
            floorPriceMinor: 108n,
            issuedIntexCount: 50,
            callWindow: 2_592_000n,
            callThreshold: 1_814_400n,
            callPriceMinor: 228n,
            state: 1,
            issuedAt: 1_700_000_000n,
            calledAt: 0n,
            callNoticePeriod: 604_800n,
            issuanceCurrency: 840,
            referenceCurrency: 840,
            worldwideDay: 20260803,
            costAmountMinor: 0n,
          },
        ],
      ]),
    );

    await expect(
      new OutbeAuctionAdapter(present, outbeProfile()).readCanonicalSeries(
        `0x${(20260803).toString(16).padStart(28, '0')}`,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        seriesId: `0x${(20260803).toString(16).padStart(28, '0')}`,
        promisLoadMinor: 1_000n,
        issuedIntexCount: 50,
        intexCallPeriod: 604_800n,
      }),
    );
  });

  it('classifies exact unknown WorldwideDay as not found', async () => {
    const profile = outbeProfile();
    profile.abis.metadosis = metadosisEventAbi;
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getWorldwideDay'), decodedRevert('Error', ['WorldwideDay not found'])],
        [key(METADOSIS, 'getWorldwideDayTerminalReceipt'), [0, 0, 0, 0, 0, 0]],
      ]),
    );

    await expect(new OutbeAuctionAdapter(client, profile).readWorldwideDayState(worldwideDay())).resolves.toEqual({
      kind: 'not-found',
    });
  });

  it('classifies durable terminal evidence as history unavailable', async () => {
    const profile = outbeProfile();
    profile.abis.metadosis = metadosisEventAbi;
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getWorldwideDay'), decodedRevert('UnknownWorldwideDay', [20260803])],
        [key(METADOSIS, 'getWorldwideDayTerminalReceipt'), [1, 10n, 20n, 30n, 1, 40n]],
      ]),
    );

    await expect(new OutbeAuctionAdapter(client, profile).readWorldwideDayState(worldwideDay())).resolves.toEqual({
      kind: 'history-unavailable',
      terminal: {
        disposition: 'missed-offering',
        valueRouted: 10n,
        carryOverBefore: 20n,
        carryOverAfter: 30n,
        retirement: 'not-present',
        blockNumber: 40n,
      },
      cleanedFinalLifecycle: null,
    });
  });

  it('uses cleanup evidence when the retained record and terminal receipt are unavailable', async () => {
    const profile = outbeProfile();
    profile.abis.metadosis = metadosisEventAbi;
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([
        [key(METADOSIS, 'getWorldwideDay'), decodedRevert('UnknownWorldwideDay', [20260803])],
        [key(METADOSIS, 'getWorldwideDayTerminalReceipt'), [0, 0, 0, 0, 0, 0]],
      ]),
      new Map(),
      [{ args: { worldwideDay: 20260803, finalStatus: 6 } }],
    );

    await expect(new OutbeAuctionAdapter(client, profile).readWorldwideDayState(worldwideDay())).resolves.toEqual({
      kind: 'history-unavailable',
      terminal: null,
      cleanedFinalLifecycle: 'completed',
    });
  });

  it('keeps unknown revert data as a technical failure', async () => {
    const client = new FakeClient(
      31337,
      new Map<string, unknown>([[key(METADOSIS, 'getWorldwideDay'), decodedRevert('UnexpectedFailure')]]),
    );

    await expect(new OutbeAuctionAdapter(client, outbeProfile()).readWorldwideDayState(worldwideDay())).rejects.toThrow(
      'UnexpectedFailure',
    );
  });
});
