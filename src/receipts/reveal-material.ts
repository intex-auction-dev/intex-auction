import { getAddress, hashTypedData, keccak256, recoverTypedDataAddress, type Address, type Hash, type Hex } from 'viem';
import { calculateEscrowLockMinor } from '../domain/escrow-lock';
import { parseWorldwideDayKey } from '../domain/protocol-time';

export const REVEAL_MATERIAL_SCHEMA_VERSION = 3 as const;
export const REVIEWED_ADAPTER_PROFILE = 'multi-issuance-usd-reference' as const;
export const REVEAL_BID_DOMAIN_NAME = 'IntexAuction' as const;
export const REVEAL_BID_DOMAIN_VERSION = '1' as const;
export const REVEAL_BID_PRIMARY_TYPE = 'RevealBid' as const;
export const SENSITIVE_RECEIPT_WARNING =
  'Sensitive reveal material: this file contains the exact signature and sealed-bid fields. Anyone who obtains it can learn the bid and may disclose it before reveal.';

export const REVEAL_BID_TYPES = {
  RevealBid: [
    { name: 'worldwideDay', type: 'uint32' },
    { name: 'bidder', type: 'address' },
    { name: 'quantity', type: 'uint16' },
    { name: 'bidRate', type: 'uint32' },
    { name: 'issuanceCurrency', type: 'uint16' },
    { name: 'referenceCurrency', type: 'uint16' },
  ],
} as const;

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UPSTREAM_ISSUANCE_CURRENCY_MAX = 999;
const BID_RATE_SCALE = 1_000_000;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SECP256K1_HALF_N = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0');

export type ReceiptValidationCode =
  | 'schema-failure'
  | 'unsupported-profile'
  | 'checksum-consistency-failure'
  | 'invalid-signature-or-signer'
  | 'domain-mismatch'
  | 'commit-hash-mismatch';

export class ReceiptValidationError extends Error {
  readonly code: ReceiptValidationCode;

  constructor(code: ReceiptValidationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReceiptValidationError';
    this.code = code;
  }
}

export interface RevealBidTypedData {
  readonly primaryType: typeof REVEAL_BID_PRIMARY_TYPE;
  readonly domain: {
    readonly name: typeof REVEAL_BID_DOMAIN_NAME;
    readonly version: typeof REVEAL_BID_DOMAIN_VERSION;
    readonly chainId: number;
    readonly verifyingContract: Address;
  };
  readonly types: typeof REVEAL_BID_TYPES;
  readonly message: {
    readonly worldwideDay: number;
    readonly bidder: Address;
    readonly quantity: number;
    readonly bidRate: number;
    readonly issuanceCurrency: number;
    readonly referenceCurrency: number;
  };
}

export interface RevealMaterialMetadataV1 {
  readonly authority: 'non-authoritative';
  readonly source: 'generated' | 'imported' | 'migrated';
  readonly createdAt: string;
  readonly importedAt?: string;
}

export interface RevealMaterialV1 {
  readonly schemaVersion: typeof REVEAL_MATERIAL_SCHEMA_VERSION;
  readonly adapterProfile: typeof REVIEWED_ADAPTER_PROFILE;
  readonly deploymentId: string;
  readonly chainId: number;
  readonly auctionProxy: Address;
  readonly bidder: Address;
  readonly worldwideDay: number;
  readonly quantity: number;
  readonly bidRate: number;
  readonly issuanceCurrency: number;
  readonly referenceCurrency: number;
  readonly typedData: RevealBidTypedData;
  readonly signature: Hex;
  readonly commitHash: Hash;
  readonly metadata: RevealMaterialMetadataV1;
}

export interface RevealMaterialInput {
  readonly deploymentId: string;
  readonly chainId: number;
  readonly auctionProxy: string;
  readonly bidder: string;
  readonly worldwideDay: number;
  readonly issuanceCurrency: number;
  readonly referenceCurrency: number;
  readonly quantity: number;
  readonly bidRate: number;
  readonly signature: string;
  readonly createdAt: string;
}

export interface AuthoritativeRevealParameters {
  readonly promisLoadMinor: bigint;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(code: ReceiptValidationCode, message: string, cause?: unknown): never {
  throw new ReceiptValidationError(code, message, cause === undefined ? undefined : { cause });
}

const requireInteger = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('schema-failure', `${label} is outside the supported integer range.`);
  }
  return value;
};

const requireString = (value: unknown, label: string, maximumLength = 256): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    fail('schema-failure', `${label} must be a non-empty string.`);
  }
  return value;
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  const timestamp = requireString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    fail('schema-failure', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return timestamp;
};

