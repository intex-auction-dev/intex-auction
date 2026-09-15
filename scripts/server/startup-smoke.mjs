import { APP_HOST, APP_PORT } from './serve.mjs';
import { startApplication } from './start.mjs';

const server = await startApplication();
try {
  const response = await fetch(`http://${APP_HOST}:${APP_PORT}/auction/20260731`);
  const body = await response.text();
  if (!response.ok || !body.includes('<title>Intex Auction</title>')) {
    throw new Error('npm start workflow did not serve the production SPA.');
  }

  const csp = response.headers.get('content-security-policy') ?? '';
  for (const required of [
    "script-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    'https://verify.walletconnect.org',
    'wss://relay.walletconnect.org',
  ]) {
    if (!csp.includes(required)) throw new Error(`npm start CSP is missing ${required}.`);
  }
  for (const forbidden of [
    '@configured-rpc-origins',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'fonts.reown.com',
    'api.web3modal.org',
    'rpc.walletconnect.org',
    '*.walletconnect',
    '*.web3modal',
    '*.reown',
    'pulse.walletconnect.org',
    'echo.walletconnect.com',
  ]) {
    if (csp.includes(forbidden)) throw new Error(`npm start CSP unexpectedly permits ${forbidden}.`);
  }
  if (body.includes('fonts.googleapis.com') || body.includes('fonts.gstatic.com')) {
    throw new Error('npm start production HTML contains a Google Fonts dependency.');
  }

  console.log('Startup smoke passed through the production build/server with the hardened CSP.');
} finally {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
