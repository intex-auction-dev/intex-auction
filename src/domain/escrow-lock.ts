import { NATIVE_UNITS_PER_PROTOCOL_UNIT } from './protocol-constants';

export const BID_RATE_SCALE = 1_000_000n;
export const UINT16_MAX = (1n << 16n) - 1n;
export const UINT32_MAX = (1n << 32n) - 1n;
export const UINT128_MAX = (1n << 128n) - 1n;

export interface EscrowLockInput {
  quantity: bigint;
  promisLoadMinor: bigint;
  bidRate: bigint;
}

const requireRange = (name: string, value: bigint, minimum: bigint, maximum: bigint): void => {
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside the protocol integer range.`);
  }
};

export const calculateEscrowLockMinor = ({ quantity, promisLoadMinor, bidRate }: EscrowLockInput): bigint => {
  requireRange('quantity', quantity, 1n, UINT16_MAX);
  requireRange('promisLoadMinor', promisLoadMinor, 0n, UINT128_MAX);
  requireRange('bidRate', bidRate, 1n, BID_RATE_SCALE);

  const lockAmount = ((quantity * promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
  if (lockAmount > UINT128_MAX) {
    throw new RangeError('Escrow lock amount exceeds uint128.');
  }
  return lockAmount;
};

export const maxQuantityForEscrowLock = ({
  promisLoadMinor,
  bidRate,
}: {
  readonly promisLoadMinor: bigint;
  readonly bidRate: bigint;
}): bigint => {
  if (promisLoadMinor <= 0n || bidRate <= 0n) return UINT16_MAX;
  const perQuantityNative = ((promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
  if (perQuantityNative <= 0n) return UINT16_MAX;
  let cap = UINT128_MAX / perQuantityNative;
  while (
    cap < UINT16_MAX &&
    (((cap + 1n) * promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT <= UINT128_MAX
  ) {
    cap += 1n;
  }
  return cap > UINT16_MAX ? UINT16_MAX : cap;
};
