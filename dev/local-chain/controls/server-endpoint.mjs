// Enable this unauthenticated endpoint only for disposable development chains; optionally require ITX_DEV_CONTROLS_TOKEN.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

export const DEV_CONTROLS_ENABLED = process.env.ITX_DEV_CONTROLS === '1';
export const DEV_CONTROLS_PATH = '/__dev/control';
export const DEV_CONTROLS_PAGE_PATHS = new Set(['/dev', '/dev/']);
export const DEV_CONTROLS_ASSET_PREFIX = '/__dev-controls/';
const DEV_CONTROLS_TOKEN = process.env.ITX_DEV_CONTROLS_TOKEN?.trim() || null;
const BODY_LIMIT_BYTES = 4 * 1024;
const COMMAND_TIMEOUT_MS = 240_000;

export const DEV_CONTROL_COMMANDS = new Set([
  'status',
  'preview',
  'reset',
  'fund',
  'seed-bid',
  'seed-bids',
  'reveal',
  'clearing',
  'complete-sale',
  'no-sale',
  'red-day',
  'past-auctions',
  'advance-bond',
  'claim-bond',
  'advance-abandoned-bond',
  'claim-abandoned-bond',
  'advance-refund',
  'claim-refund',
  'qualify',
  'call',
  'oracle-defaults',
  'oracle-up',
  'oracle-usd-up',
  'oracle-try-up',
  'oracle-eur-up',
  'oracle-stale',
  'oracle-try-inactive',
  'oracle-available',
  'oracle-unavailable',
  'oracle-walk-start',
  'oracle-walk-stop',
]);

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const readBody = (request) =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT_BYTES) {
        rejectPromise(new Error('Control request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectPromise);
  });

const sendJson = (response, statusCode, securityHeaders, payload) => {
  response.writeHead(statusCode, {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

export const parseControlRequest = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body === '' ? '{}' : body);
  } catch {
    throw new Error('Invalid JSON request.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid JSON request.');
  }
  const command = parsed.command === undefined ? 'status' : parsed.command;
  if (typeof command !== 'string' || !DEV_CONTROL_COMMANDS.has(command)) {
    throw new Error('Unknown local control command.');
  }
  let count;
  if (parsed.count !== undefined && parsed.count !== null) {
    const candidate = typeof parsed.count === 'string' ? Number(parsed.count.trim()) : parsed.count;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 1_000) {
      throw new Error('Control count must be a number between 0 and 1000.');
    }
    count = String(Math.floor(candidate));
  }
  let address;
  if (parsed.address !== undefined && parsed.address !== null) {
    if (command === 'preview') throw new Error('Tester wallet address is not accepted for preview.');
    if (typeof parsed.address !== 'string' || !ADDRESS_PATTERN.test(parsed.address.trim())) {
      throw new Error('Invalid tester wallet address.');
    }
    address = parsed.address.trim();
  }
  return { command, count, address };
};

let pending = Promise.resolve();
const serialize = (task) => {
  const result = pending.then(task, task);
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const handleDevControlRequest = async (request, response, securityHeaders, allowedOrigins) => {
  if (!DEV_CONTROLS_ENABLED) return false;
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname !== DEV_CONTROLS_PATH) return false;
  if (request.method !== 'POST') {
    response.writeHead(405, { ...securityHeaders, Allow: 'POST' });
    response.end('Method not allowed');
    return true;
  }

  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    sendJson(response, 403, securityHeaders, { error: 'Invalid request origin.' });
    return true;
  }
  if (DEV_CONTROLS_TOKEN !== null && request.headers['x-dev-controls-token'] !== DEV_CONTROLS_TOKEN) {
    sendJson(response, 401, securityHeaders, { error: 'Development controls require a token.' });
    return true;
  }

  let parsed;
  try {
    parsed = parseControlRequest(await readBody(request));
  } catch (error) {
    sendJson(response, 400, securityHeaders, { error: error instanceof Error ? error.message : 'Invalid request.' });
    return true;
  }

  try {
    const stdout = await serialize(async () => {
      const { stdout: output } = await execFileAsync(
        process.execPath,
        [
          resolve(root, 'dev/local-chain/scripts/local/commands/local-control.mjs'),
          parsed.command,
          ...(parsed.count === undefined ? [] : [parsed.count]),
        ],
        {
          cwd: root,
          env:
            parsed.address === undefined ? process.env : { ...process.env, ITX_TESTER_WALLET_ADDRESS: parsed.address },
          maxBuffer: 4 * 1024 * 1024,
          timeout: COMMAND_TIMEOUT_MS,
          shell: false,
        },
      );
      return output;
    });
    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(stdout);
  } catch (error) {
    const message = error?.stderr?.toString().trim() || error?.message || 'Local control command failed.';
    sendJson(response, 400, securityHeaders, { error: message });
  }
  return true;
};
