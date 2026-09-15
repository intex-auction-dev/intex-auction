import { describe, expect, it, vi } from 'vitest';
import {
  collectEnabledAbiFiles,
  loadRuntimeConfig,
  loadRuntimeConfigData,
  validateRuntimeConfig,
  type RuntimeConfigDocuments,
} from '@/runtime-config/runtime-config';

const address = (digit: string): string => `0x${digit.repeat(40)}`;
const REVIEWED_SOURCE = 'outbe/outbe-chain@f5477b56c9a4192755354a3f2577603dffe5b3a6';

const disabledDocuments = (): RuntimeConfigDocuments => ({
  chains: {
    schemaVersion: 1,
    originChainProfileId: 'outbe-origin',
    defaultDisconnectedVenueChainId: 56,
    chains: [
      {
        id: 'outbe-origin',
        roles: ['origin'],
        enabled: false,
        chainId: null,
        name: 'Outbe',
        nativeCurrency: null,
        explorerUrl: null,
        rpcUrls: ['https://replace-me-rpc.invalid/outbe-origin'],
        confirmationDepth: 5,
        logBatchSize: 2000,
        requestTimeoutMs: 15000,
        readRetryCount: 2,
      },
      {
        id: 'bnb-mainnet',
        roles: ['venue'],
        enabled: false,
        chainId: 56,
        name: 'BNB Smart Chain',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        explorerUrl: 'https://bscscan.com',
        rpcUrls: ['https://replace-me-rpc.invalid/bnb-mainnet'],
        confirmationDepth: 5,
        logBatchSize: 2000,
        requestTimeoutMs: 15000,
        readRetryCount: 2,
      },
    ],
  },
  deployments: {
    schemaVersion: 1,
    deployments: [
      {
        id: 'outbe-origin-default',
        roles: ['origin'],
        enabled: false,
        chainProfileId: 'outbe-origin',
        chainId: null,
        deploymentBlock: null,
        addresses: { metadosis: null, desis: null, originRouter: null, oracle: null, intex: null },
        abiFiles: {
          metadosis: './abi/IMetadosis.json',
          desis: './abi/IDesis.json',
          originRouter: './abi/OriginRouter.json',
          oracle: './abi/IOracle.json',
          intex: './abi/IIntex.json',
        },
        oraclePair: { base: null, quote: null },
      },
      {
        id: 'bnb-mainnet-default',
        roles: ['venue'],
        enabled: false,
        chainProfileId: 'bnb-mainnet',
        chainId: 56,
        deploymentBlock: null,
        addresses: {
          intexAuction: null,
          escrowAdapter: null,
          targetRouter: null,
          theCompact: null,
          paymentToken: null,
          intexNFT1155: null,
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
  walletConnect: {
    schemaVersion: 1,
    enabled: false,
    projectId: '',
    metadata: {
      name: 'Intex Auction',
      description: 'Local bidder application',
      url: 'http://127.0.0.1:4173',
      icons: [],
    },
  },
  timing: {
    schemaVersion: 1,
    bidsFanInTimeoutSeconds: 43200,
  },
});

const clone = <T>(value: T): T => structuredClone(value);

const enableOrigin = (documents: RuntimeConfigDocuments): void => {
  const chains = documents.chains as { chains: Array<Record<string, unknown>> };
  const originChain = chains.chains[0];
  if (!originChain) throw new Error('Missing origin fixture.');
  Object.assign(originChain, {
    enabled: true,
    chainId: 1,
    nativeCurrency: { name: 'Outbe', symbol: 'OUT', decimals: 18 },
    rpcUrls: ['https://rpc.example.com/outbe'],
    explorerUrl: 'https://explorer.example.com/outbe',
  });

  const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
  const originDeployment = deployments.deployments[0];
  if (!originDeployment) throw new Error('Missing origin deployment fixture.');
  Object.assign(originDeployment, {
    enabled: true,
    chainId: 1,
    deploymentBlock: 100,
    reviewedSourceCommit: REVIEWED_SOURCE,
    addresses: {
      metadosis: address('1'),
      desis: address('2'),
      originRouter: address('3'),
      oracle: address('4'),
      intex: address('5'),
    },
    oraclePair: { base: address('0'), quote: address('a') },
  });
};

const enableVenue = (documents: RuntimeConfigDocuments): void => {
  const chains = documents.chains as { chains: Array<Record<string, unknown>> };
  const venueChain = chains.chains[1];
  if (!venueChain) throw new Error('Missing venue fixture.');
  Object.assign(venueChain, {
    enabled: true,
    rpcUrls: ['https://rpc.example.com/bnb'],
  });

  const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
  const venueDeployment = deployments.deployments[1];
  if (!venueDeployment) throw new Error('Missing venue deployment fixture.');
  Object.assign(venueDeployment, {
    enabled: true,
    adapterProfile: 'multi-issuance-usd-reference',
    deploymentBlock: 200,
    reviewedSourceCommit: REVIEWED_SOURCE,
    addresses: {
      intexAuction: address('3'),
      intexAuctionImplementation: address('9'),
      escrowAdapter: address('4'),
      targetRouter: address('5'),
      theCompact: address('6'),
      paymentToken: address('7'),
      intexNFT1155: address('8'),
    },
  });
};

const allEnabledAbisAvailable = (documents: RuntimeConfigDocuments): Map<string, boolean> =>
  new Map(collectEnabledAbiFiles(documents.deployments).map((file) => [file, true]));

const issueCodes = (documents: RuntimeConfigDocuments): string[] => {
  const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));
  return result.issues.map((issue) => issue.code);
};

const HOSTED_DEVELOPMENT_ORIGIN = 'https://auction.example';

const hostedDevelopmentDocuments = (): RuntimeConfigDocuments => {
  const documents = disabledDocuments();
  enableOrigin(documents);
  enableVenue(documents);

  const chains = documents.chains as {
    defaultDisconnectedVenueChainId: number;
    chains: Array<Record<string, unknown>>;
  };
  for (const chain of chains.chains) {
    Object.assign(chain, {
      chainId: 31337,
      developmentChain: true,
      explorerUrl: null,
      rpcUrls: [`${HOSTED_DEVELOPMENT_ORIGIN}/rpc`],
    });
  }
  chains.defaultDisconnectedVenueChainId = 31337;

  const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
  for (const deployment of deployments.deployments) {
    deployment.chainId = 31337;
    delete deployment.reviewedSourceCommit;
  }
  const venueDeployment = deployments.deployments[1];
  if (!venueDeployment) throw new Error('Missing venue deployment fixture.');
  delete (venueDeployment.addresses as Record<string, unknown>).intexAuctionImplementation;

  return documents;
};

const originAwareIssueCodes = (documents: RuntimeConfigDocuments, applicationOrigin: string): string[] =>
  validateRuntimeConfig(documents, allEnabledAbisAvailable(documents), applicationOrigin).issues.map(
    (issue) => issue.code,
  );

describe('runtime configuration', () => {
  it('boots valid disabled origin and venue profiles without requesting RPC or ABI URLs', async () => {
    const documents = disabledDocuments();
    const responses = new Map<string, unknown>([
      ['/config/chains.json', documents.chains],
      ['/config/deployments.json', documents.deployments],
      ['/config/walletconnect.json', documents.walletConnect],
      ['/config/timing.json', documents.timing],
    ]);
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = responses.get(url);
      return body
        ? new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('Not found', { status: 404 });
    });

    const result = await loadRuntimeConfig(fetcher);

    expect(result.state).toBe('not-configured');
    expect(result.networkAccessAllowed).toBe(false);
    expect(calls).toEqual([
      '/config/chains.json',
      '/config/deployments.json',
      '/config/walletconnect.json',
      '/config/timing.json',
    ]);
    expect(calls.some((url) => url.includes('.invalid'))).toBe(false);
    expect(calls.some((url) => url.includes('/abi/'))).toBe(false);
  });

  it('rejects a missing designated origin profile', () => {
    const documents = disabledDocuments();
    (documents.chains as Record<string, unknown>).originChainProfileId = 'missing-origin';

    const result = validateRuntimeConfig(documents);

    expect(result.state).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('missing-designated-origin');
  });

  it('requires the complete reviewed origin authority and configured Oracle pair', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const origin = deployments.deployments[0];
    if (!origin) throw new Error('Missing origin fixture.');
    origin.addresses = { metadosis: null, oracle: null };
    origin.oraclePair = { base: null, quote: null };

    const codes = issueCodes(documents);

    expect(codes.filter((code) => code === 'missing-required-address')).toHaveLength(5);
    expect(codes).toContain('missing-oracle-pair');
  });

  it('rejects duplicate origin-role chain profiles', () => {
    const documents = disabledDocuments();
    const chains = documents.chains as { chains: Array<Record<string, unknown>> };
    chains.chains[1] = { ...chains.chains[1], roles: ['origin', 'venue'] };

    const result = validateRuntimeConfig(documents);

    expect(result.state).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('origin-profile-count');
  });

  it('keeps an enabled venue read- and write-incapable when origin is disabled', () => {
    const documents = disabledDocuments();
    enableVenue(documents);

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));
    const venue = result.venueProfiles.find((profile) => profile.id === 'bnb-mainnet');

    expect(result.state).toBe('invalid');
    expect(venue?.readCapable).toBe(false);
    expect(venue?.writeCapable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('origin-unavailable');
  });

  it('blocks an enabled venue when the designated origin chain is incompatible', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const origin = deployments.deployments[0];
    if (!origin) throw new Error('Missing origin fixture.');
    origin.chainId = 2;

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));
    const venue = result.venueProfiles.find((profile) => profile.id === 'bnb-mainnet');

    expect(result.state).toBe('invalid');
    expect(result.originProfile?.readCapable).toBe(false);
    expect(venue?.readCapable).toBe(false);
    expect(venue?.writeCapable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('deployment-chain-mismatch');
  });

  it('isolates a malformed disabled venue profile while retaining a valid enabled origin', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    const chains = documents.chains as { chains: unknown[] };
    chains.chains[1] = 'malformed';

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(result.state).toBe('invalid');
    expect(result.originProfile?.readCapable).toBe(true);
    expect(result.networkAccessAllowed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-chain-profile');
  });

  it('isolates a malformed disabled deployment profile', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    const deployments = documents.deployments as { deployments: unknown[] };
    deployments.deployments[1] = 'malformed';

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(result.state).toBe('invalid');
    expect(result.originProfile?.readCapable).toBe(true);
    expect(result.networkAccessAllowed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-deployment-profile');
  });

  it('blocks an enabled deployment when a required ABI file is missing', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    const availability = allEnabledAbisAvailable(documents);
    availability.set('./abi/IOracle.json', false);

    const result = validateRuntimeConfig(documents, availability);

    expect(result.state).toBe('invalid');
    expect(result.originProfile?.readCapable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-abi-file');
  });

  it('blocks an enabled deployment when a required address is missing', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const origin = deployments.deployments[0];
    if (!origin) throw new Error('Missing origin fixture.');
    origin.addresses = {
      metadosis: null,
      desis: address('2'),
      originRouter: address('3'),
      oracle: address('4'),
      intex: address('5'),
    };

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(result.state).toBe('invalid');
    expect(result.originProfile?.readCapable).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-required-address');
  });

  it('rejects an enabled deployment that references a disabled chain', () => {
    const documents = disabledDocuments();
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const origin = deployments.deployments[0];
    if (!origin) throw new Error('Missing origin fixture.');
    Object.assign(origin, {
      enabled: true,
      chainId: 1,
      deploymentBlock: 100,
      addresses: {
        metadosis: address('1'),
        desis: address('2'),
        originRouter: address('3'),
        oracle: address('4'),
        intex: address('5'),
      },
      oraclePair: { base: address('0'), quote: address('a') },
    });

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(result.state).toBe('invalid');
    expect(result.issues.map((issue) => issue.code)).toContain('deployment-on-disabled-chain');
  });

  it('accepts complete enabled origin and venue profiles', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(result.state).toBe('ready');
    expect(result.originProfile?.readCapable).toBe(true);
    expect(result.venueProfiles[0]?.readCapable).toBe(true);
    expect(result.venueProfiles[0]?.writeCapable).toBe(true);
  });

  it('rejects an enabled external deployment with unreviewed source provenance', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    deployments.deployments[0]!.reviewedSourceCommit = 'outbe/outbe-chain@deadbeef';

    expect(issueCodes(documents)).toContain('reviewed-source-mismatch');
  });

  it('rejects ABI substitution in an enabled reviewed deployment', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const venue = deployments.deployments[1]!;
    (venue.abiFiles as Record<string, string>).intexAuction = './abi/ERC20.json';

    expect(issueCodes(documents)).toContain('reviewed-abi-mismatch');
  });

  it('requires reviewed IntexAuction implementation evidence for an external venue', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);
    const deployments = documents.deployments as { deployments: Array<Record<string, unknown>> };
    const venue = deployments.deployments[1]!;
    (venue.addresses as Record<string, unknown>).intexAuctionImplementation = null;

    expect(issueCodes(documents)).toContain('missing-reviewed-implementation');
  });

  it('requires explorer metadata for enabled external chains', () => {
    const documents = disabledDocuments();
    enableOrigin(documents);
    enableVenue(documents);
    const chains = documents.chains as { chains: Array<Record<string, unknown>> };
    chains.chains[0]!.explorerUrl = null;

    expect(issueCodes(documents)).toContain('missing-explorer-url');
  });

  it('accepts a development chain served from the application origin', () => {
    const documents = hostedDevelopmentDocuments();

    const result = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents), HOSTED_DEVELOPMENT_ORIGIN);

    expect(result.issues).toEqual([]);
    expect(result.state).toBe('ready');
    expect(result.originProfile?.readCapable).toBe(true);
    expect(result.originProfile?.developmentChain).toBe(true);
    expect(result.venueProfiles[0]?.writeCapable).toBe(true);
  });

  it('applies external chain requirements when the same documents load from another origin', () => {
    const documents = hostedDevelopmentDocuments();

    const codes = originAwareIssueCodes(documents, 'http://127.0.0.1:4173');

    expect(codes).toContain('missing-explorer-url');
    expect(codes).toContain('reviewed-source-mismatch');
    expect(codes).toContain('missing-reviewed-implementation');
  });

  it('does not let the development flag exempt a third-party RPC origin', () => {
    const documents = hostedDevelopmentDocuments();
    const chains = documents.chains as { chains: Array<Record<string, unknown>> };
    for (const chain of chains.chains) {
      chain.rpcUrls = ['https://rpc.example.com/venue'];
    }

    const codes = originAwareIssueCodes(documents, HOSTED_DEVELOPMENT_ORIGIN);

    expect(codes).toContain('missing-explorer-url');
    expect(codes).toContain('reviewed-source-mismatch');
    expect(codes).toContain('missing-reviewed-implementation');
  });

  it('rejects a non-boolean development chain flag', () => {
    const documents = hostedDevelopmentDocuments();
    const chains = documents.chains as { chains: Array<Record<string, unknown>> };
    chains.chains[0]!.developmentChain = 'yes';

    const codes = originAwareIssueCodes(documents, HOSTED_DEVELOPMENT_ORIGIN);

    expect(codes).toContain('invalid-development-chain-flag');
  });

  it('accepts WalletConnect metadata for the origin the application was loaded from', () => {
    const documents = hostedDevelopmentDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = 'real-project-id';
    walletConnect.metadata = {
      name: 'Intex Auction',
      description: 'Development bidder application',
      url: HOSTED_DEVELOPMENT_ORIGIN,
      icons: [`${HOSTED_DEVELOPMENT_ORIGIN}/walletconnect-icon.svg`],
    };

    const hosted = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents), HOSTED_DEVELOPMENT_ORIGIN);
    const loopback = validateRuntimeConfig(documents, allEnabledAbisAvailable(documents));

    expect(hosted.walletConnect.usable).toBe(true);
    expect(loopback.walletConnect.usable).toBe(false);
    expect(loopback.walletConnect.issues.map((issue) => issue.code)).toContain('incomplete-walletconnect-metadata');
  });

  it('loads runtime configuration against a supplied application origin', async () => {
    const documents = hostedDevelopmentDocuments();
    const bodies: Record<string, unknown> = {
      '/config/chains.json': documents.chains,
      '/config/deployments.json': documents.deployments,
      '/config/walletconnect.json': documents.walletConnect,
      '/config/timing.json': documents.timing,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url in bodies) {
        return new Response(JSON.stringify(bodies[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const evaluation = await loadRuntimeConfig(fetcher, HOSTED_DEVELOPMENT_ORIGIN);

    expect(evaluation.issues).toEqual([]);
    expect(evaluation.state).toBe('ready');
    expect(evaluation.networkAccessAllowed).toBe(true);
  });

  it('does not mutate input documents during validation', () => {
    const documents = disabledDocuments();
    const before = clone(documents);

    validateRuntimeConfig(documents);

    expect(documents).toEqual(before);
  });

  it('keeps configuration not-configured when only WalletConnect is enabled and usable', () => {
    // A client build may enable WalletConnect before enabling a network profile. That is a valid,
    // non-transaction-capable state and must not render as an invalid configuration.
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = 'real-project-id';

    const result = validateRuntimeConfig(documents);

    expect(result.walletConnect.usable).toBe(true);
    expect(result.walletConnect.issues).toEqual([]);
    expect(result.state).toBe('not-configured');
    expect(result.networkAccessAllowed).toBe(false);
  });

  it('marks configuration invalid when an enabled WalletConnect profile has issues', () => {
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = '';

    const result = validateRuntimeConfig(documents);

    expect(result.walletConnect.usable).toBe(false);
    expect(result.state).toBe('invalid');
    expect(result.walletConnect.issues.map((issue) => issue.code)).toContain('missing-walletconnect-project-id');
  });

  it('accepts an enabled WalletConnect profile with the supported metadata', () => {
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = 'real-project-id';
    const metadata = walletConnect.metadata as { icons: string[] };
    metadata.icons = ['http://127.0.0.1:4173/walletconnect-icon.svg'];

    const result = validateRuntimeConfig(documents);

    expect(result.walletConnect.usable).toBe(true);
    expect(result.walletConnect.metadata).toEqual(
      expect.objectContaining({
        url: 'http://127.0.0.1:4173',
        icons: ['http://127.0.0.1:4173/walletconnect-icon.svg'],
      }),
    );
  });

  it('rejects an enabled WalletConnect profile with a relative icon URL', () => {
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = 'real-project-id';
    const metadata = walletConnect.metadata as { icons: string[] };
    metadata.icons = ['walletconnect-icon.svg'];

    const result = validateRuntimeConfig(documents);

    expect(result.walletConnect.usable).toBe(false);
    expect(result.walletConnect.issues.map((issue) => issue.code)).toContain('invalid-walletconnect-icon');
  });

  it('rejects enabled WalletConnect metadata with an invalid project ID or origin', () => {
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = '  ';
    walletConnect.metadata = {
      name: 'Intex Auction',
      description: 'Local bidder application',
      url: 'http://localhost:4173',
      icons: [],
    };

    const result = validateRuntimeConfig(documents);
    const codes = result.walletConnect.issues.map((issue) => issue.code);

    expect(result.walletConnect.usable).toBe(false);
    expect(codes).toContain('missing-walletconnect-project-id');
    expect(codes).toContain('incomplete-walletconnect-metadata');
  });

  it('rejects enabled WalletConnect icons that are not absolute same-origin URLs', () => {
    const documents = disabledDocuments();
    const walletConnect = documents.walletConnect as Record<string, unknown>;
    walletConnect.enabled = true;
    walletConnect.projectId = 'real-project-id';
    walletConnect.metadata = {
      name: 'Intex Auction',
      description: 'Local bidder application',
      url: 'http://127.0.0.1:4173',
      icons: ['https://cdn.example/icon.svg'],
    };

    const result = validateRuntimeConfig(documents);

    expect(result.walletConnect.usable).toBe(false);
    expect(result.walletConnect.issues.map((issue) => issue.code)).toContain('invalid-walletconnect-icon');
  });

  it.each([
    ['missing', () => new Response('Not found', { status: 404 })],
    [
      'unreadable',
      () => {
        throw new Error('network unavailable');
      },
    ],
    ['non-OK', () => new Response('Unavailable', { status: 503 })],
    ['malformed', () => new Response('{', { status: 200 })],
  ])(
    'isolates a %s WalletConnect document failure from valid runtime and ABI loading',
    async (_label, walletConnectResponse) => {
      const values = disabledDocuments();
      enableOrigin(values);
      enableVenue(values);
      const bodies: Record<string, unknown> = {
        '/config/chains.json': values.chains,
        '/config/deployments.json': values.deployments,
        '/config/timing.json': values.timing,
      };
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/config/walletconnect.json') return walletConnectResponse();
        if (url.startsWith('/config/abi/')) {
          return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(bodies[url]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const result = await loadRuntimeConfigData(fetcher);

      expect(result.evaluation.networkAccessAllowed).toBe(true);
      expect(result.evaluation.originProfile?.readCapable).toBe(true);
      expect(result.evaluation.venueProfiles[0]?.readCapable).toBe(true);
      expect(result.evaluation.walletConnect.usable).toBe(false);
      expect(result.abiDocuments.size).toBeGreaterThan(0);
    },
  );

  it('isolates a malformed timing document without blocking valid runtime loading', async () => {
    const values = disabledDocuments();
    enableOrigin(values);
    enableVenue(values);
    const bodies: Record<string, unknown> = {
      '/config/chains.json': values.chains,
      '/config/deployments.json': values.deployments,
      '/config/walletconnect.json': values.walletConnect,
      '/config/timing.json': { schemaVersion: 1, bidsFanInTimeoutSeconds: 'twelve-hours' },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/config/abi/')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(bodies[url]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await loadRuntimeConfigData(fetcher);

    expect(result.evaluation.networkAccessAllowed).toBe(true);
    expect(result.evaluation.originProfile?.readCapable).toBe(true);
    expect(result.evaluation.venueProfiles[0]?.readCapable).toBe(true);
    expect(result.evaluation.timing.bidsFanInTimeoutSeconds).toBeNull();
    expect(result.evaluation.timing.issues.map((issue) => issue.code)).toContain('invalid-bids-fan-in-timeout');
  });

  it('accepts a valid timing document and exposes the fan-in timeout', () => {
    const documents = disabledDocuments();

    const result = validateRuntimeConfig(documents);

    expect(result.timing.bidsFanInTimeoutSeconds).toBe(43200);
    expect(result.timing.issues).toEqual([]);
  });

  it('rejects a missing timing document with a non-blocking issue', () => {
    const documents = disabledDocuments();
    (documents as { timing: unknown }).timing = null;

    const result = validateRuntimeConfig(documents);

    expect(result.timing.bidsFanInTimeoutSeconds).toBeNull();
    expect(result.timing.issues.map((issue) => issue.code)).toContain('invalid-timing-document');
    expect(result.state).toBe('not-configured');
  });
});
