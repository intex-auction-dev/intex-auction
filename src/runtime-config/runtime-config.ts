import { getAddress, type Abi, type Address } from 'viem';
export type ProfileRole = 'origin' | 'venue';
export type VenueAdapterProfile = 'multi-issuance-usd-reference';

export interface ConfigIssue {
  code: string;
  message: string;
  profileId?: string;
}

export interface RuntimeProfileEvaluation {
  id: string;
  name: string;
  roles: ProfileRole[];
  enabled: boolean;
  chainId: number | null;
  nativeCurrency: { name: string; symbol: string; decimals: number } | null;
  walletConnectRpcUrl: string | null;
  deploymentId: string | null;
  deploymentBlock: number | null;
  rpcUrls: string[];
  explorerUrl: string | null;
  developmentChain: boolean;
  confirmationDepth: number | null;
  logBatchSize: number | null;
  requestTimeoutMs: number | null;
  readRetryCount: number | null;
  addresses: Readonly<Record<string, Address>>;
  abiFiles: Readonly<Record<string, string>>;
  oraclePair: { base: Address; quote: Address } | null;
  adapterProfile: VenueAdapterProfile | null;
  readCapable: boolean;
  writeCapable: boolean;
  issues: ConfigIssue[];
}

export interface RuntimeTiming {
  bidsFanInTimeoutSeconds: number;
}

export interface TimingEvaluation {
  bidsFanInTimeoutSeconds: number | null;
  issues: ConfigIssue[];
}

export interface WalletConnectMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WalletConnectEvaluation {
  enabled: boolean;
  usable: boolean;
  projectId: string | null;
  metadata: WalletConnectMetadata | null;
  issues: ConfigIssue[];
}

export interface RuntimeConfigEvaluation {
  state: 'ready' | 'not-configured' | 'invalid';
  originProfile: RuntimeProfileEvaluation | null;
  venueProfiles: RuntimeProfileEvaluation[];
  walletConnect: WalletConnectEvaluation;
  timing: TimingEvaluation;
  networkAccessAllowed: boolean;
  defaultDisconnectedVenueChainId: number | null;
  issues: ConfigIssue[];
}

export interface RuntimeConfigDocuments {
  chains: unknown;
  deployments: unknown;
  walletConnect: unknown;
  timing: unknown;
}

export type RuntimeConfigFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

interface ChainCandidate {
  id: string;
  name: string;
  roles: ProfileRole[];
  enabled: boolean;
  chainId: number | null;
  nativeCurrency: NativeCurrency | null;
  rpcUrls: string[];
  walletConnectRpcUrl: string | null;
  explorerUrl: string | null;
  developmentChain: boolean;
  confirmationDepth: number | null;
  logBatchSize: number | null;
  requestTimeoutMs: number | null;
  readRetryCount: number | null;
  structurallyValid: boolean;
  enabledRequirementsValid: boolean;
  issues: ConfigIssue[];
}

interface DeploymentCandidate {
  id: string;
  roles: ProfileRole[];
  enabled: boolean;
  chainProfileId: string;
  chainId: number | null;
  deploymentBlock: number | null;
  reviewedSourceCommit: string | null;
  addresses: Record<string, string | null>;
  abiFiles: Record<string, string>;
  oraclePair: { base: Address | null; quote: Address | null } | null;
  adapterProfile: VenueAdapterProfile | null;
  structurallyValid: boolean;
  enabledRequirementsValid: boolean;
  issues: ConfigIssue[];
}

interface ParsedChains {
  originChainProfileId: string | null;
  defaultDisconnectedVenueChainId: number | null;
  chains: ChainCandidate[];
  issues: ConfigIssue[];
  globalBlocking: boolean;
}

interface ParsedDeployments {
  deployments: DeploymentCandidate[];
  issues: ConfigIssue[];
  globalBlocking: boolean;
}

const ORIGIN_ADDRESS_KEYS = ['metadosis', 'desis', 'originRouter', 'oracle', 'intex'] as const;
const ORIGIN_ABI_KEYS = [...ORIGIN_ADDRESS_KEYS] as const;
const VENUE_ADDRESS_KEYS = [
  'intexAuction',
  'escrowAdapter',
  'targetRouter',
  'theCompact',
  'paymentToken',
  'intexNFT1155',
] as const;
const VENUE_ABI_KEYS = [...VENUE_ADDRESS_KEYS] as const;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ABI_FILE_PATTERN = /^\.\/abi\/[A-Za-z0-9_.-]+\.json$/;
export const DEFAULT_APPLICATION_ORIGIN = 'http://127.0.0.1:4173';
const REVIEWED_SOURCE_COMMIT = 'outbe/outbe-chain@f5477b56c9a4192755354a3f2577603dffe5b3a6';
const REVIEWED_ORIGIN_ABIS: Readonly<Record<string, string>> = {
  metadosis: './abi/IMetadosis.json',
  desis: './abi/IDesis.json',
  originRouter: './abi/OriginRouter.json',
  oracle: './abi/IOracle.json',
  intex: './abi/IIntex.json',
};
const REVIEWED_VENUE_ABIS: Readonly<Record<string, string>> = {
  intexAuction: './abi/IntexAuction.json',
  escrowAdapter: './abi/EscrowAdapter.json',
  targetRouter: './abi/TargetRouter.json',
  theCompact: './abi/TheCompact.json',
  paymentToken: './abi/ERC20.json',
  intexNFT1155: './abi/IntexNFT1155.json',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

const isPositiveInteger = (value: unknown): value is number => isInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number => isInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const hasRole = (roles: ProfileRole[], role: ProfileRole): boolean => roles.includes(role);

const addIssue = (target: ConfigIssue[], code: string, message: string, profileId?: string): ConfigIssue => {
  const issue: ConfigIssue = profileId ? { code, message, profileId } : { code, message };
  target.push(issue);
  return issue;
};

const readRoles = (value: unknown, issues: ConfigIssue[], profileId: string): ProfileRole[] => {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, 'invalid-roles', `Profile ${profileId} must declare at least one role.`, profileId);
    return [];
  }

  const roles: ProfileRole[] = [];
  for (const role of value) {
    if (role !== 'origin' && role !== 'venue') {
      addIssue(issues, 'invalid-role', `Profile ${profileId} contains an unsupported role.`, profileId);
      continue;
    }
    if (!roles.includes(role)) {
      roles.push(role);
    }
  }
  return roles;
};

