import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPortAvailable, listen } from '../../../../scripts/server/serve.mjs';

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'intex-server-'));
  const distRoot = resolve(root, 'dist');
  const configRoot = resolve(root, 'config');
  const contentSecurityPolicyPath = resolve(root, 'content-security-policy.json');
  await mkdir(distRoot);
  await mkdir(configRoot);
  await writeFile(`${distRoot}/index.html`, '<!doctype html><title>Intex Auction</title><div id="root"></div>');
  await writeFile(
    `${configRoot}/chains.json`,
    JSON.stringify({
      schemaVersion: 1,
      chains: [
        { enabled: true, rpcUrls: ['https://rpc.example.test/project/123', 'http://127.0.0.1:8545'] },
        { enabled: false, rpcUrls: ['https://disabled.example.test'] },
      ],
    }),
  );
  await writeFile(
    contentSecurityPolicyPath,
    JSON.stringify({
      schemaVersion: 1,
      directives: {
        'default-src': ["'self'"],
        'connect-src': ["'self'", '@configured-rpc-origins', 'https://*.walletconnect.org'],
      },
    }),
  );
  return { distRoot, configRoot, contentSecurityPolicyPath };
};

const addressOf = (server) => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return address;
};

describe('static application server', () => {
  it('accepts an isolated application port', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import('./scripts/server/serve.mjs').then(({ APP_PORT }) => console.log(APP_PORT))",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ITX_APP_PORT: '14173' },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('14173');
  });

  it('serves direct routes through the production SPA fallback', async () => {
    const paths = await fixture();
    const server = await listen({ ...paths, port: 0 });
    try {
      const { port } = addressOf(server);
      const response = await fetch(`http://127.0.0.1:${port}/auction/20260731`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<title>Intex Auction</title>');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('serves runtime JSON separately with no-store caching', async () => {
    const paths = await fixture();
    const server = await listen({ ...paths, port: 0 });
    try {
      const { port } = addressOf(server);
      const response = await fetch(`http://127.0.0.1:${port}/config/chains.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        chains: [
          { enabled: true, rpcUrls: ['https://rpc.example.test/project/123', 'http://127.0.0.1:8545'] },
          { enabled: false, rpcUrls: ['https://disabled.example.test'] },
        ],
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('builds connect-src from the centralized policy and enabled RPC origins', async () => {
    const paths = await fixture();
    const server = await listen({ ...paths, port: 0 });
    try {
      const { port } = addressOf(server);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const policy = response.headers.get('content-security-policy');

      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain('connect-src');
      expect(policy).toContain('https://rpc.example.test');
      expect(policy).toContain('http://127.0.0.1:8545');
      expect(policy).toContain('https://*.walletconnect.org');
      expect(policy).not.toContain('https://disabled.example.test');
      expect(policy).not.toContain('@configured-rpc-origins');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('fails clearly when the selected port is occupied', async () => {
    const blocker = createServer();
    await new Promise((resolvePromise) => blocker.listen(0, '127.0.0.1', resolvePromise));
    const { port } = addressOf(blocker);

    try {
      await expect(assertPortAvailable({ port })).rejects.toThrow(`http://127.0.0.1:${port} is already in use`);
    } finally {
      await new Promise((resolvePromise) => blocker.close(() => resolvePromise()));
    }
  });
});