const requireAddress = (value: unknown, label: string): Address => {
  if (typeof value !== 'string') fail('schema-failure', `${label} must be an address.`);
  try {
    return getAddress(value);
  } catch (error) {
    return fail('schema-failure', `${label} must be a valid EVM address.`, error);
  }
};

const requireHash = (value: unknown, label: string): Hash => {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value))
    fail('schema-failure', `${label} must be a 32-byte hex value.`);
  return value.toLowerCase() as Hash;
};

const requireSignature = (value: unknown): Hex => {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) {
    fail(
      'invalid-signature-or-signer',
      'Signature must be canonical 65-byte r, s, v hex; compact 64-byte signatures are unsupported.',
    );
  }
  const s = BigInt(`0x${value.slice(66, 130)}`);
  const v = Number.parseInt(value.slice(130, 132), 16);
  if (v !== 27 && v !== 28) fail('invalid-signature-or-signer', 'Signature v must be 27 or 28.');
  if (s === 0n || s > SECP256K1_HALF_N)
    fail('invalid-signature-or-signer', 'Signature s must be non-zero and low-s canonical.');
  return value.toLowerCase() as Hex;
};

const requireWorldwideDay = (value: unknown): number => {
  const worldwideDay = requireInteger(value, 'Worldwide day', 0, UINT32_MAX);
  if (!parseWorldwideDayKey(worldwideDay.toString()).ok)
    fail('schema-failure', 'Worldwide day must be a possible eight-digit YYYYMMDD protocol date.');
  return worldwideDay;
};
const requireQuantity = (value: unknown): number => requireInteger(value, 'Quantity', 1, UINT16_MAX);
const requireIssuanceCurrency = (value: unknown): number =>
  requireInteger(value, 'Issuance currency', 1, UPSTREAM_ISSUANCE_CURRENCY_MAX);
const requireReferenceCurrency = (value: unknown): number => requireInteger(value, 'Reference currency', 1, UINT16_MAX);
const requireBidRate = (value: unknown): number => {
  const rate = requireInteger(value, 'Bid rate', 1, UINT32_MAX);
  if (rate > BID_RATE_SCALE) fail('schema-failure', 'Bid rate exceeds the reviewed 1e6 fixed-point maximum.');
  return rate;
};
const requireChainId = (value: unknown): number => requireInteger(value, 'Chain ID', 1, Number.MAX_SAFE_INTEGER);
const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

const isExactTypes = (value: unknown): boolean => {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.RevealBid)) return false;
  return (
    value.RevealBid.length === REVEAL_BID_TYPES.RevealBid.length &&
    value.RevealBid.every((field, index) => {
      const expectedField = REVEAL_BID_TYPES.RevealBid[index];
      return (
        expectedField !== undefined &&
        isRecord(field) &&
        hasExactKeys(field, ['name', 'type']) &&
        field.name === expectedField.name &&
        field.type === expectedField.type
      );
    })
  );
};

const parseMetadata = (value: unknown): RevealMaterialMetadataV1 => {
  if (!isRecord(value) || value.authority !== 'non-authoritative')
    fail('schema-failure', 'Receipt metadata must be explicitly non-authoritative.');
  const keys =
    value.importedAt === undefined
      ? ['authority', 'source', 'createdAt']
      : ['authority', 'source', 'createdAt', 'importedAt'];
  if (!hasExactKeys(value, keys)) fail('unsupported-profile', 'Receipt metadata contains unreviewed fields.');
  if (value.source !== 'generated' && value.source !== 'imported' && value.source !== 'migrated')
    fail('schema-failure', 'Receipt metadata has an unsupported source.');
  const createdAt = requireIsoTimestamp(value.createdAt, 'Receipt creation time');
  const importedAt =
    value.importedAt === undefined ? undefined : requireIsoTimestamp(value.importedAt, 'Receipt import time');
  return importedAt === undefined
    ? { authority: 'non-authoritative', source: value.source, createdAt }
    : { authority: 'non-authoritative', source: value.source, createdAt, importedAt };
};

const freezeMaterial = (material: RevealMaterialV1): RevealMaterialV1 =>
  Object.freeze({
    ...material,
    typedData: Object.freeze({
      ...material.typedData,
      domain: Object.freeze({ ...material.typedData.domain }),
      message: Object.freeze({ ...material.typedData.message }),
      types: REVEAL_BID_TYPES,
    }),
    metadata: Object.freeze({ ...material.metadata }),
  });