const parseHttpUrl = (value: unknown): URL | null => {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

const isPlaceholderUrl = (value: string): boolean => {
  const parsed = parseHttpUrl(value);
  return parsed?.hostname.endsWith('.invalid') ?? true;
};

const isLoopbackUrl = (value: string): boolean => {
  const hostname = parseHttpUrl(value)?.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
};

export const resolveApplicationOrigin = (value: unknown): string =>
  parseHttpUrl(value)?.origin ?? DEFAULT_APPLICATION_ORIGIN;

const isApplicationOriginUrl = (value: string, applicationOrigin: string): boolean =>
  parseHttpUrl(value)?.origin === applicationOrigin;

// External chains require reviewed provenance and explorer metadata; local profiles must be loopback or same-origin.
const isExternalChain = (chain: ChainCandidate, applicationOrigin: string): boolean =>
  chain.rpcUrls.some(
    (url) => !isLoopbackUrl(url) && !(chain.developmentChain && isApplicationOriginUrl(url, applicationOrigin)),
  );

const hasExactAbiMap = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean => {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => actual[key] === expected[key]);
};

const parseNativeCurrency = (value: unknown, issues: ConfigIssue[], profileId: string): NativeCurrency | null => {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    addIssue(
      issues,
      'invalid-native-currency',
      `Chain profile ${profileId} has malformed native-currency metadata.`,
      profileId,
    );
    return null;
  }

  const name = isNonEmptyString(value.name) ? value.name : null;
  const symbol = isNonEmptyString(value.symbol) ? value.symbol : null;
  const decimals = isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 255 ? value.decimals : null;

  if (!name || !symbol || decimals === null) {
    addIssue(
      issues,
      'invalid-native-currency',
      `Chain profile ${profileId} has incomplete native-currency metadata.`,
      profileId,
    );
    return null;
  }

  return { name, symbol, decimals };
};

const parseChainCandidate = (value: unknown, index: number): ChainCandidate => {
  const provisionalId = isRecord(value) && isNonEmptyString(value.id) ? value.id : `chain-${index + 1}`;
  const issues: ConfigIssue[] = [];

  if (!isRecord(value)) {
    addIssue(issues, 'invalid-chain-profile', `Chain profile ${provisionalId} must be an object.`, provisionalId);
    return {
      id: provisionalId,
      name: provisionalId,
      roles: [],
      enabled: false,
      chainId: null,
      nativeCurrency: null,
      walletConnectRpcUrl: null,
      rpcUrls: [],
      explorerUrl: null,
      developmentChain: false,
      confirmationDepth: null,
      logBatchSize: null,
      requestTimeoutMs: null,
      readRetryCount: null,
      structurallyValid: false,
      enabledRequirementsValid: false,
      issues,
    };
  }

  const id = isNonEmptyString(value.id) ? value.id : provisionalId;
  if (!isNonEmptyString(value.id)) {
    addIssue(issues, 'invalid-chain-id', `Chain profile ${id} is missing an id.`, id);
  }

  const name = isNonEmptyString(value.name) ? value.name : id;
  if (!isNonEmptyString(value.name)) {
    addIssue(issues, 'invalid-chain-name', `Chain profile ${id} is missing a name.`, id);
  }

  const roles = readRoles(value.roles, issues, id);
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : false;
  if (typeof value.enabled !== 'boolean') {
    addIssue(issues, 'invalid-enabled-flag', `Chain profile ${id} has no boolean enabled flag.`, id);
  }

  const chainId = value.chainId === null ? null : isPositiveInteger(value.chainId) ? value.chainId : null;
  if (value.chainId !== null && chainId === null) {
    addIssue(issues, 'invalid-chain-id-value', `Chain profile ${id} has an invalid chain ID.`, id);
  }

  const nativeCurrency = parseNativeCurrency(value.nativeCurrency, issues, id);

  const rpcUrls = Array.isArray(value.rpcUrls)
    ? value.rpcUrls.filter((url): url is string => typeof url === 'string')
    : [];
  if (!Array.isArray(value.rpcUrls) || rpcUrls.length !== value.rpcUrls.length || rpcUrls.length === 0) {
    addIssue(issues, 'invalid-rpc-list', `Chain profile ${id} must contain RPC URLs.`, id);
  }
  if (rpcUrls.some((url) => parseHttpUrl(url) === null)) {
    addIssue(issues, 'invalid-rpc-url', `Chain profile ${id} contains an invalid RPC URL.`, id);
  }

  const parsedExplorerUrl = value.explorerUrl === null ? null : parseHttpUrl(value.explorerUrl);
  if (value.explorerUrl !== null && parsedExplorerUrl === null) {
    addIssue(issues, 'invalid-explorer-url', `Chain profile ${id} has an invalid explorer URL.`, id);
  }
  const explorerUrl = parsedExplorerUrl?.toString() ?? null;

  const walletConnectRpcUrl =
    typeof value.walletConnectRpcUrl === 'string' && parseHttpUrl(value.walletConnectRpcUrl)
      ? value.walletConnectRpcUrl
      : null;

  const developmentChain = value.developmentChain === true;
  if (value.developmentChain !== undefined && typeof value.developmentChain !== 'boolean') {
    addIssue(
      issues,
      'invalid-development-chain-flag',
      `Chain profile ${id} has a non-boolean developmentChain flag.`,
      id,
    );
  }

  const confirmationDepth = isPositiveInteger(value.confirmationDepth) ? value.confirmationDepth : null;
  const logBatchSize = isPositiveInteger(value.logBatchSize) ? value.logBatchSize : null;
  const requestTimeoutMs = isPositiveInteger(value.requestTimeoutMs) ? value.requestTimeoutMs : null;
  const readRetryCount = isNonNegativeInteger(value.readRetryCount) ? value.readRetryCount : null;

  const numericRules: Array<[string, unknown, (candidate: unknown) => boolean]> = [
    ['confirmationDepth', value.confirmationDepth, isPositiveInteger],
    ['logBatchSize', value.logBatchSize, isPositiveInteger],
    ['requestTimeoutMs', value.requestTimeoutMs, isPositiveInteger],
    ['readRetryCount', value.readRetryCount, isNonNegativeInteger],
  ];
  for (const [field, fieldValue, validator] of numericRules) {
    if (!validator(fieldValue)) {
      addIssue(issues, 'invalid-chain-setting', `Chain profile ${id} has an invalid ${field} value.`, id);
    }
  }

  const structuralIssueCount = issues.length;
  let enabledRequirementsValid = true;
  if (enabled) {
    if (chainId === null) {
      addIssue(issues, 'missing-chain-id', `Enabled chain profile ${id} requires a chain ID.`, id);
      enabledRequirementsValid = false;
    }
    if (!nativeCurrency) {
      addIssue(issues, 'missing-native-currency', `Enabled chain profile ${id} requires native-currency metadata.`, id);
      enabledRequirementsValid = false;
    }
    if (rpcUrls.length === 0 || rpcUrls.some(isPlaceholderUrl)) {
      addIssue(issues, 'placeholder-rpc', `Enabled chain profile ${id} requires non-placeholder RPC URLs.`, id);
      enabledRequirementsValid = false;
    }
  }

  return {
    id,
    name,
    roles,
    enabled,
    chainId,
    nativeCurrency,
    rpcUrls,
    walletConnectRpcUrl,
    explorerUrl,
    developmentChain,
    confirmationDepth,
    logBatchSize,
    requestTimeoutMs,
    readRetryCount,
    structurallyValid: structuralIssueCount === 0,
    enabledRequirementsValid: structuralIssueCount === 0 && enabledRequirementsValid,
    issues,
  };
};

