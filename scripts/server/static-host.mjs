// Static host for the prebuilt application: serves dist/ at the origin root, the editable runtime
// configuration under /config/*.json, and the documented security headers. It is the same host
// `npm start` uses and the one staged into the release archive, so an unpacked release runs with
// `node static-host.mjs` from the unpacked directory and needs nothing but Node.
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_HOST = '127.0.0.1';
const appPortText = process.env.ITX_APP_PORT ?? '4173';
if (!/^\d+$/.test(appPortText) || Number(appPortText) < 1 || Number(appPortText) > 65_535) {
  throw new Error('ITX_APP_PORT must be an integer between 1 and 65535.');
}
export const APP_PORT = Number(appPortText);

const CONFIGURED_RPC_ORIGINS = '@configured-rpc-origins';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const readConfiguredRpcOrigins = async (configRoot) => {
  const config = await readJson(resolve(configRoot, 'chains.json'));
  if (!config || typeof config !== 'object' || !Array.isArray(config.chains)) return [];

  const origins = new Set();
  for (const chain of config.chains) {
    if (!chain || typeof chain !== 'object' || chain.enabled !== true || !Array.isArray(chain.rpcUrls)) continue;
    for (const rpcUrl of chain.rpcUrls) {
      if (typeof rpcUrl !== 'string') continue;
      try {
        const parsed = new URL(rpcUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin);
      } catch {}
    }
  }
  return [...origins];
};

const buildContentSecurityPolicy = async ({ configRoot, contentSecurityPolicyPath }) => {
  const policy = await readJson(contentSecurityPolicyPath);
  if (
    !policy ||
    typeof policy !== 'object' ||
    policy.schemaVersion !== 1 ||
    !policy.directives ||
    typeof policy.directives !== 'object' ||
    Array.isArray(policy.directives)
  ) {
    throw new Error(`Invalid Content Security Policy configuration: ${contentSecurityPolicyPath}`);
  }

  const rpcOrigins = await readConfiguredRpcOrigins(configRoot);
  const directives = [];
  for (const [directive, sources] of Object.entries(policy.directives)) {
    if (!/^[a-z][a-z-]*$/.test(directive) || !Array.isArray(sources) || sources.length === 0) {
      throw new Error(`Invalid Content Security Policy directive: ${directive}`);
    }

    const expandedSources = [];
    for (const source of sources) {
      if (typeof source !== 'string' || source.length === 0 || /[;\r\n]/.test(source)) {
        throw new Error(`Invalid Content Security Policy source in ${directive}`);
      }
      if (source === CONFIGURED_RPC_ORIGINS) {
        if (directive !== 'connect-src') throw new Error(`${CONFIGURED_RPC_ORIGINS} is only valid in connect-src`);
        expandedSources.push(...rpcOrigins);
      } else {
        expandedSources.push(source);
      }
    }
    directives.push(`${directive} ${[...new Set(expandedSources)].join(' ')}`);
  }
  return `${directives.join('; ')};`;
};

export const buildSecurityHeaders = async ({ configRoot, contentSecurityPolicyPath }) => ({
  'Content-Security-Policy': await buildContentSecurityPolicy({ configRoot, contentSecurityPolicyPath }),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const inside = (rootPath, candidate) => candidate === rootPath || candidate.startsWith(`${rootPath}${sep}`);

export const safePath = (rootPath, pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(rootPath, `.${decoded}`);
  return inside(rootPath, candidate) ? candidate : null;
};

export const existingFile = async (filePath) => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
};

export const sendFile = async (request, response, filePath, cacheControl, securityHeaders) => {
  const fileStat = await stat(filePath);
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': MIME_TYPES.get(extname(filePath)) ?? 'application/octet-stream',
    'Content-Length': fileStat.size,
    'Cache-Control': cacheControl,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
};

// `beforeStatic` lets a development checkout layer extra routes (diagnostics, /dev controls) on top
// of the released behaviour without those routes existing in the released archive at all.
export const createStaticAppServer = async ({
  distRoot,
  configRoot,
  contentSecurityPolicyPath = resolve(configRoot, 'content-security-policy.json'),
  beforeStatic,
} = {}) => {
  const securityHeaders = await buildSecurityHeaders({ configRoot, contentSecurityPolicyPath });

  return createServer(async (request, response) => {
    try {
      if (beforeStatic && (await beforeStatic(request, response, securityHeaders))) return;

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' });
        response.end('Method not allowed');
        return;
      }

      const pathname = new URL(request.url ?? '/', `http://${APP_HOST}`).pathname;
      if (pathname.startsWith('/config/')) {
        const configPath = safePath(configRoot, pathname.slice('/config'.length));
        if (!configPath || extname(configPath) !== '.json' || !(await existingFile(configPath))) {
          response.writeHead(404, securityHeaders);
          response.end('Not found');
          return;
        }
        await sendFile(request, response, configPath, 'no-store', securityHeaders);
        return;
      }

      const assetPath = safePath(distRoot, pathname);
      if (assetPath && (await existingFile(assetPath))) {
        const immutable = pathname.startsWith('/assets/');
        await sendFile(
          request,
          response,
          assetPath,
          immutable ? 'public, max-age=31536000, immutable' : 'no-store',
          securityHeaders,
        );
        return;
      }

      const indexPath = resolve(distRoot, 'index.html');
      if (!(await existingFile(indexPath))) {
        response.writeHead(503, securityHeaders);
        response.end('Production build not found. Run npm run build.');
        return;
      }
      await sendFile(request, response, indexPath, 'no-store', securityHeaders);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500, securityHeaders);
      response.end('Internal server error');
    }
  });
};

export const listen = async ({ host = APP_HOST, port = APP_PORT, distRoot, configRoot, ...rest } = {}) => {
  await access(resolve(distRoot, 'index.html'));
  const server = await createStaticAppServer({ distRoot, configRoot, ...rest });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  return server;
};

export const assertPortAvailable = async ({ host = APP_HOST, port = APP_PORT } = {}) => {
  const probe = createServer();
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = (error) => {
        probe.off('listening', onListening);
        rejectPromise(error);
      };
      const onListening = () => {
        probe.off('error', onError);
        resolvePromise();
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(port, host);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
      throw new Error(`Cannot start Intex Auction: http://${host}:${port} is already in use.`);
    }
    throw error;
  } finally {
    if (probe.listening) await new Promise((resolvePromise) => probe.close(() => resolvePromise()));
  }
};

// Run directly to serve an unpacked release archive, or a source checkout after `npm run build`:
// both have dist/ and config/ in the working directory.
const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectExecution) {
  try {
    const server = await listen({ distRoot: resolve('dist'), configRoot: resolve('config') });
    console.log(`Intex Auction is available at http://${APP_HOST}:${APP_PORT}`);
    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      console.error('Run this from the directory that contains dist/ and config/.');
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  }
}
