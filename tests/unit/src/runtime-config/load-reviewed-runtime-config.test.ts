import { describe, expect, it, vi } from 'vitest';
import { loadReviewedRuntimeConfig } from '@/runtime-config/load-reviewed-runtime-config';

const address = (digit: string): string => `0x${digit.repeat(40)}`;

const documents = (enabled = true, defaultVenueChainId = 31337) => ({
  '/config/chains.json': {
    schemaVersion: 1,
    originChainProfileId: 'origin',
    defaultDisconnectedVenueChainId: defaultVenueChainId,
    chains: [
      {
        id: 'origin',
        roles: ['origin'],
        enabled,
        chainId: enabled ? 31337 : null,
        name: 'Local Outbe',
        nativeCurrency: enabled ? { name: 'ETH', symbol: 'ETH', decimals: 18 } : null,
        explorerUrl: null,
        rpcUrls: ['http://127.0.0.1:8545', 'http://localhost:8545'],
        confirmationDepth: 1,
        logBatchSize: 2_000,
        requestTimeoutMs: 9_000,
        readRetryCount: 1,
      },
      {
        id: 'venue',
        roles: ['venue'],
        enabled,
        chainId: 31337,
        name: 'Local Venue',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        explorerUrl: 'https://explorer.example',
        rpcUrls: ['http://127.0.0.1:9545'],
        confirmationDepth: 1,
        logBatchSize: 2_000,
        requestTimeoutMs: 8_000,
        readRetryCount: 2,
      },
    ],
  },
  '/config/deployments.json': {
    schemaVersion: 1,
    deployments: [
      {
        id: 'origin-deployment',
        roles: ['origin'],
        enabled,
        chainProfileId: 'origin',
        chainId: enabled ? 31337 : null,
        deploymentBlock: enabled ? 10 : null,
        addresses: {
          metadosis: enabled ? address('1') : null,
          desis: enabled ? address('2') : null,
          originRouter: enabled ? address('3') : null,
          oracle: enabled ? address('4') : null,
          intex: enabled ? address('5') : null,
        },
        abiFiles: {
          metadosis: './abi/IMetadosis.json',
          desis: './abi/IDesis.json',
          originRouter: './abi/OriginRouter.json',
          oracle: './abi/IOracle.json',
          intex: './abi/IIntex.json',
        },
        oraclePair: { base: enabled ? address('0') : null, quote: enabled ? address('a') : null },
      },
      {
        id: 'venue-deployment',
        roles: ['venue'],
        enabled,
        chainProfileId: 'venue',
        adapterProfile: 'multi-issuance-usd-reference',
        chainId: 31337,
        deploymentBlock: enabled ? 20 : null,
        addresses: {
          intexAuction: enabled ? address('6') : null,
          intexAuctionImplementation: enabled ? address('c') : null,
          escrowAdapter: enabled ? address('7') : null,
          targetRouter: enabled ? address('8') : null,
          theCompact: enabled ? address('9') : null,
          paymentToken: enabled ? address('a') : null,
          intexNFT1155: enabled ? address('b') : null,
        },
        abiFiles: {
          intexAuction: './abi/IntexAuction.json',
          escrowAdapter: './abi/EscrowAdapter.json',
          targetRouter: './abi/TargetRouter.json',
          theCompact: './abi/TheCompact.json',
          paymentToken: './abi/ERC20.json',
          intexNFT1155: './abi/IntexNFT1155.json',
        },
      },
    ],
  },
  '/config/walletconnect.json': {
    schemaVersion: 1,
    enabled: false,
    projectId: '',
    metadata: { name: 'Auction', description: 'Read only', url: 'http://localhost', icons: [] },
  },
  '/config/timing.json': {
    schemaVersion: 1,
    bidsFanInTimeoutSeconds: 43200,
  },
});

const fetcherFor = (values: Record<string, unknown>, malformedAbi?: string) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/config/abi/')) {
      return new Response(JSON.stringify(url === malformedAbi ? { not: 'an ABI' } : []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = values[url];
    return body === undefined
      ? new Response('Not found', { status: 404 })
      : new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
  });

describe('reviewed runtime bootstrap', () => {
  it('resolves executable origin and selected venue profiles from one reviewed load', async () => {
    const runtime = await loadReviewedRuntimeConfig(fetcherFor(documents()));

    expect(runtime.evaluation.state).toBe('ready');
    expect(runtime.origin).toEqual(
      expect.objectContaining({
        id: 'origin',
        deploymentId: 'origin-deployment',
        deploymentBlock: 10n,
        chainId: 31337,
        rpcUrls: ['http://127.0.0.1:8545', 'http://localhost:8545'],
        requestTimeoutMs: 9_000,
        addresses: expect.objectContaining({ metadosis: expect.stringMatching(/^0x/) }),
      }),
    );
    expect(runtime.selectedVenue).toEqual(
      expect.objectContaining({
        id: 'venue',
        deploymentId: 'venue-deployment',
        deploymentBlock: 20n,
        chainId: 31337,
        requestTimeoutMs: 8_000,
        explorerUrl: 'https://explorer.example/',
        addresses: expect.objectContaining({
          theCompact: expect.stringMatching(/^0x/),
          intexAuctionImplementation: expect.stringMatching(/^0x/),
          paymentToken: expect.stringMatching(/^0x/),
        }),
      }),
    );
    expect(runtime.venues).toHaveLength(1);
    expect(runtime.timing).toEqual({ bidsFanInTimeoutSeconds: 43200 });
  });

  it('fails closed when the configured disconnected venue is missing', async () => {
    const runtime = await loadReviewedRuntimeConfig(fetcherFor(documents(true, 56)));
    expect(runtime.evaluation.state).toBe('invalid');
    expect(runtime.evaluation.networkAccessAllowed).toBe(false);
    expect(runtime.selectedVenue).toBeNull();
  });

  it('disables an enabled profile when an ABI response is malformed', async () => {
    const runtime = await loadReviewedRuntimeConfig(fetcherFor(documents(), '/config/abi/IMetadosis.json'));
    expect(runtime.evaluation.state).toBe('invalid');
    expect(runtime.origin).toBeNull();
    expect(runtime.evaluation.issues.map((issue) => issue.code)).toContain('missing-abi-file');
  });

  it('loads no ABI files for disabled profiles', async () => {
    const fetcher = fetcherFor(documents(false));
    const runtime = await loadReviewedRuntimeConfig(fetcher);
    expect(runtime.evaluation.state).toBe('not-configured');
    expect(fetcher.mock.calls.map(([input]) => String(input)).some((url) => url.includes('/abi/'))).toBe(false);
  });
});