const parseChains = (value: unknown): ParsedChains => {
  const issues: ConfigIssue[] = [];
  let globalBlocking = false;

  if (!isRecord(value)) {
    addIssue(issues, 'invalid-chains-document', 'config/chains.json must contain an object.');
    return {
      originChainProfileId: null,
      defaultDisconnectedVenueChainId: null,
      chains: [],
      issues,
      globalBlocking: true,
    };
  }

  if (value.schemaVersion !== 1) {
    addIssue(issues, 'unsupported-chains-schema', 'config/chains.json must use schemaVersion 1.');
    globalBlocking = true;
  }

  const originChainProfileId = isNonEmptyString(value.originChainProfileId) ? value.originChainProfileId : null;
  if (!originChainProfileId) {
    addIssue(issues, 'missing-origin-profile-id', 'config/chains.json must designate one Outbe origin profile.');
    globalBlocking = true;
  }

  const defaultDisconnectedVenueChainId = isPositiveInteger(value.defaultDisconnectedVenueChainId)
    ? value.defaultDisconnectedVenueChainId
    : null;
  if (defaultDisconnectedVenueChainId === null) {
    addIssue(
      issues,
      'invalid-default-venue-chain',
      'config/chains.json must declare a valid defaultDisconnectedVenueChainId.',
    );
    globalBlocking = true;
  }

  const rawChains = Array.isArray(value.chains) ? value.chains : [];
  if (!Array.isArray(value.chains)) {
    addIssue(issues, 'invalid-chain-list', 'config/chains.json must contain a chains array.');
    globalBlocking = true;
  }

  const chains = rawChains.map(parseChainCandidate);
  for (const chain of chains) {
    issues.push(...chain.issues);
  }

  const byId = new Map<string, ChainCandidate[]>();
  for (const chain of chains) {
    const matches = byId.get(chain.id) ?? [];
    matches.push(chain);
    byId.set(chain.id, matches);
  }
  for (const [id, matches] of byId) {
    if (matches.length > 1) {
      addIssue(issues, 'duplicate-chain-profile', `Chain profile id ${id} is duplicated.`, id);
      for (const match of matches) {
        match.structurallyValid = false;
      }
      globalBlocking = true;
    }
  }

  const originProfiles = chains.filter((chain) => hasRole(chain.roles, 'origin'));
  if (originProfiles.length !== 1) {
    addIssue(issues, 'origin-profile-count', 'Exactly one chain profile must declare the origin role.');
    globalBlocking = true;
  }

  const designatedOrigin = originChainProfileId ? byId.get(originChainProfileId)?.[0] : undefined;
  if (!designatedOrigin) {
    addIssue(
      issues,
      'missing-designated-origin',
      'The designated Outbe origin profile does not exist.',
      originChainProfileId ?? undefined,
    );
    globalBlocking = true;
  } else if (!hasRole(designatedOrigin.roles, 'origin')) {
    addIssue(
      issues,
      'designated-profile-not-origin',
      `Designated profile ${designatedOrigin.id} does not declare the origin role.`,
      designatedOrigin.id,
    );
    designatedOrigin.structurallyValid = false;
    globalBlocking = true;
  }

  if (defaultDisconnectedVenueChainId !== null) {
    const defaultVenue = chains.find(
      (chain) => chain.chainId === defaultDisconnectedVenueChainId && hasRole(chain.roles, 'venue'),
    );
    if (!defaultVenue) {
      addIssue(issues, 'missing-default-venue-profile', 'No venue profile matches defaultDisconnectedVenueChainId.');
      globalBlocking = true;
    }
  }

  return {
    originChainProfileId,
    defaultDisconnectedVenueChainId,
    chains,
    issues,
    globalBlocking,
  };
};

