import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStaticAppServer } from '../../../../scripts/server/serve.mjs';
import { packageRelease, verifyReleasePackage } from '../../../../scripts/release/release-package.mjs';

const hostSource = resolve(import.meta.dirname, '../../../../scripts/server/static-host.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const tarEntries = async (archivePath) => {
  const archive = gunzipSync(await readFile(archivePath));
  const names = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
};

// Extract with the platform tar, so the hand-written USTAR headers are judged by a real reader.
const extractArchive = async (archivePath) => {
  const target = await mkdtemp(resolve(tmpdir(), 'intex-unpacked-'));
  execFileSync('tar', ['-xzf', archivePath, '-C', target]);
  return target;
};

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const releaseFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'intex-release-'));
  const commit = 'a'.repeat(40);
  await Promise.all([
    mkdir(resolve(root, 'dist/assets'), { recursive: true }),
    mkdir(resolve(root, 'config/abi'), { recursive: true }),
    mkdir(resolve(root, 'scripts/server'), { recursive: true }),
  ]);
  await Promise.all([
    cp(hostSource, resolve(root, 'scripts/server/static-host.mjs')),
    writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'intex-auction',
        version: '1.2.3',
        engines: { node: '>=24 <25', npm: '11.6.2' },
      }),
    ),
    writeFile(resolve(root, 'README.md'), '# Intex Auction\n'),
    writeFile(resolve(root, 'dist/index.html'), '<!doctype html><div id="root"></div>'),
    writeFile(resolve(root, 'dist/assets/app.js'), `window.intex={version:'1.2.3',commit:'${commit}'};`),
    writeJson(resolve(root, 'config/chains.json'), { schemaVersion: 1, chains: [] }),
    writeJson(resolve(root, 'config/deployments.json'), {
      schemaVersion: 1,
      deployments: [{ adapterProfile: 'multi-issuance-usd-reference', enabled: false }],
    }),
    writeJson(resolve(root, 'config/timing.json'), { schemaVersion: 1, bidsFanInTimeoutSeconds: 43200 }),
    writeJson(resolve(root, 'config/walletconnect.json'), {
      schemaVersion: 1,
      enabled: false,
      projectId: '',
      metadata: {},
    }),
    writeJson(resolve(root, 'config/content-security-policy.json'), {
      schemaVersion: 1,
      directives: { 'default-src': ["'self'"] },
    }),
    writeJson(resolve(root, 'config/abi/IntexAuction.json'), []),
    writeFile(resolve(root, 'config/README.md'), 'Development source guidance only.\n'),
  ]);
  return { root, commit };
};

const closeServer = async (server) => {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(resolvePromise));
};

