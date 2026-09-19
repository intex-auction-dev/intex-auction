import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem';

/**
 * Deployment, wiring and protocol read-failure classifications. They live in `chain`
 * because they classify RPC/revert outcomes: the adapters in `protocol` throw them and
 * the auction consumers match them with `instanceof`, so both layers depend on this one
 * shared vocabulary rather than on each other.
 */
export class IncompatibleDeploymentError extends Error {}
export class IncompatibleWiringError extends Error {}
export class OriginWorldwideDayNotFoundError extends Error {}
export class VenueAuctionNotFoundError extends Error {}

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;

export const implementationAddressFromStorage = (value: Hex | undefined): Address => {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new IncompatibleDeploymentError('IntexAuction proxy implementation evidence is unavailable.');
  }
  const address = getAddress(`0x${value.slice(-40)}`);
  if (/^0x0{40}$/i.test(address)) {
    throw new IncompatibleDeploymentError('IntexAuction proxy implementation evidence is unavailable.');
  }
  return address;
};

const causeChain = (error: unknown): Record<string, unknown>[] => {
  const result: Record<string, unknown>[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    result.push(record);
    current = record.cause;
  }
  return result;
};

const decodedError = (error: unknown): { name: string; args: readonly unknown[] } | null => {
  for (const item of causeChain(error)) {
    const data = item.data;
    if (typeof data !== 'object' || data === null) continue;
    const record = data as Record<string, unknown>;
    if (typeof record.errorName === 'string') {
      return {
        name: record.errorName,
        args: Array.isArray(record.args) ? record.args : [],
      };
    }
  }
  return null;
};

const revertHex = (error: unknown): Hex | null => {
  for (const item of causeChain(error)) {
    if (typeof item.data === 'string' && /^0x[0-9a-fA-F]+$/.test(item.data)) return item.data as Hex;
    if (typeof item.raw === 'string' && /^0x[0-9a-fA-F]+$/.test(item.raw)) return item.raw as Hex;
  }
  return null;
};

const matchesSelector = (error: unknown, signature: string): boolean =>
  revertHex(error)?.slice(0, 10).toLowerCase() === toFunctionSelector(signature).toLowerCase();

export const isWorldwideDayNotFound = (error: unknown): boolean => {
  if (error instanceof OriginWorldwideDayNotFoundError) return true;
  const decoded = decodedError(error);
  return (
    (decoded?.name === 'Error' && decoded.args[0] === 'WorldwideDay not found') ||
    decoded?.name === 'UnknownWorldwideDay' ||
    matchesSelector(error, 'UnknownWorldwideDay(uint32)')
  );
};

export const isUnknownTerminalReceipt = (error: unknown): boolean => {
  const decoded = decodedError(error);
  return decoded?.name === 'UnknownTerminalReceipt' || matchesSelector(error, 'UnknownTerminalReceipt(uint32)');
};

export const isAuctionNotFound = (error: unknown): boolean => {
  const decoded = decodedError(error);
  return decoded?.name === 'AuctionNotFound' || matchesSelector(error, 'AuctionNotFound()');
};

export const isNotWhitelisted = (error: unknown): boolean => {
  const decoded = decodedError(error);
  return decoded?.name === 'NotWhitelisted' || matchesSelector(error, 'NotWhitelisted(address)');
};