const readNullableAddressMap = (
  value: unknown,
  issues: ConfigIssue[],
  profileId: string,
): Record<string, string | null> => {
  if (!isRecord(value)) {
    addIssue(
      issues,
      'invalid-address-map',
      `Deployment profile ${profileId} must contain an addresses object.`,
      profileId,
    );
    return {};
  }

  const result: Record<string, string | null> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === null || typeof candidate === 'string') {
      result[key] = candidate;
    } else {
      addIssue(
        issues,
        'invalid-address-value',
        `Deployment profile ${profileId} has an invalid address value for ${key}.`,
        profileId,
      );
    }
  }
  return result;
};

const readAbiMap = (value: unknown, issues: ConfigIssue[], profileId: string): Record<string, string> => {
  if (!isRecord(value)) {
    addIssue(issues, 'invalid-abi-map', `Deployment profile ${profileId} must contain an abiFiles object.`, profileId);
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === 'string' && ABI_FILE_PATTERN.test(candidate) && !candidate.includes('..')) {
      result[key] = candidate;
    } else {
      addIssue(
        issues,
        'invalid-abi-reference',
        `Deployment profile ${profileId} has an invalid ABI reference for ${key}.`,
        profileId,
      );
    }
  }
  return result;
};

const parseOraclePair = (
  value: unknown,
  issues: ConfigIssue[],
  profileId: string,
): { base: Address | null; quote: Address | null } | null => {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    addIssue(issues, 'invalid-oracle-pair', `Deployment profile ${profileId} has a malformed oraclePair.`, profileId);
    return null;
  }

  const parseAddress = (field: unknown): Address | null => {
    if (field === null) return null;
    if (typeof field !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(field)) return null;
    return getAddress(field);
  };
  const base = parseAddress(value.base);
  const quote = parseAddress(value.quote);
  if (value.base !== null && base === null) {
    addIssue(issues, 'invalid-oracle-base', `Deployment profile ${profileId} has an invalid Oracle base.`, profileId);
  }
  if (value.quote !== null && quote === null) {
    addIssue(issues, 'invalid-oracle-quote', `Deployment profile ${profileId} has an invalid Oracle quote.`, profileId);
  }
  return { base, quote };
};

const parseDeploymentCandidate = (value: unknown, index: number): DeploymentCandidate => {
  const provisionalId = isRecord(value) && isNonEmptyString(value.id) ? value.id : `deployment-${index + 1}`;
  const issues: ConfigIssue[] = [];

  if (!isRecord(value)) {
    addIssue(
      issues,
      'invalid-deployment-profile',
      `Deployment profile ${provisionalId} must be an object.`,
      provisionalId,
    );
    return {
      id: provisionalId,
      roles: [],
      enabled: false,
      chainProfileId: '',
      chainId: null,
      deploymentBlock: null,
      reviewedSourceCommit: null,
      addresses: {},
      abiFiles: {},
      oraclePair: null,
      adapterProfile: null,
      structurallyValid: false,
      enabledRequirementsValid: false,
      issues,
    };
  }

  const id = isNonEmptyString(value.id) ? value.id : provisionalId;
  if (!isNonEmptyString(value.id)) {
    addIssue(issues, 'invalid-deployment-id', `Deployment profile ${id} is missing an id.`, id);
  }

  const roles = readRoles(value.roles, issues, id);
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : false;
  if (typeof value.enabled !== 'boolean') {
    addIssue(issues, 'invalid-enabled-flag', `Deployment profile ${id} has no boolean enabled flag.`, id);
  }

  const chainProfileId = isNonEmptyString(value.chainProfileId) ? value.chainProfileId : '';
  if (!chainProfileId) {
    addIssue(issues, 'missing-chain-profile-reference', `Deployment profile ${id} is missing chainProfileId.`, id);
  }

  const chainId = value.chainId === null ? null : isPositiveInteger(value.chainId) ? value.chainId : null;
  if (value.chainId !== null && chainId === null) {
    addIssue(issues, 'invalid-deployment-chain-id', `Deployment profile ${id} has an invalid chain ID.`, id);
  }

  const deploymentBlock =
    value.deploymentBlock === null ? null : isNonNegativeInteger(value.deploymentBlock) ? value.deploymentBlock : null;
  if (value.deploymentBlock !== null && deploymentBlock === null) {
    addIssue(issues, 'invalid-deployment-block', `Deployment profile ${id} has an invalid deployment block.`, id);
  }

  const reviewedSourceCommit = isNonEmptyString(value.reviewedSourceCommit) ? value.reviewedSourceCommit.trim() : null;
  const addresses = readNullableAddressMap(value.addresses, issues, id);
  const abiFiles = readAbiMap(value.abiFiles, issues, id);
  const oraclePair = parseOraclePair(value.oraclePair, issues, id);
  const adapterProfile = hasRole(roles, 'venue')
    ? value.adapterProfile === 'multi-issuance-usd-reference'
      ? value.adapterProfile
      : null
    : null;
  if (hasRole(roles, 'venue') && adapterProfile === null) {
    addIssue(
      issues,
      'invalid-adapter-profile',
      `Deployment profile ${id} must name a reviewed venue adapter profile.`,
      id,
    );
  }
  const structuralIssueCount = issues.length;

  let enabledRequirementsValid = true;
  if (enabled) {
    if (chainId === null) {
      addIssue(issues, 'missing-deployment-chain-id', `Enabled deployment ${id} requires a chain ID.`, id);
      enabledRequirementsValid = false;
    }
    if (deploymentBlock === null) {
      addIssue(issues, 'missing-deployment-block', `Enabled deployment ${id} requires a deployment block.`, id);
      enabledRequirementsValid = false;
    }

    const addressKeys = hasRole(roles, 'origin') ? ORIGIN_ADDRESS_KEYS : VENUE_ADDRESS_KEYS;
    const abiKeys = hasRole(roles, 'origin') ? ORIGIN_ABI_KEYS : VENUE_ABI_KEYS;

    for (const key of addressKeys) {
      const address = addresses[key];
      if (!address || !ADDRESS_PATTERN.test(address)) {
        addIssue(issues, 'missing-required-address', `Enabled deployment ${id} requires a valid ${key} address.`, id);
        enabledRequirementsValid = false;
      }
    }

    for (const key of abiKeys) {
      if (!abiFiles[key]) {
        addIssue(
          issues,
          'missing-required-abi-reference',
          `Enabled deployment ${id} requires an ABI file for ${key}.`,
          id,
        );
        enabledRequirementsValid = false;
      }
    }

    if (hasRole(roles, 'origin')) {
      if (!oraclePair?.base || !oraclePair.quote) {
        addIssue(
          issues,
          'missing-oracle-pair',
          `Enabled origin deployment ${id} requires the configured COEN Oracle pair.`,
          id,
        );
        enabledRequirementsValid = false;
      }
    }
  }

  return {
    id,
    roles,
    enabled,
    chainProfileId,
    chainId,
    deploymentBlock,
    reviewedSourceCommit,
    addresses,
    abiFiles,
    oraclePair,
    adapterProfile,
    structurallyValid: structuralIssueCount === 0,
    enabledRequirementsValid: structuralIssueCount === 0 && enabledRequirementsValid,
    issues,
  };
};

