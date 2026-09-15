import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEV_CONTROLS_ENABLED,
  DEV_CONTROL_COMMANDS,
  parseControlRequest,
} from '../../../../dev/local-chain/controls/server-endpoint.mjs';
import { listen } from '../../../../scripts/server/serve.mjs';

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'intex-dev-controls-'));
  const distRoot = resolve(root, 'dist');
  const configRoot = resolve(root, 'config');
  const contentSecurityPolicyPath = resolve(root, 'content-security-policy.json');
  await mkdir(distRoot);
  await mkdir(configRoot);
  await writeFile(`${distRoot}/index.html`, '<!doctype html><title>Intex Auction</title>');
  await writeFile(`${configRoot}/chains.json`, JSON.stringify({ schemaVersion: 1, chains: [] }));
  await writeFile(
    contentSecurityPolicyPath,
    JSON.stringify({
      schemaVersion: 1,
      directives: { 'default-src': ["'self'"], 'connect-src': ["'self'", '@configured-rpc-origins'] },
    }),
  );
  return { distRoot, configRoot, contentSecurityPolicyPath };
};

const addressOf = (server) => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return address;
};

describe('development controls endpoint', () => {
  it('stays disabled unless ITX_DEV_CONTROLS is set to 1', () => {
    expect(DEV_CONTROLS_ENABLED).toBe(false);

    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import('./dev/local-chain/controls/server-endpoint.mjs').then(({ DEV_CONTROLS_ENABLED }) => console.log(DEV_CONTROLS_ENABLED))",
      ],
      { cwd: process.cwd(), env: { ...process.env, ITX_DEV_CONTROLS: '1' }, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('serves the application fallback for /dev while disabled', async () => {
    const paths = await fixture();
    const server = await listen({ ...paths, port: 0 });
    try {
      const { port } = addressOf(server);
      const page = await fetch(`http://127.0.0.1:${port}/dev`);
      const control = await fetch(`http://127.0.0.1:${port}/__dev/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'status' }),
      });

      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>Intex Auction</title>');
      expect(control.status).toBe(405);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('defaults to the status command', () => {
    expect(parseControlRequest('')).toEqual({ command: 'status', count: undefined, address: undefined });
    expect(parseControlRequest('{}').command).toBe('status');
  });

  it('accepts the committed command allowlist only', () => {
    expect(DEV_CONTROL_COMMANDS.has('reset')).toBe(true);
    expect(parseControlRequest(JSON.stringify({ command: 'seed-bids', count: 7 }))).toEqual({
      command: 'seed-bids',
      count: '7',
      address: undefined,
    });
    expect(() => parseControlRequest(JSON.stringify({ command: 'restart-anvil' }))).toThrow(
      'Unknown local control command.',
    );
    expect(() => parseControlRequest(JSON.stringify({ command: 'status; rm -rf /' }))).toThrow(
      'Unknown local control command.',
    );
  });

  it('rejects malformed counts and addresses', () => {
    expect(() => parseControlRequest(JSON.stringify({ command: 'seed-bids', count: -1 }))).toThrow(
      'Control count must be a number between 0 and 1000.',
    );
    expect(() => parseControlRequest(JSON.stringify({ command: 'seed-bids', count: 5000 }))).toThrow(
      'Control count must be a number between 0 and 1000.',
    );
    expect(() => parseControlRequest(JSON.stringify({ command: 'fund', address: 'not-an-address' }))).toThrow(
      'Invalid tester wallet address.',
    );
    expect(() => parseControlRequest(JSON.stringify({ command: 'preview', address: `0x${'a'.repeat(40)}` }))).toThrow(
      'Tester wallet address is not accepted for preview.',
    );
    expect(parseControlRequest(JSON.stringify({ command: 'fund', address: `0x${'a'.repeat(40)}` })).address).toBe(
      `0x${'a'.repeat(40)}`,
    );
  });

  it('rejects malformed request bodies', () => {
    expect(() => parseControlRequest('{')).toThrow('Invalid JSON request.');
    expect(() => parseControlRequest('[]')).toThrow('Invalid JSON request.');
  });
});
