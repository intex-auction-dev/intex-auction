import { getAddress, type Abi, type AbiEvent, type Address, type Hash, type Hex } from 'viem';
import { parseWorldwideDayKey, type WorldwideDayKey } from '../domain/protocol-time';

/**
 * Coercers for values arriving from contract reads and decoded logs.
 *
 * This is a trust boundary: everything here treats its input as untrusted and throws
 * rather than coercing silently, because a malformed contract read must surface as a
 * read failure and never as a plausible-looking number.
 *
 * These deliberately reject numeric strings. Values revived from persisted JSON *do*
 * arrive as strings, and the cache modules keep their own lenient parsers for that
 * reason — sharing one parser across both would let a cached string satisfy a contract
 * read. Keep the two families apart.
 */

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

export const asArray = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
};

/** Reads a field from either a positional tuple or a named struct return. */
export const tupleValue = (value: unknown, name: string, index: number, label: string): unknown =>
  Array.isArray(value) ? value[index] : asRecord(value, label)[name];

export const asBigint = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer.`);
};

/** Use where the contract type is unsigned and a negative value is a decode fault. */
export const asUnsignedBigint = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${label} must be an unsigned integer.`);
};

export const asSafeNumber = (value: unknown, label: string): number => {
  const integer = asBigint(value, label);
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(integer);
};

/** Narrows an unsigned value to a caller-supplied maximum, e.g. an enum tag ceiling. */
export const asBoundedNumber = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => {
  const integer = asUnsignedBigint(value, label);
  if (integer > BigInt(max)) throw new RangeError(`${label} exceeds its integer range.`);
  return Number(integer);
};

export const asUint = (value: unknown, bits: number, label: string): bigint => {
  const integer = asBigint(value, label);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (integer < 0n || integer > maximum) throw new RangeError(`${label} exceeds uint${bits}.`);
  return integer;
};

export const asUintNumber = (value: unknown, bits: number, label: string): number => Number(asUint(value, bits, label));

export const asBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean.`);
  return value;
};

export const asAddress = (value: unknown, label: string): Address => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an address.`);
  return getAddress(value);
};

export const asHash = (value: unknown, label: string): Hash => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be bytes32.`);
  }
  return value.toLowerCase() as Hash;
};

/** Any even-length hex byte string, e.g. an ABI-encoded blob or revert payload. */
export const asHexBytes = (value: unknown, label: string): Hex => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new TypeError(`${label} must be hex bytes.`);
  }
  return value as Hex;
};

/** Fixed-width hex, lowercased so decoded values compare equal regardless of source casing. */
export const asBytes = (value: unknown, byteLength: number, label: string): Hex => {
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${label} must be a bytes${byteLength} hex value.`);
  }
  return value.toLowerCase() as Hex;
};

export const asWorldwideDayKey = (value: unknown, label: string): WorldwideDayKey => {
  const parsed = parseWorldwideDayKey(asSafeNumber(value, label).toString().padStart(8, '0'));
  if (!parsed.ok) throw new TypeError(`${label} must be a valid WorldwideDay key.`);
  return parsed.value;
};

export const eventFromAbi = (abi: Abi, name: string): AbiEvent => {
  const event = abi.find((entry) => entry.type === 'event' && entry.name === name);
  if (event?.type !== 'event') throw new TypeError(`ABI is missing ${name}.`);
  return event;
};