const parseDeployments = (value: unknown): ParsedDeployments => {
  const issues: ConfigIssue[] = [];
  let globalBlocking = false;

  if (!isRecord(value)) {
    addIssue(issues, 'invalid-deployments-document', 'config/deployments.json must contain an object.');
    return { deployments: [], issues, globalBlocking: true };
  }

  if (value.schemaVersion !== 1) {
    addIssue(issues, 'unsupported-deployments-schema', 'config/deployments.json must use schemaVersion 1.');
    globalBlocking = true;
  }

  const rawDeployments = Array.isArray(value.deployments) ? value.deployments : [];
  if (!Array.isArray(value.deployments)) {
    addIssue(issues, 'invalid-deployment-list', 'config/deployments.json must contain a deployments array.');
    globalBlocking = true;
  }

  const deployments = rawDeployments.map(parseDeploymentCandidate);
  for (const deployment of deployments) {
    issues.push(...deployment.issues);
  }

  const byId = new Map<string, DeploymentCandidate[]>();
  for (const deployment of deployments) {
    const matches = byId.get(deployment.id) ?? [];
    matches.push(deployment);
    byId.set(deployment.id, matches);
  }
  for (const [id, matches] of byId) {
    if (matches.length > 1) {
      addIssue(issues, 'duplicate-deployment-profile', `Deployment profile id ${id} is duplicated.`, id);
      for (const match of matches) {
        match.structurallyValid = false;
      }
      globalBlocking = true;
    }
  }

  return { deployments, issues, globalBlocking };
};

const parseTiming = (value: unknown): TimingEvaluation => {
  const issues: ConfigIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, 'invalid-timing-document', 'config/timing.json must contain an object.');
    return { bidsFanInTimeoutSeconds: null, issues };
  }
  if (value.schemaVersion !== 1) {
    addIssue(issues, 'unsupported-timing-schema', 'config/timing.json must use schemaVersion 1.');
  }
  const bidsFanInTimeoutSeconds = isPositiveInteger(value.bidsFanInTimeoutSeconds)
    ? value.bidsFanInTimeoutSeconds
    : null;
  if (bidsFanInTimeoutSeconds === null) {
    addIssue(
      issues,
      'invalid-bids-fan-in-timeout',
      'config/timing.json bidsFanInTimeoutSeconds must be a positive integer number of seconds.',
    );
  }
  return { bidsFanInTimeoutSeconds, issues };
};

