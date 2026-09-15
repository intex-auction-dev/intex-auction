import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { basename, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const REQUIRED_CONFIG_FILES = [
  'chains.json',
  'deployments.json',
  'timing.json',
  'walletconnect.json',
  'content-security-policy.json',
];
const DEV_CONTROL_MARKERS = [
  'dev/local-chain/controls/app',
  'dev-controls.html',
  '/__dev/control',
  '/__diagnostics/',
  'Demo Controls',
  'Metadosis lifecycle controls',
  'Auction control panel',
];
const REMOTE_ACTIVE_ASSETS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.reown.com'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

// The archive ships the same static host `npm start` uses, so an unpacked release runs with
// `node static-host.mjs`. It must stay self-contained: a relative import would drag development
// source into the released artifact.
const STAGED_HOST = 'static-host.mjs';
const HOST_SOURCE = 'scripts/server/static-host.mjs';

const assertNoDevelopmentMarkers = (label, source) => {
  if (DEV_CONTROL_MARKERS.some((marker) => source.includes(marker)))
    throw new Error(`${label} contains development control behavior.`);
};

const validateStagedHost = async (stagingRoot) => {
  const source = await readFile(resolve(stagingRoot, STAGED_HOST), 'utf8');
  assertNoDevelopmentMarkers('Release host', source);
  if (/\bfrom\s+'\.{1,2}\//.test(source))
    throw new Error(`Release host ${STAGED_HOST} must not import development source.`);
};

const walkFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Release artifact contains unsupported filesystem entry: ${path}`);
  }
  return files;
};

const relativePosix = (base, path) => relative(base, path).split(sep).join('/');
const required = async (path, label) => {
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Missing required release ${label}: ${path}`);
  }
};

const npmVersion = (pinned) => {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== pinned) throw new Error(`Release packaging requires the pinned npm ${pinned}, found ${version}.`);
  return version;
};

const gitCommit = (workingRoot) => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingRoot, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Release packaging requires an exact git commit via ITX_RELEASE_COMMIT or git.');
  }
};

const validateSourceDist = async (distRoot) => {
  await required(resolve(distRoot, 'index.html'), 'dist/index.html');
  const assetsRoot = resolve(distRoot, 'assets');
  try {
    if (!(await stat(assetsRoot)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('Missing required release dist/assets directory.');
  }

  const assetFiles = await walkFiles(assetsRoot);
  const htmlSource = await readFile(resolve(distRoot, 'index.html'), 'utf8');
  const [scriptAndStyleSources, cssSources] = await Promise.all([
    Promise.all(
      assetFiles.filter((file) => file.endsWith('.js') || file.endsWith('.css')).map((file) => readFile(file, 'utf8')),
    ),
    Promise.all(assetFiles.filter((file) => file.endsWith('.css')).map((file) => readFile(file, 'utf8'))),
  ]);
  assertNoDevelopmentMarkers('Production bundle', [htmlSource, ...scriptAndStyleSources].join('\n'));
  const activeAssetSources = [htmlSource, ...cssSources].join('\n');
  for (const origin of REMOTE_ACTIVE_ASSETS) {
    if (activeAssetSources.includes(origin))
      throw new Error(`Production HTML/CSS contains remote asset origin ${origin}.`);
  }
};

const packageMetadata = async ({ workingRoot, version, commit, tag, pinnedNpm }) => {
  const [chains, deployments, timing, walletConnect] = await Promise.all(
    ['chains.json', 'deployments.json', 'timing.json', 'walletconnect.json'].map((file) =>
      readJson(resolve(workingRoot, 'config', file)),
    ),
  );
  const profiles = Array.isArray(deployments.deployments)
    ? [
        ...new Set(
          deployments.deployments
            .map((deployment) => deployment?.adapterProfile)
            .filter((profile) => typeof profile === 'string'),
        ),
      ]
    : [];
  const reviewedContractSources = Array.isArray(deployments.deployments)
    ? [
        ...new Set(
          deployments.deployments
            .map((deployment) => deployment?.reviewedSourceCommit)
            .filter((source) => typeof source === 'string'),
        ),
      ]
    : [];
  const transactionCapableProfiles = Boolean(
    (Array.isArray(chains.chains) && chains.chains.some((chain) => chain?.enabled === true)) ||
      (Array.isArray(deployments.deployments) &&
        deployments.deployments.some((deployment) => deployment?.enabled === true)),
  );

  return {
    applicationVersion: version,
    gitCommit: commit,
    tag: tag ?? null,
    // Only pinned toolchain facts belong in the checksummed payload: the exact runner patch version
    // floats, and recording it here would make the archive impossible to reproduce independently.
    nodeMajor: Number(process.versions.node.split('.')[0]),
    npmVersion: npmVersion(pinnedNpm),
    runtimeConfigSchemaVersions: {
      chains: chains.schemaVersion,
      deployments: deployments.schemaVersion,
      timing: timing.schemaVersion,
      walletconnect: walletConnect.schemaVersion,
    },
    reviewedContractProfiles: profiles,
    reviewedContractSources,
    transactionCapableProfiles,
  };
};

const writeManifest = async (stagingRoot) => {
  const files = (await walkFiles(stagingRoot))
    .filter((file) => basename(file) !== 'FILES.sha256')
    .sort((left, right) => relativePosix(stagingRoot, left).localeCompare(relativePosix(stagingRoot, right)));
  const entries = await Promise.all(
    files.map(async (file) => `${sha256(await readFile(file))}  ${relativePosix(stagingRoot, file)}`),
  );
  await writeFile(resolve(stagingRoot, 'FILES.sha256'), `${entries.join('\n')}\n`);
};

const writeString = (buffer, offset, length, value) => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`Archive entry is too long: ${value}`);
  bytes.copy(buffer, offset);
};

