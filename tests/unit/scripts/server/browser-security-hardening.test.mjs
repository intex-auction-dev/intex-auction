import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listen } from '../../../../scripts/server/serve.mjs';

const root = resolve(import.meta.dirname, '../../../..');

const closeServer = async (server) => {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
};

describe('production browser security boundary', () => {
  it('keeps fonts local and the committed CSP narrowly allowlisted', async () => {
    const [html, main, tokens, policyText] = await Promise.all([
      readFile(resolve(root, 'index.html'), 'utf8'),
      readFile(resolve(root, 'src/main.tsx'), 'utf8'),
      readFile(resolve(root, 'src/ui/tokens.css'), 'utf8'),
      readFile(resolve(root, 'config/content-security-policy.json'), 'utf8'),
    ]);
    const policy = JSON.parse(policyText).directives;

    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(main).toContain("import '@fontsource-variable/geist';");
    expect(tokens).toMatch(/--font-sans:\s*['"]Geist Variable['"]/);
    expect(tokens).toMatch(/--font-mono:\s*['"]Geist Variable['"]/);

    expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(policy['font-src']).toEqual(["'self'"]);
    expect(policy['connect-src']).toEqual([
      "'self'",
      '@configured-rpc-origins',
      'https://verify.walletconnect.com',
      'https://verify.walletconnect.org',
      'wss://relay.walletconnect.org',
    ]);
    expect(policy['frame-src']).toEqual(['https://verify.walletconnect.org']);

    const serialized = JSON.stringify(policy);
    expect(serialized).not.toContain('fonts.googleapis.com');
    expect(serialized).not.toContain('fonts.gstatic.com');
    expect(serialized).not.toContain('fonts.reown.com');
    expect(serialized).not.toContain('api.web3modal.org');
    expect(serialized).not.toContain('rpc.walletconnect.org');
    expect(serialized).not.toContain('*.walletconnect');
    expect(serialized).not.toContain('*.web3modal');
    expect(serialized).not.toContain('*.reown');
    expect(serialized).not.toContain('pulse.walletconnect.org');
    expect(serialized).not.toContain('echo.walletconnect.com');
  });

  it('serves the effective hardened CSP and local font MIME type from the production server', async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'intex-browser-security-'));
    const distRoot = resolve(fixtureRoot, 'dist');
    const configRoot = resolve(fixtureRoot, 'config');
    await mkdir(distRoot);
    await mkdir(configRoot);
    await writeFile(resolve(distRoot, 'index.html'), '<!doctype html><title>Intex Auction</title>');
    await writeFile(resolve(distRoot, 'font.woff2'), 'font-fixture');
    await writeFile(
      resolve(configRoot, 'chains.json'),
      JSON.stringify({
        schemaVersion: 1,
        chains: [{ enabled: true, rpcUrls: ['https://rpc.example.test/private'] }],
      }),
    );

    const server = await listen({
      distRoot,
      configRoot,
      contentSecurityPolicyPath: resolve(root, 'config/content-security-policy.json'),
      port: 0,
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${origin}/`);
      const effectivePolicy = response.headers.get('content-security-policy') ?? '';

      expect(effectivePolicy).toContain("font-src 'self'");
      expect(effectivePolicy).toContain("img-src 'self' data: blob:");
      expect(effectivePolicy).toContain('https://rpc.example.test');
      expect(effectivePolicy).toContain('https://verify.walletconnect.org');
      expect(effectivePolicy).toContain('wss://relay.walletconnect.org');
      expect(effectivePolicy).not.toContain('@configured-rpc-origins');
      expect(effectivePolicy).not.toContain('fonts.googleapis.com');
      expect(effectivePolicy).not.toContain('fonts.gstatic.com');
      expect(effectivePolicy).not.toContain('api.web3modal.org');
      expect(effectivePolicy).not.toContain('rpc.walletconnect.org');
      expect(effectivePolicy).not.toContain('*.walletconnect');
      expect(effectivePolicy).not.toContain('pulse.walletconnect.org');
    } finally {
      await closeServer(server);
    }
  });
});
