export interface BrowserCapabilitySource {
  fetch?: unknown;
  AbortController?: unknown;
  BigInt?: unknown;
  TextEncoder?: unknown;
  WebAssembly?: unknown;
  crypto?: {
    subtle?: unknown;
  };
}

export interface BrowserSupportResult {
  supported: boolean;
  missingCapabilities: string[];
}

export const evaluateBrowserSupport = (source: BrowserCapabilitySource): BrowserSupportResult => {
  const checks: Array<[string, boolean]> = [
    ['Fetch API', typeof source.fetch === 'function'],
    ['AbortController', typeof source.AbortController === 'function'],
    ['BigInt', typeof source.BigInt === 'function'],
    ['TextEncoder', typeof source.TextEncoder === 'function'],
    ['WebAssembly', typeof source.WebAssembly === 'object'],
    ['Web Crypto', typeof source.crypto?.subtle === 'object'],
  ];

  const missingCapabilities = checks.filter(([, available]) => !available).map(([name]) => name);

  return {
    supported: missingCapabilities.length === 0,
    missingCapabilities,
  };
};
