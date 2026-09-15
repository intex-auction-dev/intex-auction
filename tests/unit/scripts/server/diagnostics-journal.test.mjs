import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiagnosticsJournal } from '../../../../scripts/server/diagnostics-journal.mjs';
import { createStaticAppServer } from '../../../../scripts/server/serve.mjs';

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolvePromise) => {
          server.closeAllConnections?.();
          server.close(() => resolvePromise());
        }),
    ),
  );
});

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'intex-diagnostics-'));
  const distRoot = resolve(root, 'dist');
  const configRoot = resolve(root, 'config');
  const diagnosticsRoot = resolve(root, '.local/diagnostics');
  const contentSecurityPolicyPath = resolve(configRoot, 'content-security-policy.json');
  await mkdir(distRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await writeFile(resolve(distRoot, 'index.html'), '<title>Intex Auction</title>');
  await writeFile(resolve(configRoot, 'chains.json'), JSON.stringify({ chains: [] }));
  await writeFile(
    contentSecurityPolicyPath,
    JSON.stringify({
      schemaVersion: 1,
      directives: { 'default-src': ["'self'"], 'connect-src': ["'self'"] },
    }),
  );
  return { root, distRoot, configRoot, diagnosticsRoot, contentSecurityPolicyPath };
};

const validEvent = (overrides = {}) => ({
  schemaVersion: 1,
  at: '2026-08-17T17:20:00.000Z',
  category: 'rpc',
  event: 'selected',
  role: 'origin',
  profileId: 'outbe-mainnet',
  chainId: 999,
  endpoint: 'https://rpc.example.org',
  ...overrides,
});

const startServer = async (input) => {
  const server = await createStaticAppServer(input);
  servers.push(server);
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  return `http://127.0.0.1:${address.port}`;
};

const post = (origin, body, options = {}) =>
  fetch(`${origin}/__diagnostics/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...options.headers },
    body,
  });

describe('local diagnostics journal', () => {
  it('appends one compact JSON object per line', async () => {
    const { diagnosticsRoot } = await fixture();
    const journal = createDiagnosticsJournal({ diagnosticsRoot });
    await journal.append(validEvent());
    await journal.append(
      validEvent({ event: 'error', name: 'TimeoutError', message: 'RPC timed out', component: 'calendar:origin' }),
    );
    const lines = (await readFile(journal.path, 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      validEvent(),
      validEvent({ event: 'error', name: 'TimeoutError', message: 'RPC timed out', component: 'calendar:origin' }),
    ]);
  });

  it('rotates before append and keeps only the configured generations', async () => {
    const { diagnosticsRoot } = await fixture();
    const journal = createDiagnosticsJournal({ diagnosticsRoot, maxBytes: 256, rotatedFiles: 2 });
    for (let index = 0; index < 12; index += 1) await journal.append(validEvent({ profileId: `profile-${index}` }));
    expect(await readFile(journal.path, 'utf8')).toContain('profile-11');
    expect(await readFile(`${journal.path}.1`, 'utf8')).toMatch(/profile-(9|10)/);
    expect(await readFile(`${journal.path}.2`, 'utf8')).toMatch(/profile-(7|8|9)/);
    await expect(readFile(`${journal.path}.3`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('local diagnostics HTTP sink', () => {
  it('accepts a same-origin allowlisted event and persists it', async () => {
    const paths = await fixture();
    const origin = await startServer(paths);
    const response = await post(origin, JSON.stringify(validEvent()));
    expect(response.status).toBe(204);
    const journal = await readFile(resolve(paths.diagnosticsRoot, 'intex-auction.jsonl'), 'utf8');
    expect(JSON.parse(journal.trim())).toEqual(validEvent());
  });

  it('rejects cross-origin, unsupported media, malformed, oversized, unknown, and secret-shaped requests', async () => {
    const paths = await fixture();
    const origin = await startServer(paths);
    const crossOrigin = await fetch(`${origin}/__diagnostics/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(validEvent()),
    });
    expect(crossOrigin.status).toBe(403);
    expect((await post(origin, '{}', { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await post(origin, '{')).status).toBe(400);
    expect((await post(origin, JSON.stringify(validEvent({ signature: '0xsecret' })))).status).toBe(400);
    expect(
      (
        await post(
          origin,
          JSON.stringify({
            schemaVersion: 1,
            at: '2026-08-17T17:20:00.000Z',
            category: 'error',
            event: 'runtime',
            name: 'ProviderError',
            message: `wallet 0x${'ab'.repeat(20)}`,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          origin,
          JSON.stringify({
            schemaVersion: 1,
            at: '2026-08-17T17:20:00.000Z',
            category: 'error',
            event: 'runtime',
            name: 'WalletConnectError',
            message: 'wc:secret-topic@2?relay-protocol=irn',
          }),
        )
      ).status,
    ).toBe(400);
    expect((await post(origin, JSON.stringify(validEvent({ message: 'x'.repeat(17_000) })))).status).toBe(413);
  });

  it('rejects secret-shaped values in every generic string field while allowing typed hashes', async () => {
    const paths = await fixture();
    const origin = await startServer(paths);
    const signature = `0x${'ab'.repeat(65)}`;
    const address = `0x${'cd'.repeat(20)}`;
    const attacks = [
      validEvent({ component: signature }),
      validEvent({ profileId: 'wc:secret-topic@2?relay-protocol=irn&symKey=secret' }),
      {
        schemaVersion: 1,
        at: '2026-08-17T17:20:00.000Z',
        category: 'error',
        event: 'runtime',
        name: `Provider-${address}`,
        message: 'Provider failed.',
      },
      {
        schemaVersion: 1,
        at: '2026-08-17T17:20:00.000Z',
        category: 'error',
        event: 'runtime',
        component: 'https://user:secret@rpc.example.org/private/path?apiKey=secret',
        name: 'ProviderError',
        message: 'Provider failed.',
      },
    ];
    for (const event of attacks) {
      expect((await post(origin, JSON.stringify(event))).status).toBe(400);
    }

    const transactionHash = `0x${'ef'.repeat(32)}`;
    expect(
      (
        await post(
          origin,
          JSON.stringify({
            schemaVersion: 1,
            at: '2026-08-17T17:20:00.000Z',
            category: 'transaction',
            event: 'state',
            kind: 'commit',
            state: 'confirmed',
            transactionHash,
          }),
        )
      ).status,
    ).toBe(204);
  });

  it('never exposes diagnostics over GET', async () => {
    const paths = await fixture();
    const origin = await startServer(paths);
    const response = await fetch(`${origin}/__diagnostics/v1`);
    expect(response.status).toBe(405);
    expect(await response.text()).not.toContain('intex-auction.jsonl');
  });
});
