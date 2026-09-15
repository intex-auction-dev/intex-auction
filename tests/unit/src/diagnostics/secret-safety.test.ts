import { describe, expect, it } from 'vitest';
import { diagnosticError } from '@/diagnostics/local-diagnostics';

describe('diagnostics secret boundary', () => {
  it.each([
    ['raw receipt JSON', `receipt=${JSON.stringify({ quantity: '1000000', bidRate: '525', signature: '0x1234' })}`],
    ['typed data', 'typedData={"domain":{"name":"IntexAuction"},"message":{"bidRate":"525"}}'],
    ['receipt storage key', 'failed for itx-acn:reveal-material:v1:31337:local-v1:0xabc'],
    ['calldata', 'calldata=0x1234'],
    ['wallet session', 'walletConnectSession={"topic":"secret-topic","symKey":"secret"}'],
  ])('redacts %s rather than persisting the payload', (_label, message) => {
    const sanitized = diagnosticError(new Error(message));
    expect(sanitized.message).toBe('<sensitive-redacted>');
  });

  it('does not serialize a raw provider object passed as an error', () => {
    const provider = { request: () => undefined, session: { topic: 'secret-topic' } };
    const sanitized = diagnosticError(provider);
    expect(sanitized).toEqual({ name: 'UnknownError', message: 'An unknown local error occurred.' });
    expect(JSON.stringify(sanitized)).not.toContain('secret-topic');
  });
});
