export type DiagnosticEvent =
  | {
      readonly category: 'app';
      readonly event: 'started';
      readonly version?: string | null;
      readonly commit?: string | null;
      readonly browser?: string | null;
      readonly path?: string | null;
    }
  | {
      readonly category: 'runtime';
      readonly event: 'loaded';
      readonly originProfileId?: string | null;
      readonly venueProfileId?: string | null;
      readonly originDeploymentId?: string | null;
      readonly venueDeploymentId?: string | null;
      readonly originChainId?: number | null;
      readonly venueChainId?: number | null;
    }
  | {
      readonly category: 'rpc';
      readonly event: 'selected';
      readonly role?: 'origin' | 'venue' | null;
      readonly component?: string | null;
      readonly profileId?: string | null;
      readonly chainId?: number | null;
      readonly endpoint?: string | null;
    }
  | {
      readonly category: 'rpc';
      readonly event: 'error';
      readonly role?: 'origin' | 'venue' | null;
      readonly component?: string | null;
      readonly profileId?: string | null;
      readonly chainId?: number | null;
      readonly endpoint?: string | null;
      readonly operation?: string | null;
      readonly method?: string | null;
      readonly name?: string | null;
      readonly message?: string | null;
    }
  | {
      readonly category: 'chain';
      readonly event: 'head';
      readonly role?: 'origin' | 'venue' | null;
      readonly profileId?: string | null;
      readonly chainId: number;
      readonly blockNumber: string;
      readonly blockHash?: `0x${string}` | null;
      readonly blockTimestamp?: string | null;
      readonly lastSuccessfulReadAt: string;
    }
  | {
      readonly category: 'auction';
      readonly event: 'context';
      readonly worldwideDay?: string | null;
      readonly stage?: string | null;
      readonly readState?: string | null;
      readonly cacheStatus?: string | null;
      readonly scanStatus?: string | null;
    }
  | {
      readonly category: 'wallet';
      readonly event: 'state';
      readonly providerType?: string | null;
      readonly chainId?: number | null;
      readonly venueProfileId?: string | null;
      readonly venueDeploymentId?: string | null;
      readonly connected: boolean;
    }
  | {
      readonly category: 'transaction';
      readonly event: 'state';
      readonly kind: string;
      readonly state: string;
      readonly transactionHash?: `0x${string}` | null;
    }
  | {
      readonly category: 'error';
      readonly event: 'caught';
      readonly boundary?: string | null;
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly category: 'error';
      readonly event: 'runtime';
      readonly component?: string | null;
      readonly operation?: string | null;
      readonly name: string;
      readonly message: string;
    };

export type DiagnosticRecord<T extends DiagnosticEvent = DiagnosticEvent> = T & {
  readonly schemaVersion: 1;
  readonly at: string;
};

const MAX_ERROR_NAME = 96;
const MAX_ERROR_MESSAGE = 512;
const URL_TOKEN = /https?:\/\/[^\s"'<>]+/gi;
const LONG_HEX = /0x[0-9a-f]{40,}/gi;
const WALLETCONNECT_URI = /wc:[^\s"'<>]+/gi;
const SENSITIVE_DIAGNOSTIC_TEXT =
  /itx-acn:reveal-material:|"(?:signature|types|primaryType|receiptStorageKey|calldata|topic|symKey|namespaces)"\s*:|(?:^|[\s"'[{,(])(?:typedData|receiptStorageKey|calldata|walletConnectSession)\s*[:=]/i;

const firstLine = (value: string): string => value.split(/\r?\n/, 1)[0] ?? '';
const bounded = (value: string, max: number): string => value.slice(0, max);

export const diagnosticEndpoint = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
};

const redactDiagnosticText = (value: string, max: number): string => {
  const line = firstLine(value);
  if (SENSITIVE_DIAGNOSTIC_TEXT.test(line)) return '<sensitive-redacted>';
  return bounded(
    line
      .replace(URL_TOKEN, (match) => diagnosticEndpoint(match) ?? '<url-redacted>')
      .replace(WALLETCONNECT_URI, '<walletconnect-redacted>')
      .replace(LONG_HEX, '<hex-redacted>'),
    max,
  );
};

const objectString = (value: unknown, key: 'name' | 'message'): string | null => {
  if (value === null || typeof value !== 'object') return null;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
};

export const diagnosticError = (error: unknown): { readonly name: string; readonly message: string } => {
  const name =
    error instanceof Error
      ? error.name
      : (objectString(error, 'name') ?? (typeof error === 'string' ? 'Error' : 'UnknownError'));
  const message =
    error instanceof Error
      ? error.message
      : (objectString(error, 'message') ?? (typeof error === 'string' ? error : 'An unknown local error occurred.'));
  return {
    name: redactDiagnosticText(name, MAX_ERROR_NAME),
    message: redactDiagnosticText(message, MAX_ERROR_MESSAGE),
  };
};

export const diagnosticRecord = <T extends DiagnosticEvent>(event: T): DiagnosticRecord<T> => ({
  schemaVersion: 1,
  at: new Date().toISOString(),
  ...event,
});

export const emitDiagnostic = (event: DiagnosticEvent): void => {
  // The journal sink exists only in a development checkout's server. A released bundle posting to it
  // would log a failed request on every operator host, so production builds drop the call entirely.
  if (!import.meta.env.DEV) return;
  if (typeof globalThis.fetch !== 'function') return;
  try {
    const body = JSON.stringify(diagnosticRecord(event));
    void globalThis
      .fetch('/__diagnostics/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'same-origin',
      })
      .catch(() => {});
  } catch {
    // Diagnostics are advisory and must never affect application correctness.
  }
};