export function buildRevealBidTypedData(input: {
  readonly chainId: number;
  readonly auctionProxy: string;
  readonly bidder: string;
  readonly worldwideDay: number;
  readonly quantity: number;
  readonly bidRate: number;
  readonly issuanceCurrency: number;
  readonly referenceCurrency: number;
}): RevealBidTypedData {
  const chainId = requireChainId(input.chainId);
  const auctionProxy = requireAddress(input.auctionProxy, 'Auction proxy');
  const bidder = requireAddress(input.bidder, 'Bidder');
  const worldwideDay = requireWorldwideDay(input.worldwideDay);
  const quantity = requireQuantity(input.quantity);
  const bidRate = requireBidRate(input.bidRate);
  const issuanceCurrency = requireIssuanceCurrency(input.issuanceCurrency);
  const referenceCurrency = requireReferenceCurrency(input.referenceCurrency);
  return {
    domain: {
      name: REVEAL_BID_DOMAIN_NAME,
      version: REVEAL_BID_DOMAIN_VERSION,
      chainId,
      verifyingContract: auctionProxy,
    },
    primaryType: REVEAL_BID_PRIMARY_TYPE,
    types: REVEAL_BID_TYPES,
    message: { worldwideDay, bidder, quantity, bidRate, issuanceCurrency, referenceCurrency },
  };
}

export const hashRevealBidTypedData = (typedData: RevealBidTypedData): Hash => hashTypedData(typedData as never);
export const deriveCommitHash = (signature: string): Hash => keccak256(requireSignature(signature));

export const calculateValidatedRevealLockMinor = (
  material: Pick<RevealMaterialV1, 'quantity' | 'bidRate'>,
  parameters: AuthoritativeRevealParameters,
): bigint => {
  const lockAmount = (() => {
    try {
      return calculateEscrowLockMinor({
        quantity: BigInt(material.quantity),
        promisLoadMinor: parameters.promisLoadMinor,
        bidRate: BigInt(material.bidRate),
      });
    } catch (error) {
      return fail('checksum-consistency-failure', 'Authoritative reveal lock is outside the contract range.', error);
    }
  })();
  if (lockAmount === 0n) fail('checksum-consistency-failure', 'Authoritative reveal lock truncates to zero.');
  return lockAmount;
};

export const createRevealMaterial = async (
  input: RevealMaterialInput,
  authoritativeParameters?: AuthoritativeRevealParameters,
): Promise<RevealMaterialV1> => {
  const typedData = buildRevealBidTypedData({
    chainId: input.chainId,
    auctionProxy: input.auctionProxy,
    bidder: input.bidder,
    worldwideDay: input.worldwideDay,
    quantity: input.quantity,
    bidRate: input.bidRate,
    issuanceCurrency: input.issuanceCurrency,
    referenceCurrency: input.referenceCurrency,
  });
  const material: RevealMaterialV1 = {
    schemaVersion: REVEAL_MATERIAL_SCHEMA_VERSION,
    adapterProfile: REVIEWED_ADAPTER_PROFILE,
    deploymentId: input.deploymentId,
    chainId: typedData.domain.chainId,
    auctionProxy: typedData.domain.verifyingContract,
    bidder: typedData.message.bidder,
    worldwideDay: typedData.message.worldwideDay,
    quantity: typedData.message.quantity,
    bidRate: typedData.message.bidRate,
    issuanceCurrency: typedData.message.issuanceCurrency,
    referenceCurrency: typedData.message.referenceCurrency,
    typedData,
    signature: input.signature as Hex,
    commitHash: deriveCommitHash(input.signature),
    metadata: { authority: 'non-authoritative' as const, source: 'generated' as const, createdAt: input.createdAt },
  };
  return validateRevealMaterial(material, authoritativeParameters);
};

