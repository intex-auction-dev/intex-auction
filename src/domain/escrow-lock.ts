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

  // Chain: IntexAuction.revealBid (IntexAuction.sol:403-405)
  //   uint256(quantity) * escrowBasis * bidRate / SCALE_1E6 * NATIVE_UNITS_PER_PROTOCOL_UNIT
  // The /SCALE_1E6 truncation happens BEFORE the *1e12: (x/1e6)*1e12 != (x*1e12)/1e6 when x % 1e6 != 0.
  const lockAmount = ((quantity * promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
  // BNB (the target the app simulates against) reverts on uint128 overflow; Outbe/Desis saturates.
  // LockAmountParity.t.sol pins `bnbLockAmount` to revert BidAmountOverflow, so we throw to match.
  if (lockAmount > UINT128_MAX) {
    throw new RangeError('Escrow lock amount exceeds uint128.');
  }
  return lockAmount;
};

// Mirrors IntexAuction.revealBid's uint128 escrow-lock overflow bound, in native-18 units.
// The cap solves for the largest quantity whose full expression (including *1e12) stays <= uint128.
export const maxQuantityForEscrowLock = ({
  promisLoadMinor,
  bidRate,
}: {
  readonly promisLoadMinor: bigint;
  readonly bidRate: bigint;
}): bigint => {
  if (promisLoadMinor <= 0n || bidRate <= 0n) return UINT16_MAX;
  // Invert ((q*basis*rate)/1e6)*1e12 <= UINT128_MAX. The chain truncates the /1e6 division per unit
  // of quantity, so the exact frontier is per-quantity; we derive a safe closed-form lower bound and
  // then walk it up while the real formula still fits, so the returned cap never overflows the lock.
  const perQuantityNative = ((promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT;
  if (perQuantityNative <= 0n) return UINT16_MAX;
  let cap = UINT128_MAX / perQuantityNative;
  // ponytail: linear walk-up bounded by uint16 (<=65535 iters); truncation makes higher quantities
  // fit slightly more than the closed form predicts. Replace with a binary search if it ever matters.
  while (
    cap < UINT16_MAX &&
    (((cap + 1n) * promisLoadMinor * bidRate) / BID_RATE_SCALE) * NATIVE_UNITS_PER_PROTOCOL_UNIT <= UINT128_MAX
  ) {
    cap += 1n;
  }
  return cap > UINT16_MAX ? UINT16_MAX : cap;
};
