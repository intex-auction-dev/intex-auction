import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveLocalWalletConnect } from '../../../../../dev/local-chain/scripts/local/infrastructure/config.mjs';
import { validateRuntimeConfig } from '@/runtime-config/runtime-config';

const DEV_ORIGIN = 'http://127.0.0.1:5173';
const readConfig = (name) => JSON.parse(readFileSync(resolve('config', name), 'utf8'));

// A minimal chains/deployments/timing set is irrelevant to WalletConnect usability, so validate the
// generated walletconnect document against its own dev origin in isolation.
const usableAt = (walletConnect, applicationOrigin) =>
  validateRuntimeConfig({ chains: {}, deployments: {}, walletConnect, timing: {} }, new Map(), applicationOrigin)
    .walletConnect;

describe('local WalletConnect config generation', () => {
  it('rebinds metadata.url to the dev browser origin', () => {
    const derived = deriveLocalWalletConnect(readConfig('walletconnect.json'), DEV_ORIGIN);
    expect(derived.metadata.url).toBe(DEV_ORIGIN);
  });

  it('produces a usable WalletConnect config at the dev origin when the committed config enables it', () => {
    const committed = readConfig('walletconnect.json');
    // The committed config is expected to be enabled with a real project ID for client builds.
    expect(committed.enabled).toBe(true);
    expect(typeof committed.projectId).toBe('string');
    expect(committed.projectId.length).toBeGreaterThan(0);

    const derived = deriveLocalWalletConnect(committed, DEV_ORIGIN);
    const evaluation = usableAt(derived, DEV_ORIGIN);

    expect(evaluation.issues).toEqual([]);
    expect(evaluation.usable).toBe(true);
    expect(evaluation.projectId).toBe(committed.projectId);
  });

  it('regression: the committed :4173 metadata.url is NOT usable at the :5173 dev origin', () => {
    // This is the exact bug the fix addresses: copying the committed url verbatim leaves
    // metadata.url === :4173 while the dev browser origin is :5173, so validation rejects it.
    const committed = readConfig('walletconnect.json');
    const withCommittedUrl = {
      ...deriveLocalWalletConnect(committed, DEV_ORIGIN),
      metadata: { ...deriveLocalWalletConnect(committed, DEV_ORIGIN).metadata, url: 'http://127.0.0.1:4173' },
    };
    const evaluation = usableAt(withCommittedUrl, DEV_ORIGIN);
    expect(evaluation.usable).toBe(false);
    expect(evaluation.issues.map((issue) => issue.code)).toContain('incomplete-walletconnect-metadata');
  });

  it('disables and clears the project ID when the committed config is disabled', () => {
    const derived = deriveLocalWalletConnect(
      { schemaVersion: 1, enabled: false, projectId: 'should-not-leak', metadata: { url: 'http://127.0.0.1:4173' } },
      DEV_ORIGIN,
    );
    expect(derived.enabled).toBe(false);
    expect(derived.projectId).toBe('');
    expect(derived.metadata.url).toBe(DEV_ORIGIN);
  });
});