const parseWalletConnect = (value: unknown, applicationOrigin: string): WalletConnectEvaluation => {
  const issues: ConfigIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, 'invalid-walletconnect-document', 'config/walletconnect.json must contain an object.');
    return { enabled: false, usable: false, projectId: null, metadata: null, issues };
  }

  if (value.schemaVersion !== 1) {
    addIssue(issues, 'unsupported-walletconnect-schema', 'config/walletconnect.json must use schemaVersion 1.');
  }

  const enabled = typeof value.enabled === 'boolean' ? value.enabled : false;
  if (typeof value.enabled !== 'boolean') {
    addIssue(issues, 'invalid-walletconnect-enabled', 'WalletConnect enabled must be a boolean.');
  }

  const projectId = typeof value.projectId === 'string' ? value.projectId.trim() : '';
  const metadataRecord = isRecord(value.metadata) ? value.metadata : null;
  const metadata =
    metadataRecord &&
    isNonEmptyString(metadataRecord.name) &&
    isNonEmptyString(metadataRecord.description) &&
    isNonEmptyString(metadataRecord.url) &&
    Array.isArray(metadataRecord.icons) &&
    metadataRecord.icons.every((icon) => typeof icon === 'string')
      ? {
          name: metadataRecord.name,
          description: metadataRecord.description,
          url: metadataRecord.url,
          icons: [...metadataRecord.icons],
        }
      : null;
  if (!metadataRecord) {
    addIssue(issues, 'invalid-walletconnect-metadata', 'WalletConnect metadata must be an object.');
  }

  if (enabled) {
    if (!projectId) {
      addIssue(issues, 'missing-walletconnect-project-id', 'Enabled WalletConnect requires a project ID.');
    }
    if (!metadata || metadata.url !== applicationOrigin) {
      addIssue(
        issues,
        'incomplete-walletconnect-metadata',
        `Enabled WalletConnect requires complete metadata for ${applicationOrigin}.`,
      );
    }
    if (metadata) {
      for (const icon of metadata.icons) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(icon).origin === applicationOrigin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          addIssue(
            issues,
            'invalid-walletconnect-icon',
            `Enabled WalletConnect icons must be absolute URLs on ${applicationOrigin}.`,
          );
          break;
        }
      }
    }
  }

  return {
    enabled,
    usable: enabled && issues.length === 0,
    projectId: projectId || null,
    metadata,
    issues,
  };
};

const addProfileIssue = (
  profile: { issues: ConfigIssue[]; structurallyValid: boolean; enabledRequirementsValid: boolean },
  globalIssues: ConfigIssue[],
  code: string,
  message: string,
  profileId: string,
): void => {
  const issue = addIssue(profile.issues, code, message, profileId);
  globalIssues.push(issue);
  profile.enabledRequirementsValid = false;
};

const deploymentFor = (
  deployments: DeploymentCandidate[],
  chainProfileId: string,
  role: ProfileRole,
): DeploymentCandidate[] =>
  deployments.filter((deployment) => deployment.chainProfileId === chainProfileId && hasRole(deployment.roles, role));

const profileEvaluation = (
  chain: ChainCandidate,
  deployment: DeploymentCandidate | null,
  originReady: boolean,
): RuntimeProfileEvaluation => {
  const issues = [...chain.issues, ...(deployment?.issues ?? [])];
  const baseReady =
    chain.enabled &&
    chain.structurallyValid &&
    chain.enabledRequirementsValid &&
    deployment?.enabled === true &&
    deployment.structurallyValid &&
    deployment.enabledRequirementsValid;
  const venueRequiresOrigin = hasRole(chain.roles, 'venue');
  const readCapable = baseReady && (!venueRequiresOrigin || originReady);

  const addresses: Record<string, Address> = {};
  if (baseReady && deployment) {
    for (const [key, value] of Object.entries(deployment.addresses)) {
      if (value && ADDRESS_PATTERN.test(value)) addresses[key] = getAddress(value);
    }
  }

  return {
    id: chain.id,
    name: chain.name,
    roles: chain.roles,
    enabled: chain.enabled,
    chainId: chain.chainId,
    nativeCurrency: chain.nativeCurrency,
    walletConnectRpcUrl: chain.walletConnectRpcUrl,
    deploymentId: baseReady ? (deployment?.id ?? null) : null,
    deploymentBlock: baseReady ? (deployment?.deploymentBlock ?? null) : null,
    rpcUrls: baseReady ? [...chain.rpcUrls] : [],
    explorerUrl: baseReady ? chain.explorerUrl : null,
    developmentChain: chain.developmentChain,
    confirmationDepth: baseReady ? chain.confirmationDepth : null,
    logBatchSize: baseReady ? chain.logBatchSize : null,
    requestTimeoutMs: baseReady ? chain.requestTimeoutMs : null,
    readRetryCount: baseReady ? chain.readRetryCount : null,
    addresses,
    abiFiles: baseReady && deployment ? { ...deployment.abiFiles } : {},
    adapterProfile: baseReady && deployment ? deployment.adapterProfile : null,
    oraclePair:
      baseReady && deployment?.oraclePair?.base && deployment.oraclePair.quote
        ? { base: deployment.oraclePair.base, quote: deployment.oraclePair.quote }
        : null,
    readCapable,
    writeCapable: readCapable && venueRequiresOrigin,
    issues,
  };
};

export const collectEnabledAbiFiles = (deploymentsDocument: unknown): string[] => {
  if (!isRecord(deploymentsDocument) || !Array.isArray(deploymentsDocument.deployments)) {
    return [];
  }

  const files = new Set<string>();
  for (const deployment of deploymentsDocument.deployments) {
    if (!isRecord(deployment) || deployment.enabled !== true || !isRecord(deployment.abiFiles)) {
      continue;
    }
    for (const candidate of Object.values(deployment.abiFiles)) {
      if (typeof candidate === 'string' && ABI_FILE_PATTERN.test(candidate) && !candidate.includes('..')) {
        files.add(candidate);
      }
    }
  }
  return [...files];
};

export const configUrlForAbi = (abiFile: string): string => {
  if (!ABI_FILE_PATTERN.test(abiFile) || abiFile.includes('..')) {
    throw new Error(`Invalid ABI file reference: ${abiFile}`);
  }
  return `/config/${abiFile.slice(2)}`;
};

