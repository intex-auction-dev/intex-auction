import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRuntimeConfig } from '@/runtime-config/runtime-config';

// Guards the shipped placeholder config: no runtime-config test loaded the real
// committed config/ files, which let a malformed explicit-null oraclePair ship.
const readConfig = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../config/${name}`, import.meta.url)), 'utf8'));

describe('committed placeholder runtime config', () => {
  it('produces no configuration issues and stays non-transaction-capable', () => {
    const evaluation = validateRuntimeConfig({
      chains: readConfig('chains.json'),
      deployments: readConfig('deployments.json'),
      walletConnect: readConfig('walletconnect.json'),
      timing: readConfig('timing.json'),
    });

    expect(evaluation.issues).toEqual([]);
    expect(evaluation.state).toBe('not-configured');
    expect(evaluation.networkAccessAllowed).toBe(false);
    expect(evaluation.originProfile?.readCapable ?? false).toBe(false);
    expect(evaluation.venueProfiles.every((profile) => !profile.readCapable && !profile.writeCapable)).toBe(true);
  });
});