describe('production release package', () => {
  it('creates a deterministic, self-verifying static artifact from the explicit allowlist', async () => {
    const { root, commit } = await releaseFixture();
    const first = await packageRelease({ root, outputRoot: resolve(root, '.release-one'), commit, tag: 'v1.2.3' });
    const second = await packageRelease({ root, outputRoot: resolve(root, '.release-two'), commit, tag: 'v1.2.3' });

    await expect(
      verifyReleasePackage({ root, artifactRoot: first.outputRoot, commit, tag: 'v1.2.3' }),
    ).resolves.toBeUndefined();
    expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath));

    const archiveEntries = await tarEntries(first.archivePath);
    expect(archiveEntries).toEqual(
      expect.arrayContaining([
        'intex-auction-1.2.3/README.md',
        'intex-auction-1.2.3/RELEASE.json',
        'intex-auction-1.2.3/FILES.sha256',
        'intex-auction-1.2.3/dist/index.html',
        'intex-auction-1.2.3/dist/assets/app.js',
        'intex-auction-1.2.3/static-host.mjs',
        'intex-auction-1.2.3/config/chains.json',
        'intex-auction-1.2.3/config/timing.json',
        'intex-auction-1.2.3/config/abi/IntexAuction.json',
      ]),
    );
    expect(
      archiveEntries.some(
        (entry) =>
          entry.includes('/.vite/') ||
          entry.includes('/src/') ||
          entry.includes('/scripts/') ||
          entry.includes('/dev/'),
      ),
    ).toBe(false);

    const release = JSON.parse(await readFile(resolve(first.stagingRoot, 'RELEASE.json'), 'utf8'));
    expect(release).toMatchObject({
      applicationVersion: '1.2.3',
      gitCommit: commit,
      tag: 'v1.2.3',
      transactionCapableProfiles: false,
      runtimeConfigSchemaVersions: { chains: 1, deployments: 1, timing: 1, walletconnect: 1 },
    });
    // Only pinned toolchain facts may live in the checksummed payload; a floating one (the exact Node
    // patch version) makes the published archive impossible to reproduce independently.
    expect(Object.keys(release).sort()).toEqual([
      'applicationVersion',
      'gitCommit',
      'nodeMajor',
      'npmVersion',
      'reviewedContractProfiles',
      'reviewedContractSources',
      'runtimeConfigSchemaVersions',
      'tag',
      'transactionCapableProfiles',
    ]);
    expect(await readFile(first.checksumPath, 'utf8')).toBe(
      `${sha256(await readFile(first.archivePath))}  ${first.archiveName}\n`,
    );
  });

  it('rejects development-control markers before they can enter the artifact', async () => {
    const { root, commit } = await releaseFixture();
    await writeFile(resolve(root, 'dist/assets/app.js'), "window.control='/__dev/control';");

    await expect(
      packageRelease({ root, outputRoot: resolve(root, '.release'), commit, tag: 'v1.2.3' }),
    ).rejects.toThrow('development control');
  });

  it('rejects development-control markers in active CSS', async () => {
    const { root, commit } = await releaseFixture();
    await writeFile(resolve(root, 'dist/assets/app.css'), ".control::after { content: '/__dev/control'; }");

    await expect(
      packageRelease({ root, outputRoot: resolve(root, '.release'), commit, tag: 'v1.2.3' }),
    ).rejects.toThrow('development control');
  });

  it('loads the staged application and editable runtime config through a conforming static host', async () => {
    const { root, commit } = await releaseFixture();
    const result = await packageRelease({ root, outputRoot: resolve(root, '.release'), commit, tag: 'v1.2.3' });
    const server = await createStaticAppServer({
      distRoot: resolve(result.stagingRoot, 'dist'),
      configRoot: resolve(result.stagingRoot, 'config'),
      contentSecurityPolicyPath: resolve(result.stagingRoot, 'config/content-security-policy.json'),
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
      const origin = `http://127.0.0.1:${address.port}`;
      const app = await fetch(`${origin}/auction/20260101`);
      const config = await fetch(`${origin}/config/chains.json`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain('id="root"');
      expect(config.headers.get('cache-control')).toBe('no-store');
      expect(await config.json()).toEqual({ schemaVersion: 1, chains: [] });
    } finally {
      await closeServer(server);
    }
  });

  it('serves an unpacked archive through its own staged host', async () => {
    const { root, commit } = await releaseFixture();
    const { archivePath } = await packageRelease({
      root,
      outputRoot: resolve(root, '.release'),
      commit,
      tag: 'v1.2.3',
    });
    const unpacked = resolve(await extractArchive(archivePath), 'intex-auction-1.2.3');
    const { createStaticAppServer: createReleasedHost } = await import(resolve(unpacked, 'static-host.mjs'));
    const server = await createReleasedHost({
      distRoot: resolve(unpacked, 'dist'),
      configRoot: resolve(unpacked, 'config'),
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    try {
      const { port } = server.address();
      const app = await fetch(`http://127.0.0.1:${port}/auction/20260101`);
      const config = await fetch(`http://127.0.0.1:${port}/config/chains.json`);
      const missing = await fetch(`http://127.0.0.1:${port}/config/absent.json`);
      expect(app.status).toBe(200);
      expect(await app.text()).toContain('id="root"');
      expect(config.status).toBe(200);
      expect(config.headers.get('cache-control')).toBe('no-store');
      expect(await config.json()).toEqual({ schemaVersion: 1, chains: [] });
      expect(missing.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('packages asset paths longer than a single USTAR name field', async () => {
    const { root, commit } = await releaseFixture();
    const longName = `${'nested-asset-name-'.repeat(4)}entry.js`;
    await writeFile(resolve(root, 'dist/assets', longName), 'export const long = true;\n');
    const staged = `intex-auction-1.2.3/dist/assets/${longName}`;
    expect(staged.length).toBeGreaterThan(100);

    const result = await packageRelease({ root, outputRoot: resolve(root, '.release'), commit, tag: 'v1.2.3' });
    expect(await tarEntries(result.archivePath)).toContain(staged);
    await expect(
      verifyReleasePackage({ root, artifactRoot: result.outputRoot, commit, tag: 'v1.2.3' }),
    ).resolves.toBeUndefined();

    const unpacked = await extractArchive(result.archivePath);
    expect(await readFile(resolve(unpacked, staged), 'utf8')).toBe('export const long = true;\n');
    await rm(unpacked, { recursive: true, force: true });
  });
});