const writeOctal = (buffer, offset, length, value) => {
  const text = value.toString(8).padStart(length - 1, '0');
  writeString(buffer, offset, length, `${text}\0`);
};

// USTAR stores a path as an optional 155-byte prefix plus a 100-byte name, joined by '/'. Splitting
// on a separator raises the ceiling from 100 to 255 bytes without PAX extension records.
const splitEntryName = (path) => {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Archive entry is too long: ${path}`);
};

const tarEntry = (path, content) => {
  const { name, prefix } = splitEntryName(path);
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeString(header, 345, 155, prefix);
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
};

// The tar payload is fully deterministic: sorted entries, fixed mode and owner, zero mtimes. The gzip
// container is only reproducible on the same bundled zlib, so the archive hash can differ across Node
// patch versions while every packaged file stays identical, which is why FILES.sha256 is published
// beside SHA256SUMS. Making the archive hash itself reproducible needs an exact Node patch pin in CI
// or an uncompressed tar.
const createDeterministicArchive = async ({ stagingRoot, archivePath }) => {
  const archiveRoot = basename(stagingRoot);
  const files = (await walkFiles(stagingRoot)).sort();
  const entries = await Promise.all(
    files.map(async (file) => tarEntry(`${archiveRoot}/${relativePosix(stagingRoot, file)}`, await readFile(file))),
  );
  await writeFile(archivePath, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]), { level: 9, mtime: 0 }));
};

const assertExpectedStagedPath = (path) => {
  if (path === 'README.md' || path === 'RELEASE.json' || path === 'FILES.sha256' || path === STAGED_HOST) return;
  if (path === 'dist/index.html' || path.startsWith('dist/assets/')) return;
  if (REQUIRED_CONFIG_FILES.some((file) => path === `config/${file}`) || path.startsWith('config/abi/')) return;
  throw new Error(`Release artifact contains non-allowlisted path: ${path}`);
};

const verifyManifest = async (stagingRoot) => {
  const manifestPath = resolve(stagingRoot, 'FILES.sha256');
  await required(manifestPath, 'FILES.sha256');
  const entries = (await readFile(manifestPath, 'utf8')).trim().split('\n').filter(Boolean);
  const seen = new Set();
  for (const entry of entries) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(entry);
    if (!match) throw new Error(`Invalid checksum entry: ${entry}`);
    const [, checksum, path] = match;
    if (seen.has(path) || path === 'FILES.sha256') throw new Error(`Duplicate or recursive checksum entry: ${path}`);
    seen.add(path);
    assertExpectedStagedPath(path);
    const content = await readFile(resolve(stagingRoot, path));
    if (sha256(content) !== checksum) throw new Error(`Internal checksum mismatch for ${path}.`);
  }
  const stagedFiles = await walkFiles(stagingRoot);
  for (const file of stagedFiles) {
    const path = relativePosix(stagingRoot, file);
    assertExpectedStagedPath(path);
    if (path !== 'FILES.sha256' && !seen.has(path)) throw new Error(`Missing internal checksum for ${path}.`);
  }
};

const verifyArchiveContents = async ({ archivePath, stagingRoot }) => {
  const expected = (await walkFiles(stagingRoot))
    .map((file) => `${basename(stagingRoot)}/${relativePosix(stagingRoot, file)}`)
    .sort();
  const archive = gunzipSync(await readFile(archivePath));
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    if (!name || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Release archive has an invalid USTAR entry.');
    entries.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error('Release archive entries do not match the staged allowlist.');
  }
};

const assertMetadata = async ({ workingRoot, stagingRoot, commit, tag }) => {
  const packageDocument = await readJson(resolve(workingRoot, 'package.json'));
  const release = await readJson(resolve(stagingRoot, 'RELEASE.json'));
  if (release.applicationVersion !== packageDocument.version)
    throw new Error('RELEASE.json application version mismatch.');
  if (commit && release.gitCommit !== commit) throw new Error('RELEASE.json git commit mismatch.');
  if (tag !== undefined && release.tag !== tag) throw new Error('RELEASE.json tag mismatch.');
  const sources = [
    await readFile(resolve(stagingRoot, 'dist/index.html'), 'utf8'),
    ...(await Promise.all(
      (
        await walkFiles(resolve(stagingRoot, 'dist/assets'))
      )
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFile(file, 'utf8')),
    )),
  ].join('\n');
  if (!sources.includes(release.applicationVersion))
    throw new Error('Bundled application version does not match RELEASE.json.');
  if (!sources.includes(release.gitCommit)) throw new Error('Bundled application commit does not match RELEASE.json.');
};

export const verifyReleasePackage = async ({ root: workingRoot = root, artifactRoot, commit, tag }) => {
  const stagingRoots = (await readdir(artifactRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('intex-auction-'),
  );
  if (stagingRoots.length !== 1)
    throw new Error('Release output must contain exactly one staged application directory.');
  const stagingRoot = resolve(artifactRoot, stagingRoots[0].name);
  for (const file of ['README.md', 'RELEASE.json', 'FILES.sha256', 'dist/index.html', STAGED_HOST]) {
    await required(resolve(stagingRoot, file), file);
  }
  for (const configFile of REQUIRED_CONFIG_FILES)
    await required(resolve(stagingRoot, 'config', configFile), `config/${configFile}`);
  await validateSourceDist(resolve(stagingRoot, 'dist'));
  await validateStagedHost(stagingRoot);
  await verifyManifest(stagingRoot);
  await assertMetadata({ workingRoot, stagingRoot, commit, tag });

  const archiveName = `${basename(stagingRoot)}.tar.gz`;
  const archivePath = resolve(artifactRoot, archiveName);
  await required(archivePath, archiveName);
  const checksumPath = resolve(artifactRoot, 'SHA256SUMS');
  await required(checksumPath, 'SHA256SUMS');
  const expectedChecksum = `${sha256(await readFile(archivePath))}  ${archiveName}\n`;
  if ((await readFile(checksumPath, 'utf8')) !== expectedChecksum)
    throw new Error('External archive checksum mismatch.');
  await verifyArchiveContents({ archivePath, stagingRoot });
};

export const packageRelease = async ({
  root: workingRoot = root,
  outputRoot = resolve(workingRoot, '.release'),
  // No GITHUB_SHA fallback: it is the ref a workflow run started from, which is not necessarily the
  // checked-out source. An explicit override or the checkout's own HEAD are the only honest answers.
  commit = process.env.ITX_RELEASE_COMMIT ?? gitCommit(workingRoot),
  tag = process.env.ITX_RELEASE_TAG,
} = {}) => {
  const packageDocument = await readJson(resolve(workingRoot, 'package.json'));
  if (typeof packageDocument.version !== 'string' || !packageDocument.version)
    throw new Error('package.json must provide an application version.');
  if (!/^\d+\.\d+\.\d+$/.test(packageDocument.engines?.npm ?? ''))
    throw new Error('package.json engines.npm must pin an exact npm version.');
  if (!/^[0-9a-f]{40}$/i.test(commit))
    throw new Error('Release packaging requires a full 40-character git commit SHA.');

  const version = packageDocument.version;
  const stagingRoot = resolve(outputRoot, `intex-auction-${version}`);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await validateSourceDist(resolve(workingRoot, 'dist'));
  await mkdir(resolve(stagingRoot, 'dist'), { recursive: true });
  await mkdir(resolve(stagingRoot, 'config'), { recursive: true });
  await Promise.all([
    cp(resolve(workingRoot, 'dist/index.html'), resolve(stagingRoot, 'dist/index.html'), { force: true }),
    cp(resolve(workingRoot, 'dist/assets'), resolve(stagingRoot, 'dist/assets'), { recursive: true, force: true }),
    ...REQUIRED_CONFIG_FILES.map((file) =>
      cp(resolve(workingRoot, 'config', file), resolve(stagingRoot, 'config', file), { force: true }),
    ),
    cp(resolve(workingRoot, 'config/abi'), resolve(stagingRoot, 'config/abi'), { recursive: true, force: true }),
    cp(resolve(workingRoot, 'README.md'), resolve(stagingRoot, 'README.md'), { force: true }),
    cp(resolve(workingRoot, HOST_SOURCE), resolve(stagingRoot, STAGED_HOST), { force: true }),
  ]);
  await rm(resolve(stagingRoot, 'dist/.vite'), { recursive: true, force: true });
  for (const configFile of REQUIRED_CONFIG_FILES)
    await required(resolve(stagingRoot, 'config', configFile), `config/${configFile}`);
  await validateStagedHost(stagingRoot);
  await writeFile(
    resolve(stagingRoot, 'RELEASE.json'),
    `${JSON.stringify(
      await packageMetadata({ workingRoot, version, commit, tag, pinnedNpm: packageDocument.engines?.npm }),
      null,
      2,
    )}\n`,
  );
  await writeManifest(stagingRoot);

  const archiveName = `intex-auction-${version}.tar.gz`;
  const archivePath = resolve(outputRoot, archiveName);
  await createDeterministicArchive({ stagingRoot, archivePath });
  const checksumPath = resolve(outputRoot, 'SHA256SUMS');
  await writeFile(checksumPath, `${sha256(await readFile(archivePath))}  ${archiveName}\n`);
  await verifyReleasePackage({ root: workingRoot, artifactRoot: outputRoot, commit, tag });
  return { outputRoot, stagingRoot, archiveName, archivePath, checksumPath };
};

if (isDirectExecution) {
  const commit = process.env.ITX_RELEASE_COMMIT ?? gitCommit(root);
  const tag = process.env.ITX_RELEASE_TAG;
  if (process.argv.includes('--verify')) {
    await verifyReleasePackage({ root, artifactRoot: resolve(root, '.release'), commit, tag });
    console.log('Release package verification passed.');
  } else {
    const result = await packageRelease({ commit, tag });
    console.log(`Release package verified: ${result.archivePath}`);
  }
}