export const validateRuntimeConfig = (
  documents: RuntimeConfigDocuments,
  abiAvailability: ReadonlyMap<string, boolean> = new Map(),
  applicationOrigin: string = DEFAULT_APPLICATION_ORIGIN,
): RuntimeConfigEvaluation => {
  const parsedChains = parseChains(documents.chains);
  const parsedDeployments = parseDeployments(documents.deployments);
  const walletConnect = parseWalletConnect(documents.walletConnect, applicationOrigin);
  const timing = parseTiming(documents.timing);
  const issues = [...parsedChains.issues, ...parsedDeployments.issues, ...walletConnect.issues, ...timing.issues];

  const chainById = new Map(parsedChains.chains.map((chain) => [chain.id, chain]));

  for (const deployment of parsedDeployments.deployments) {
    const chain = chainById.get(deployment.chainProfileId);
    if (!chain) {
      addProfileIssue(
        deployment,
        issues,
        'unknown-chain-profile',
        `Deployment ${deployment.id} references unknown chain profile ${deployment.chainProfileId}.`,
        deployment.id,
      );
      continue;
    }

    for (const role of deployment.roles) {
      if (!hasRole(chain.roles, role)) {
        addProfileIssue(
          deployment,
          issues,
          'deployment-role-mismatch',
          `Deployment ${deployment.id} declares role ${role} that chain profile ${chain.id} does not support.`,
          deployment.id,
        );
      }
    }

    if (deployment.enabled && !chain.enabled) {
      addProfileIssue(
        deployment,
        issues,
        'deployment-on-disabled-chain',
        `Enabled deployment ${deployment.id} references disabled chain profile ${chain.id}.`,
        deployment.id,
      );
    }

    if (
      deployment.enabled &&
      deployment.chainId !== null &&
      chain.chainId !== null &&
      deployment.chainId !== chain.chainId
    ) {
      addProfileIssue(
        deployment,
        issues,
        'deployment-chain-mismatch',
        `Deployment ${deployment.id} chain ID does not match chain profile ${chain.id}.`,
        deployment.id,
      );
    }

    if (deployment.enabled) {
      const expectedAbis = hasRole(deployment.roles, 'origin') ? REVIEWED_ORIGIN_ABIS : REVIEWED_VENUE_ABIS;
      if (!hasExactAbiMap(deployment.abiFiles, expectedAbis)) {
        addProfileIssue(
          deployment,
          issues,
          'reviewed-abi-mismatch',
          `Enabled deployment ${deployment.id} must use the exact reviewed ABI mapping.`,
          deployment.id,
        );
      }

      const externalChain = isExternalChain(chain, applicationOrigin);
      if (externalChain && deployment.reviewedSourceCommit !== REVIEWED_SOURCE_COMMIT) {
        addProfileIssue(
          deployment,
          issues,
          'reviewed-source-mismatch',
          `Enabled external deployment ${deployment.id} must identify reviewed source ${REVIEWED_SOURCE_COMMIT}.`,
          deployment.id,
        );
      }
      if (externalChain && hasRole(deployment.roles, 'venue')) {
        const implementation = deployment.addresses.intexAuctionImplementation;
        if (!implementation || !ADDRESS_PATTERN.test(implementation)) {
          addProfileIssue(
            deployment,
            issues,
            'missing-reviewed-implementation',
            `Enabled external venue ${deployment.id} requires the reviewed live IntexAuction implementation address.`,
            deployment.id,
          );
        }
      }

      for (const abiFile of Object.values(deployment.abiFiles)) {
        if (abiAvailability.get(abiFile) !== true) {
          addProfileIssue(
            deployment,
            issues,
            'missing-abi-file',
            `Enabled deployment ${deployment.id} cannot load ABI file ${abiFile}.`,
            deployment.id,
          );
        }
      }
    }
  }

  for (const chain of parsedChains.chains) {
    if (chain.enabled && isExternalChain(chain, applicationOrigin) && !chain.explorerUrl) {
      addProfileIssue(
        chain,
        issues,
        'missing-explorer-url',
        `Enabled external chain profile ${chain.id} requires explorer metadata.`,
        chain.id,
      );
    }
    for (const role of chain.roles) {
      const matches = deploymentFor(parsedDeployments.deployments, chain.id, role);
      if (matches.length > 1) {
        addProfileIssue(
          chain,
          issues,
          'duplicate-role-deployment',
          `Chain profile ${chain.id} has multiple ${role} deployments.`,
          chain.id,
        );
      }
      if (chain.enabled && matches.length !== 1) {
        addProfileIssue(
          chain,
          issues,
          'missing-role-deployment',
          `Enabled chain profile ${chain.id} requires exactly one ${role} deployment.`,
          chain.id,
        );
      }
      if (chain.enabled && matches.length === 1 && matches[0]?.enabled !== true) {
        addProfileIssue(
          chain,
          issues,
          'disabled-role-deployment',
          `Enabled chain profile ${chain.id} references a disabled ${role} deployment.`,
          chain.id,
        );
      }
    }
  }

  const designatedOrigin = parsedChains.originChainProfileId
    ? (chainById.get(parsedChains.originChainProfileId) ?? null)
    : null;
  const originDeploymentMatches = designatedOrigin
    ? deploymentFor(parsedDeployments.deployments, designatedOrigin.id, 'origin')
    : [];
  const originDeployment = originDeploymentMatches.length === 1 ? (originDeploymentMatches[0] ?? null) : null;

  const provisionalOriginReady = Boolean(
    designatedOrigin?.enabled &&
      designatedOrigin.structurallyValid &&
      designatedOrigin.enabledRequirementsValid &&
      originDeployment?.enabled &&
      originDeployment.structurallyValid &&
      originDeployment.enabledRequirementsValid,
  );

  for (const chain of parsedChains.chains.filter((candidate) => hasRole(candidate.roles, 'venue'))) {
    if (chain.enabled && !provisionalOriginReady) {
      addProfileIssue(
        chain,
        issues,
        'origin-unavailable',
        `Enabled venue profile ${chain.id} is blocked until the designated Outbe origin is complete and enabled.`,
        chain.id,
      );
    }
  }

  const originProfile = designatedOrigin ? profileEvaluation(designatedOrigin, originDeployment, true) : null;
  const originReady = originProfile?.readCapable === true;

  const venueProfiles = parsedChains.chains.flatMap((chain) => {
    if (!hasRole(chain.roles, 'venue')) return [];
    const matches = deploymentFor(parsedDeployments.deployments, chain.id, 'venue');
    const deployment = matches.length === 1 ? (matches[0] ?? null) : null;
    return [profileEvaluation(chain, deployment, originReady)];
  });

  const selectedVenueReady =
    parsedChains.defaultDisconnectedVenueChainId !== null &&
    venueProfiles.some(
      (profile) => profile.chainId === parsedChains.defaultDisconnectedVenueChainId && profile.readCapable,
    );
  if (originReady && !selectedVenueReady) {
    addIssue(issues, 'default-venue-unavailable', 'The configured disconnected venue is not enabled and read-capable.');
  }
  const networkAccessAllowed = originReady && selectedVenueReady;
  const globalBlocking = parsedChains.globalBlocking || parsedDeployments.globalBlocking;
  const enabledProfileInvalid =
    parsedChains.chains.some(
      (chain) => chain.enabled && (!chain.structurallyValid || !chain.enabledRequirementsValid),
    ) ||
    parsedDeployments.deployments.some(
      (deployment) => deployment.enabled && (!deployment.structurallyValid || !deployment.enabledRequirementsValid),
    );

  let state: RuntimeConfigEvaluation['state'];
  // An enabled WalletConnect with no issues does not make the configuration invalid: it is wired
  // and ready to use once a network profile is enabled. It only contributes to `invalid` through
  // its own issues (already surfaced in walletConnect.issues below).
  const walletConnectBlocking = walletConnect.enabled && walletConnect.issues.length > 0;
  const anyNetworkProfileEnabled =
    parsedChains.chains.some((chain) => chain.enabled) ||
    parsedDeployments.deployments.some((deployment) => deployment.enabled);
  if (networkAccessAllowed && !globalBlocking) {
    state = 'ready';
  } else if (!anyNetworkProfileEnabled && !walletConnectBlocking && !globalBlocking) {
    state = 'not-configured';
  } else if (enabledProfileInvalid || globalBlocking || walletConnectBlocking || anyNetworkProfileEnabled) {
    state = 'invalid';
  } else {
    state = 'not-configured';
  }

  return {
    state,
    originProfile,
    venueProfiles,
    walletConnect,
    timing,
    networkAccessAllowed,
    defaultDisconnectedVenueChainId: parsedChains.defaultDisconnectedVenueChainId,
    issues,
  };
};

