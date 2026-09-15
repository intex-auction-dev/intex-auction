import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const DEFAULT_DIAGNOSTICS_ROOT = resolve(root, '.local', 'diagnostics');
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ROTATED_FILES = 2;
export const DIAGNOSTICS_BODY_LIMIT_BYTES = 16 * 1024;
export const DIAGNOSTICS_PATH = '/__diagnostics/v1';

const schemas = new Map([
  ['app.started', new Set(['version', 'commit', 'browser', 'path'])],
  [
    'runtime.loaded',
    new Set([
      'originProfileId',
      'venueProfileId',
      'originDeploymentId',
      'venueDeploymentId',
      'originChainId',
      'venueChainId',
    ]),
  ],
  ['rpc.selected', new Set(['role', 'component', 'profileId', 'chainId', 'endpoint'])],
  [
    'rpc.error',
    new Set(['role', 'component', 'profileId', 'chainId', 'endpoint', 'operation', 'method', 'name', 'message']),
  ],
  [
    'chain.head',
    new Set(['role', 'profileId', 'chainId', 'blockNumber', 'blockHash', 'blockTimestamp', 'lastSuccessfulReadAt']),
  ],
  ['auction.context', new Set(['worldwideDay', 'stage', 'readState', 'cacheStatus', 'scanStatus'])],
  ['wallet.state', new Set(['providerType', 'chainId', 'venueProfileId', 'venueDeploymentId', 'connected'])],
  ['transaction.state', new Set(['kind', 'state', 'transactionHash'])],
  ['error.caught', new Set(['boundary', 'name', 'message'])],
  ['error.runtime', new Set(['component', 'operation', 'name', 'message'])],
]);

const commonFields = new Set(['schemaVersion', 'at', 'category', 'event']);
const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const ownObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max = 1_024) => typeof value === 'string' && value.length <= max;
const validTimestamp = (value) => boundedString(value, 64) && Number.isFinite(Date.parse(value));
const validHash = (value) => value === null || (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));

const originOnly = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const validSafePath = (value) =>
  value === undefined ||
  value === null ||
  (boundedString(value, 1_024) && value.startsWith('/') && !value.includes('?') && !value.includes('#'));

const safeDiagnosticString = (value) => {
  if (!boundedString(value, 1_024)) return false;
  if (/wc:[^\s"'<>]+/i.test(value) || /0x[0-9a-fA-F]{40,}/.test(value)) return false;
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    if (originOnly(match[0]) !== match[0]) return false;
  }
  return true;
};

export const validateDiagnosticEvent = (value) => {
  if (!ownObject(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    !validTimestamp(value.at) ||
    !boundedString(value.category, 32) ||
    !boundedString(value.event, 32)
  )
    return null;
  const eventFields = schemas.get(`${value.category}.${value.event}`);
  if (!eventFields) return null;
  const allowed = new Set([...commonFields, ...eventFields]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (Object.values(value).some((entry) => !scalar(entry))) return null;
  if (Object.values(value).some((entry) => typeof entry === 'string' && entry.length > 1_024)) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || key === 'transactionHash' || key === 'blockHash') continue;
    if (!safeDiagnosticString(entry)) return null;
  }
  if ('endpoint' in value && value.endpoint !== null && originOnly(value.endpoint) !== value.endpoint) return null;
  if ('path' in value && !validSafePath(value.path)) return null;
  if ('transactionHash' in value && !validHash(value.transactionHash)) return null;
  if ('blockHash' in value && !validHash(value.blockHash)) return null;
  for (const key of ['chainId', 'originChainId', 'venueChainId']) {
    if (key in value && value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  }
  for (const key of ['blockNumber', 'blockTimestamp']) {
    if (key in value && value[key] !== null && !/^(0|[1-9]\d*)$/.test(String(value[key]))) return null;
  }
  return value;
};

const missingFile = (error) => error && typeof error === 'object' && error.code === 'ENOENT';
const fileSize = async (path) => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (missingFile(error)) return 0;
    throw error;
  }
};
const renameIfPresent = async (from, to) => {
  try {
    await rename(from, to);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
};
const rotate = async (path, rotatedFiles) => {
  if (rotatedFiles <= 0) {
    await rm(path, { force: true });
    return;
  }
  await rm(`${path}.${rotatedFiles}`, { force: true });
  for (let index = rotatedFiles - 1; index >= 1; index -= 1)
    await renameIfPresent(`${path}.${index}`, `${path}.${index + 1}`);
  await renameIfPresent(path, `${path}.1`);
};

export const createDiagnosticsJournal = ({
  diagnosticsRoot = DEFAULT_DIAGNOSTICS_ROOT,
  maxBytes = DEFAULT_MAX_BYTES,
  rotatedFiles = DEFAULT_ROTATED_FILES,
} = {}) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Diagnostics maxBytes must be a positive integer.');
  if (!Number.isSafeInteger(rotatedFiles) || rotatedFiles < 0)
    throw new Error('Diagnostics rotatedFiles must be a non-negative integer.');
  const path = resolve(diagnosticsRoot, 'intex-auction.jsonl');
  let pending = Promise.resolve();
  const appendOne = async (event) => {
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(diagnosticsRoot, { recursive: true, mode: 0o700 });
    if ((await fileSize(path)) + Buffer.byteLength(line) > maxBytes) await rotate(path, rotatedFiles);
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  };
  return {
    path,
    append(event) {
      const operation = pending.then(() => appendOne(event));
      pending = operation.catch(() => {});
      return operation;
    },
  };
};

class BodyTooLargeError extends Error {}
const readBody = (request, limit) =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > limit) {
        failed = true;
        rejectPromise(new BodyTooLargeError('Diagnostics request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!failed) resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', rejectPromise);
  });
const send = (response, statusCode, headers, body = '') => {
  response.writeHead(statusCode, headers);
  response.end(body);
};

export const handleDiagnosticsRequest = async (request, response, journal, securityHeaders) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname !== DIAGNOSTICS_PATH) return false;
  if (request.method !== 'POST') {
    send(response, 405, { ...securityHeaders, Allow: 'POST' }, 'Method not allowed');
    return true;
  }
  const contentType = String(request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    send(response, 415, securityHeaders, 'Unsupported media type');
    return true;
  }
  const host = String(request.headers.host ?? '');
  const origin = request.headers.origin;
  if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) || (origin !== undefined && origin !== `http://${host}`)) {
    send(response, 403, securityHeaders, 'Forbidden');
    return true;
  }
  let body;
  try {
    body = await readBody(request, DIAGNOSTICS_BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      send(response, 413, securityHeaders, 'Payload too large');
      return true;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    send(response, 400, securityHeaders, 'Invalid diagnostics event');
    return true;
  }
  const event = validateDiagnosticEvent(parsed);
  if (!event) {
    send(response, 400, securityHeaders, 'Invalid diagnostics event');
    return true;
  }
  try {
    await journal.append(event);
  } catch (error) {
    console.error('Failed to persist local diagnostics.', error instanceof Error ? error.message : error);
    send(response, 503, securityHeaders, 'Diagnostics unavailable');
    return true;
  }
  send(response, 204, securityHeaders);
  return true;
};
