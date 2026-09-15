import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(root, 'dist/.vite/manifest.json');
const assetsDirectory = resolve(root, 'dist/assets');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const manifestText = JSON.stringify(manifest);

if (manifestText.includes('dev/local-chain/controls/app/') || manifestText.includes('dev-controls.html')) {
  throw new Error('Production manifest contains local development controls.');
}

const assetFiles = await readdir(assetsDirectory);
for (const assetFile of assetFiles.filter((file) => file.endsWith('.js'))) {
  const source = await readFile(resolve(assetsDirectory, assetFile), 'utf8');
  if (
    source.includes('Demo Controls') ||
    source.includes('Metadosis lifecycle controls') ||
    source.includes('Auction control panel') ||
    source.includes('/__dev/control')
  ) {
    throw new Error(`Local development control behavior leaked into production asset ${assetFile}.`);
  }
}

const activeFontSources = [
  await readFile(resolve(root, 'dist/index.html'), 'utf8'),
  ...(await Promise.all(
    assetFiles.filter((file) => file.endsWith('.css')).map((file) => readFile(resolve(assetsDirectory, file), 'utf8')),
  )),
].join('\n');
for (const remoteFontOrigin of ['fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.reown.com']) {
  if (activeFontSources.includes(remoteFontOrigin)) {
    throw new Error(`Production HTML/CSS contains remote font origin ${remoteFontOrigin}.`);
  }
}
if (!assetFiles.some((file) => file.endsWith('.woff2'))) {
  throw new Error('Production bundle does not contain bundled font assets.');
}

console.log('Production bundle excludes local development controls and uses only local active font assets.');