const loadJson = async (fetcher: RuntimeConfigFetch, url: string): Promise<unknown> => {
  const response = await fetcher(url, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Unable to load ${url}: HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Unable to parse ${url} as JSON.`);
  }
};

const loadOptionalJson = async (fetcher: RuntimeConfigFetch, url: string): Promise<unknown> => {
  try {
    return await loadJson(fetcher, url);
  } catch {
    return null;
  }
};

const loadAbiDocuments = async (
  fetcher: RuntimeConfigFetch,
  files: readonly string[],
): Promise<ReadonlyMap<string, Abi>> => {
  const entries = await Promise.all(
    files.map(async (abiFile): Promise<readonly [string, Abi] | null> => {
      try {
        const abi = await loadJson(fetcher, configUrlForAbi(abiFile));
        return Array.isArray(abi) ? ([abiFile, abi as Abi] as const) : null;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, Abi] => entry !== null));
};

export interface LoadedRuntimeConfig {
  evaluation: RuntimeConfigEvaluation;
  abiDocuments: ReadonlyMap<string, Abi>;
}

const abiFilesForCapableProfiles = (evaluation: RuntimeConfigEvaluation): string[] => {
  const files = new Set<string>();
  const profiles = [evaluation.originProfile, ...evaluation.venueProfiles];
  for (const profile of profiles) {
    if (!profile?.readCapable) continue;
    for (const file of Object.values(profile.abiFiles)) files.add(file);
  }
  return [...files];
};

export const loadRuntimeConfigData = async (
  fetcher: RuntimeConfigFetch = globalThis.fetch.bind(globalThis),
  applicationOrigin: string = resolveApplicationOrigin(globalThis.location?.origin),
): Promise<LoadedRuntimeConfig> => {
  const [chains, deployments, walletConnect, timing] = await Promise.all([
    loadJson(fetcher, '/config/chains.json'),
    loadJson(fetcher, '/config/deployments.json'),
    loadOptionalJson(fetcher, '/config/walletconnect.json'),
    loadOptionalJson(fetcher, '/config/timing.json'),
  ]);
  const documents = { chains, deployments, walletConnect, timing };

  const referencedFiles = collectEnabledAbiFiles(deployments);
  const provisional = validateRuntimeConfig(
    documents,
    new Map(referencedFiles.map((file) => [file, true])),
    applicationOrigin,
  );
  const abiDocuments = await loadAbiDocuments(fetcher, abiFilesForCapableProfiles(provisional));
  const availability = new Map(referencedFiles.map((file) => [file, abiDocuments.has(file)]));

  return {
    evaluation: validateRuntimeConfig(documents, availability, applicationOrigin),
    abiDocuments,
  };
};

export const loadRuntimeConfig = async (
  fetcher: RuntimeConfigFetch = globalThis.fetch.bind(globalThis),
  applicationOrigin: string = resolveApplicationOrigin(globalThis.location?.origin),
): Promise<RuntimeConfigEvaluation> => (await loadRuntimeConfigData(fetcher, applicationOrigin)).evaluation;
