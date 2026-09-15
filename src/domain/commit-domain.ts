import { BID_RATE_SCALE, calculateEscrowLockMinor, UINT16_MAX, UINT32_MAX } from './escrow-lock';

export interface CommitBidConstraints {
  readonly minQuantity: number;
  readonly minBidRate: number;
  readonly promisLoadMinor: bigint;
}

export interface ValidatedCommitBid {
  readonly quantity: number;
  readonly bidRate: number;
  readonly revealLockMinor: bigint;
}

const QUANTITY_PATTERN = /^\d+$/;
const PERCENT_PATTERN = /^(\d{1,3})(?:\.(\d{1,4}))?$/;
const UNSIGNED_DECIMAL_PATTERN = /^(\d+)(?:\.(\d*))?$/;
const BID_RATE_UNITS_PER_PERCENT = BID_RATE_SCALE / 100n;

const parseUnsignedFixedInput = (value: string, decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError('Payment-token decimals are outside the ERC-20 range.');
  }
  const match = UNSIGNED_DECIMAL_PATTERN.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new RangeError(`Bid per Intex must be a non-negative amount with at most ${decimals} decimal places.`);
  }
  const scale = 10n ** BigInt(decimals);
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  return BigInt(match[1]!) * scale + BigInt(fraction || '0');
};

export const parseQuantityInput = (value: string): number => {
  const normalized = value.trim();
  if (!QUANTITY_PATTERN.test(normalized)) {
    throw new RangeError('Quantity must be a whole number.');
  }
  const quantity = BigInt(normalized);
  if (quantity <= 0n || quantity > UINT16_MAX) {
    throw new RangeError('Quantity is outside the uint16 contract range.');
  }
  return Number(quantity);
};

export const parseBidRatePercent = (value: string): number => {
  const normalized = value.trim();
  const match = PERCENT_PATTERN.exec(normalized);
  if (!match) {
    throw new RangeError('Bid rate must be a percentage with at most four decimal places.');
  }
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(4, '0'));
  const bidRate = whole * BID_RATE_UNITS_PER_PERCENT + fraction;
  if (bidRate <= 0n || bidRate > BID_RATE_SCALE || bidRate > UINT32_MAX) {
    throw new RangeError('Bid rate must be greater than 0% and no more than 100%.');
  }
  return Number(bidRate);
};

export const effectiveMinimumBidQuantity = (minimumBidQuantity: number): number => Math.max(1, minimumBidQuantity);

export const effectiveMinimumBidRate = (minimumBidRate: number): number => Math.max(1, minimumBidRate);

export const formatContractBidRatePercent = (bidRate: number): string => {
  if (!Number.isSafeInteger(bidRate) || bidRate < 0 || BigInt(bidRate) > BID_RATE_SCALE) {
    throw new RangeError('Contract bid rate is outside the reviewed range.');
  }
  const unitsPerPercent = Number(BID_RATE_UNITS_PER_PERCENT);
  const whole = Math.floor(bidRate / unitsPerPercent);
  const fraction = String(bidRate % unitsPerPercent)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
};

export const paymentAmountInputToBidRatePercent = (input: {
  readonly value: string;
  readonly paymentTokenDecimals: number;
  readonly promisLoadMinor: bigint;
  readonly minimumBidRate: number;
}): string => {
  if (
    !Number.isSafeInteger(input.minimumBidRate) ||
    input.minimumBidRate < 0 ||
    BigInt(input.minimumBidRate) > BID_RATE_SCALE
  ) {
    throw new RangeError('Minimum bid rate is outside the reviewed contract range.');
  }
  const requestedRate = rawBidRatePercent(input);
  const minimumRate = BigInt(effectiveMinimumBidRate(input.minimumBidRate));
  const boundedRate = requestedRate < minimumRate ? minimumRate : requestedRate;
  return formatContractBidRatePercent(Number(boundedRate)).replace('%', '');
};

export const paymentAmountToBidRatePercent = (input: {
  readonly value: string;
  readonly paymentTokenDecimals: number;
  readonly promisLoadMinor: bigint;
}): string => {
  const requestedRate = rawBidRatePercent(input);
  return formatContractBidRatePercent(Number(requestedRate)).replace('%', '');
};

const rawBidRatePercent = (input: {
  readonly value: string;
  readonly paymentTokenDecimals: number;
  readonly promisLoadMinor: bigint;
}): bigint => {
  if (input.promisLoadMinor <= 0n) {
    throw new RangeError('Escrow basis must be greater than zero.');
  }
  const paymentMinor = parseUnsignedFixedInput(input.value, input.paymentTokenDecimals);
  const requestedRate =
    paymentMinor === 0n ? 0n : (paymentMinor * BID_RATE_SCALE + input.promisLoadMinor - 1n) / input.promisLoadMinor;
  return requestedRate > BID_RATE_SCALE ? BID_RATE_SCALE : requestedRate;
};

export const validateCommitBidInput = (input: {
  readonly quantity: string;
  readonly bidRatePercent: string;
  readonly constraints: CommitBidConstraints;
}): ValidatedCommitBid => {
  const quantity = parseQuantityInput(input.quantity);
  const bidRate = parseBidRatePercent(input.bidRatePercent);
  if (quantity < input.constraints.minQuantity) {
    throw new RangeError(`Quantity must be at least ${input.constraints.minQuantity}.`);
  }
  if (bidRate < input.constraints.minBidRate) {
    throw new RangeError(`Bid rate must be at least ${formatContractBidRatePercent(input.constraints.minBidRate)}.`);
  }
  const revealLockMinor = calculateEscrowLockMinor({
    quantity: BigInt(quantity),
    promisLoadMinor: input.constraints.promisLoadMinor,
    bidRate: BigInt(bidRate),
  });
  if (revealLockMinor === 0n) {
    throw new RangeError('The calculated reveal lock truncates to zero.');
  }
  return { quantity, bidRate, revealLockMinor };
};
