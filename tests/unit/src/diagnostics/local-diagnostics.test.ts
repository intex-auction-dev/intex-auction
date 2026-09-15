import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticEndpoint, diagnosticError, diagnosticRecord, emitDiagnostic } from '@/diagnostics/local-diagnostics';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('local diagnostics sanitization', () => {
  it('reduces RPC URLs to a credential-free origin', () => {
    expect(diagnosticEndpoint('https://user:secret@rpc.example.org:8545/private/path?apiKey=secret#fragment')).toBe(
      'https://rpc.example.org:8545',
    );
    expect(diagnosticEndpoint('http://127.0.0.1:8545/path')).toBe('http://127.0.0.1:8545');
    expect(diagnosticEndpoint('wss://relay.example.org/path')).toBeNull();
    expect(diagnosticEndpoint('not a url')).toBeNull();
  });

  it('bounds and redacts provider error text before persistence', () => {
    const secretHex = `0x${'ab'.repeat(96)}`;
    const error = new Error(
      `Request failed at https://user:secret@rpc.example.org:8545/private?apiKey=secret with ${secretHex}\nstack detail`,
    );
    error.name = 'ProviderRpcError';
    const sanitized = diagnosticError(error);
    expect(sanitized.name).toBe('ProviderRpcError');
    expect(sanitized.message).toContain('https://rpc.example.org:8545');
    expect(sanitized.message).not.toContain('user:secret');
    expect(sanitized.message).not.toContain('/private');
    expect(sanitized.message).not.toContain('apiKey');
    expect(sanitized.message).not.toContain(secretHex);
    expect(sanitized.message).not.toContain('stack detail');
    expect(sanitized.message.length).toBeLessThanOrEqual(512);
  });

  it('redacts secret-shaped provider error names before persistence', () => {
    const address = `0x${'ab'.repeat(20)}`;
    const error = {
      name: `Wallet ${address} wc:secret-topic@2?relay-protocol=irn https://user:secret@rpc.example.org/private?key=secret`,
      message: 'Provider failed.',
    };
    const sanitized = diagnosticError(error);
    expect(sanitized.name).not.toContain(address);
    expect(sanitized.name).not.toContain('wc:secret-topic');
    expect(sanitized.name).not.toContain('user:secret');
    expect(sanitized.name).not.toContain('/private');
    expect(sanitized.name).not.toContain('?key=secret');
    expect(sanitized.name.length).toBeLessThanOrEqual(96);
  });

  it('builds a versioned timestamped record without adding arbitrary fields', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T17:30:00.000Z'));
    expect(
      diagnosticRecord({
        category: 'wallet',
        event: 'state',
        providerType: 'injected',
        chainId: 56,
        connected: true,
      }),
    ).toEqual({
      schemaVersion: 1,
      at: '2026-08-17T17:30:00.000Z',
      category: 'wallet',
      event: 'state',
      providerType: 'injected',
      chainId: 56,
      connected: true,
    });
  });
});

describe('local diagnostics emission', () => {
  it('posts only to the same-origin diagnostics path and swallows transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('local server unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    expect(() =>
      emitDiagnostic({
        category: 'rpc',
        event: 'selected',
        role: 'origin',
        profileId: 'outbe-mainnet',
        chainId: 999,
        endpoint: 'https://rpc.example.org',
      }),
    ).not.toThrow();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('Expected diagnostics fetch call.');
    const [url, rawInit] = call;
    const init = rawInit as RequestInit;
    expect(url).toBe('/__diagnostics/v1');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      credentials: 'same-origin',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      schemaVersion: 1,
      category: 'rpc',
      event: 'selected',
      endpoint: 'https://rpc.example.org',
    });
  });
});
