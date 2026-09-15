// Build controls separately so production assets never contain development controls.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const controlsRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(controlsRoot, '../../..');

export default defineConfig({
  root: repositoryRoot,
  base: '/__dev-controls/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(repositoryRoot, 'src'),
    },
  },
  build: {
    outDir: resolve(repositoryRoot, 'dist-dev-controls'),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: { 'dev-controls': resolve(controlsRoot, 'dev-controls.html') },
    },
  },
});
