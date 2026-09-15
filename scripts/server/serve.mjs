// Development-checkout entry point: the released static host plus the routes that exist only in a
// source checkout (local diagnostics sink and the /dev control surface). The released archive stages
// static-host.mjs alone, so none of this can reach an operator's host.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEV_CONTROLS_ASSET_PREFIX,
  DEV_CONTROLS_ENABLED,
  DEV_CONTROLS_PAGE_PATHS,
  handleDevControlRequest,
} from '../../dev/local-chain/controls/server-endpoint.mjs';
import { createDiagnosticsJournal, handleDiagnosticsRequest } from './diagnostics-journal.mjs';
import {
  APP_HOST,
  APP_PORT,
  assertPortAvailable,
  createStaticAppServer as createHost,
  existingFile,
  listen as listenHost,
  safePath,
  sendFile,
} from './static-host.mjs';

export { APP_HOST, APP_PORT, assertPortAvailable };

const root = resolve(import.meta.dirname, '../..');
const defaultDistRoot = resolve(root, 'dist');
const committedConfigRoot = resolve(root, 'config');
const defaultConfigRoot = resolve(root, process.env.ITX_RUNTIME_CONFIG_DIR ?? 'config');
const resolveContentSecurityPolicyPath = (configRoot) => {
  const candidate = resolve(configRoot, 'content-security-policy.json');
  return existsSync(candidate) ? candidate : resolve(committedConfigRoot, 'content-security-policy.json');
};
const defaultDevControlsRoot = resolve(root, 'dist-dev-controls');
const defaultApplicationOrigins = [`http://${APP_HOST}:${APP_PORT}`, `http://localhost:${APP_PORT}`];

const developmentRoutes = ({ devControlsRoot, applicationOrigins, diagnosticsRoot }) => {
  const diagnosticsJournal = createDiagnosticsJournal({ diagnosticsRoot });
  const allowedOrigins = new Set(applicationOrigins);

  return async (request, response, securityHeaders) => {
    if (await handleDiagnosticsRequest(request, response, diagnosticsJournal, securityHeaders)) return true;
    if (await handleDevControlRequest(request, response, securityHeaders, allowedOrigins)) return true;
    if (!DEV_CONTROLS_ENABLED) return false;
    // Non-GET verbs stay with the host's 405 handling, as they did before the control surface existed.
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const pathname = new URL(request.url ?? '/', `http://${APP_HOST}`).pathname;
    const isPage = DEV_CONTROLS_PAGE_PATHS.has(pathname);
    if (!isPage && !pathname.startsWith(DEV_CONTROLS_ASSET_PREFIX)) return false;

    const devPath = isPage
      ? resolve(devControlsRoot, 'dev/local-chain/controls/dev-controls.html')
      : safePath(devControlsRoot, pathname.slice(DEV_CONTROLS_ASSET_PREFIX.length - 1));
    if (!devPath || !(await existingFile(devPath))) {
      response.writeHead(503, securityHeaders);
      response.end('Development controls build not found. Run npm run build:dev-controls.');
      return true;
    }
    await sendFile(request, response, devPath, 'no-store', securityHeaders);
    return true;
  };
};

const hostOptions = ({
  distRoot = defaultDistRoot,
  configRoot = defaultConfigRoot,
  contentSecurityPolicyPath = resolveContentSecurityPolicyPath(configRoot),
  devControlsRoot = defaultDevControlsRoot,
  applicationOrigins = defaultApplicationOrigins,
  diagnosticsRoot,
  ...rest
} = {}) => ({
  ...rest,
  distRoot,
  configRoot,
  contentSecurityPolicyPath,
  beforeStatic: developmentRoutes({ devControlsRoot, applicationOrigins, diagnosticsRoot }),
});

export const createStaticAppServer = async (options = {}) => createHost(hostOptions(options));

export const listen = async (options = {}) => listenHost(hostOptions(options));

const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectExecution) {
  try {
    const server = await listen();
    console.log(`Intex Auction is available at http://${APP_HOST}:${APP_PORT}`);
    const close = () => server.close(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
      console.error(`Cannot start Intex Auction: http://${APP_HOST}:${APP_PORT} is already in use.`);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  }
}
