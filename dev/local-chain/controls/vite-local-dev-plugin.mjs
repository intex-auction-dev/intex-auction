import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { getAddress } from 'viem';

const execFileAsync = promisify(execFile);
const extraDevOrigins = (process.env.ITX_LOCAL_DEV_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const localDevOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', ...extraDevOrigins]);

export const isAllowedLocalDevOrigin = (origin) => !origin || localDevOrigins.has(origin);
export const normalizeLocalDevTesterAddress = (value) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Invalid tester wallet address.');
  try {
    return getAddress(value.trim());
  } catch {
    throw new Error('Invalid tester wallet address.');
  }
};

const readRequestJson = (request) =>
  new Promise((resolvePromise, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4_096) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON request.'));
      }
    });
    request.on('error', reject);
  });

export const createLocalDevControlsPlugin = ({ root, enabled }) => ({
  name: 'local-dev-controls',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const protectedPath =
        pathname === '/dev' ||
        pathname === '/dev/' ||
        pathname.startsWith('/dev/local-chain/controls/') ||
        pathname.startsWith('/__dev/');
      if (!enabled) {
        if (protectedPath) {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }
        next();
        return;
      }

      if (pathname === '/dev' || pathname === '/dev/') {
        request.url = '/dev/local-chain/controls/dev-controls.html';
        next();
        return;
      }
      if (pathname !== '/__dev/control') {
        next();
        return;
      }

      const origin = request.headers.origin;
      if (!isAllowedLocalDevOrigin(origin)) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'Invalid request origin.' }));
        return;
      }

      let command = 'status';
      let count;
      let address;
      try {
        if (request.method === 'POST') {
          const body = await readRequestJson(request);
          command = typeof body.command === 'string' ? body.command : 'status';
          count =
            typeof body.count === 'string' && body.count.trim()
              ? body.count.trim()
              : typeof body.count === 'number' && Number.isFinite(body.count)
                ? String(Math.floor(body.count))
                : undefined;
          if (body.address !== undefined) {
            if (command === 'preview') throw new Error('Tester wallet address is not accepted for preview.');
            address = normalizeLocalDevTesterAddress(body.address);
          }
        } else if (request.method !== 'GET') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, POST');
          response.end(JSON.stringify({ error: 'Method not allowed.' }));
          return;
        }
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            resolve(root, 'dev/local-chain/scripts/local/commands/local-control.mjs'),
            command,
            ...(count === undefined ? [] : [count]),
          ],
          {
            cwd: root,
            env: address === undefined ? process.env : { ...process.env, ITX_TESTER_WALLET_ADDRESS: address },
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(stdout);
      } catch (error) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        const message = error?.stderr?.trim() || error?.message || 'Local control command failed.';
        response.end(JSON.stringify({ error: message }));
      }
    });
  },
});
