import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { APP_HOST, APP_PORT, listen } from './serve.mjs';

const diagnosticsRoot = await mkdtemp(resolve(tmpdir(), 'intex-smoke-diagnostics-'));
const origin = `http://${APP_HOST}:${APP_PORT}`;
const server = await listen({ diagnosticsRoot });
try {
  const routeResponse = await fetch(`${origin}/auction/20260731`);
  const routeBody = await routeResponse.text();
  if (!routeResponse.ok || !routeBody.includes('<title>Intex Auction</title>')) {
    throw new Error('Direct SPA route did not return the production application.');
  }

  const configResponse = await fetch(`${origin}/config/chains.json`);
  const servedConfig = await configResponse.text();
  const committedConfig = await readFile(resolve(import.meta.dirname, '../../config/chains.json'), 'utf8');
  if (!configResponse.ok || servedConfig.trim() !== committedConfig.trim()) {
    throw new Error('Runtime configuration was not served from config/chains.json.');
  }

  const diagnostic = {
    schemaVersion: 1,
    at: '2026-08-17T17:45:00.000Z',
    category: 'app',
    event: 'started',
    version: 'smoke',
    commit: 'smoke',
    browser: 'smoke',
    path: '/auction/20260731',
  };
  const diagnosticsResponse = await fetch(`${origin}/__diagnostics/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(diagnostic),
  });
  if (diagnosticsResponse.status !== 204)
    throw new Error('Local diagnostics endpoint did not accept a sanitized event.');
  const journal = await readFile(resolve(diagnosticsRoot, 'intex-auction.jsonl'), 'utf8');
  if (journal.trim() !== JSON.stringify(diagnostic))
    throw new Error('Local diagnostics event was not persisted as JSONL.');

  console.log('HTTP smoke test passed for the fixed local origin, SPA fallback, and local diagnostics journal.');
} finally {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  await rm(diagnosticsRoot, { recursive: true, force: true });
}