export const validateRevealMaterial = async (
  value: unknown,
  authoritativeParameters?: AuthoritativeRevealParameters,
): Promise<RevealMaterialV1> => {
  if (!isRecord(value)) fail('schema-failure', 'Reveal material must be an object.');
  if (value.schemaVersion !== REVEAL_MATERIAL_SCHEMA_VERSION) {
    fail('schema-failure', 'Unsupported reveal-material schema version.');
  }
  if (value.adapterProfile !== REVIEWED_ADAPTER_PROFILE) {
    fail('unsupported-profile', 'Unsupported receipt adapter profile.');
  }
  const topKeys = [
    'schemaVersion',
    'adapterProfile',
    'deploymentId',
    'chainId',
    'auctionProxy',
    'bidder',
    'worldwideDay',
    'issuanceCurrency',
    'referenceCurrency',
    'quantity',
    'bidRate',
    'typedData',
    'signature',
    'commitHash',
    'metadata',
  ];
  if (!hasExactKeys(value, topKeys)) fail('unsupported-profile', 'Reveal material contains unreviewed fields.');

  const deploymentId = requireString(value.deploymentId, 'Deployment identity', 128);
  const chainId = requireChainId(value.chainId);
  const auctionProxy = requireAddress(value.auctionProxy, 'Auction proxy');
  const bidder = requireAddress(value.bidder, 'Bidder');
  const worldwideDay = requireWorldwideDay(value.worldwideDay);
  const issuanceCurrency = requireIssuanceCurrency(value.issuanceCurrency);
  const referenceCurrency = requireReferenceCurrency(value.referenceCurrency);
  const quantity = requireQuantity(value.quantity);
  const bidRate = requireBidRate(value.bidRate);
  const signature = requireSignature(value.signature);
  const commitHash = requireHash(value.commitHash, 'Commit hash');
  const metadata = parseMetadata(value.metadata);

  if (!isRecord(value.typedData) || !hasExactKeys(value.typedData, ['domain', 'primaryType', 'types', 'message'])) {
    fail('unsupported-profile', 'Typed data contains unreviewed fields.');
  }
  if (value.typedData.primaryType !== REVEAL_BID_PRIMARY_TYPE || !isExactTypes(value.typedData.types)) {
    fail('unsupported-profile', 'Typed-data primary type or fields do not match the reviewed profile.');
  }
  if (
    !isRecord(value.typedData.domain) ||
    !hasExactKeys(value.typedData.domain, ['name', 'version', 'chainId', 'verifyingContract'])
  ) {
    fail('domain-mismatch', 'Typed-data domain contains unreviewed fields.');
  }
  if (
    value.typedData.domain.name !== REVEAL_BID_DOMAIN_NAME ||
    value.typedData.domain.version !== REVEAL_BID_DOMAIN_VERSION
  ) {
    fail('domain-mismatch', 'Typed-data domain name or version does not match the reviewed profile.');
  }
  const domainChainId = requireChainId(value.typedData.domain.chainId);
  const domainContract = requireAddress(value.typedData.domain.verifyingContract, 'Typed-data verifying contract');
  if (domainChainId !== chainId || !sameAddress(domainContract, auctionProxy))
    fail('domain-mismatch', 'Typed-data domain does not match the stored chain and auction proxy.');

  if (!isRecord(value.typedData.message)) fail('checksum-consistency-failure', 'Typed-data message is missing.');
  const expectedMessageKeys = [
    'worldwideDay',
    'bidder',
    'quantity',
    'bidRate',
    'issuanceCurrency',
    'referenceCurrency',
  ];
  if (!hasExactKeys(value.typedData.message, expectedMessageKeys))
    fail('unsupported-profile', 'Typed-data message contains unreviewed fields.');
  const messageWorldwideDay = requireWorldwideDay(value.typedData.message.worldwideDay);
  const messageBidder = requireAddress(value.typedData.message.bidder, 'Typed-data bidder');
  const messageIssuanceCurrency = requireIssuanceCurrency(value.typedData.message.issuanceCurrency);
  const messageReferenceCurrency = requireReferenceCurrency(value.typedData.message.referenceCurrency);
  const messageQuantity = requireQuantity(value.typedData.message.quantity);
  const messageBidRate = requireBidRate(value.typedData.message.bidRate);
  if (
    messageWorldwideDay !== worldwideDay ||
    !sameAddress(messageBidder, bidder) ||
    messageIssuanceCurrency !== issuanceCurrency ||
    messageReferenceCurrency !== referenceCurrency ||
    messageQuantity !== quantity ||
    messageBidRate !== bidRate
  ) {
    fail('checksum-consistency-failure', 'Typed-data message does not match the stored reveal fields.');
  }

  const canonicalTypedData = buildRevealBidTypedData({
    chainId,
    auctionProxy,
    bidder,
    worldwideDay,
    quantity,
    bidRate,
    issuanceCurrency,
    referenceCurrency,
  });
  const recovered = await recoverTypedDataAddress({ ...(canonicalTypedData as object), signature } as never).catch(
    (error: unknown) => fail('invalid-signature-or-signer', 'Signature recovery failed.', error),
  );
  if (!sameAddress(recovered, bidder))
    fail('invalid-signature-or-signer', 'Recovered signer does not equal the stored bidder.');
  if ((keccak256(signature).toLowerCase() as Hash) !== commitHash)
    fail('commit-hash-mismatch', 'Stored commit hash does not equal keccak256(signature).');

  const material: RevealMaterialV1 = freezeMaterial({
    schemaVersion: REVEAL_MATERIAL_SCHEMA_VERSION,
    adapterProfile: REVIEWED_ADAPTER_PROFILE,
    deploymentId,
    chainId,
    auctionProxy,
    bidder,
    worldwideDay,
    issuanceCurrency,
    referenceCurrency,
    quantity,
    bidRate,
    signature,
    commitHash,
    metadata,
    typedData: canonicalTypedData,
  });
  if (authoritativeParameters !== undefined) calculateValidatedRevealLockMinor(material, authoritativeParameters);
  return material;
};
