import { describe, expect, it } from 'vitest';
import {
  isAllowedLocalDevOrigin,
  normalizeLocalDevTesterAddress,
} from '../../../../dev/local-chain/controls/vite-local-dev-plugin.mjs';

describe('local dev-controls request origins', () => {
  it('accepts localhost and loopback origins, while rejecting external origins', () => {
    expect(isAllowedLocalDevOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedLocalDevOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedLocalDevOrigin('https://example.test')).toBe(false);
  });

  it('normalizes tester-wallet addresses with viem and rejects malformed input', () => {
    expect(typeof normalizeLocalDevTesterAddress).toBe('function');
    expect(normalizeLocalDevTesterAddress(' 0x90f79bf6eb2c4f870365e785982e1f101e93b906 ')).toBe(
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    );
    expect(() => normalizeLocalDevTesterAddress('not-an-address')).toThrow('Invalid tester wallet address.');
  });
});
