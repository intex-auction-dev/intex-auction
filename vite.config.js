import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createLocalDevControlsPlugin } from './dev/local-chain/controls/vite-local-dev-plugin.mjs';
import { createDiagnosticsJournal, handleDiagnosticsRequest } from './scripts/server/diagnostics-journal.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const configRoot = resolve(root, process.env.ITX_RUNTIME_CONFIG_DIR ?? 'config');
const devFsAllow = (() => {
  const roots = [root];
  try {
    const realNodeModules = realpathSync(resolve(root, 'node_modules'));
    if (realNodeModules !== resolve(root, 'node_modules')) roots.push(realNodeModules);
  } catch {}
  return roots;
})();
const localDevEnabled = process.env.ITX_LOCAL_DEV === '1';
const packageDocument = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const appVersion = typeof packageDocument.version === 'string' ? packageDocument.version : 'unknown';
const appCommit =
  process.env.ITX_APP_COMMIT ??
  (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();

const runtimeConfigPlugin = () => ({
  name: 'runtime-config-files',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (!pathname.startsWith('/config/')) {
        next();
        return;
      }

      let relativePath;
      try {
        relativePath = decodeURIComponent(pathname.slice('/config/'.length));
      } catch {
        response.statusCode = 400;
        response.end('Invalid configuration path');
        return;
      }

      const filePath = resolve(configRoot, relativePath);
      if (!filePath.startsWith(`${configRoot}${sep}`) || !filePath.endsWith('.json')) {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }

      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
          throw new Error('Not a file');
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        createReadStream(filePath).pipe(response);
      } catch {
        response.statusCode = 404;
        response.end('Not found');
      }
    });
  },
});

// The application emits diagnostics only in development builds, so the development server has to
// accept them. Without this sink every page load logs one failed request per event, and the local
// journal that exists to explain local failures stays empty.
const diagnosticsPlugin = () => ({
  name: 'local-diagnostics-sink',
  // Development server only. A plugin present during a production build changes rolldown's chunk
  // hashing even when it contributes no code, which would move asset filenames for no reason.
  apply: 'serve',
  configureServer(server) {
    const journal = createDiagnosticsJournal({});
    server.middlewares.use(async (request, response, next) => {
      try {
        if (await handleDiagnosticsRequest(request, response, journal, {})) return;
      } catch {
        // Diagnostics are advisory and must never break the development server.
      }
      next();
    });
  },
});

export default defineConfig({
  root,
  base: '/',
  define: {
    __ITX_APP_VERSION__: JSON.stringify(appVersion),
    __ITX_APP_COMMIT__: JSON.stringify(appCommit),
  },
  plugins: [
    react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
    tailwindcss(),
    runtimeConfigPlugin(),
    diagnosticsPlugin(),
    createLocalDevControlsPlugin({ root, enabled: localDevEnabled }),
  ],
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: devFsAllow },
    ...(localDevEnabled && process.env.ITX_LOCAL_DEV_HMR_CLIENT_PORT
      ? {
          hmr: {
            protocol: process.env.ITX_LOCAL_DEV_HMR_PROTOCOL ?? 'wss',
            ...(process.env.ITX_LOCAL_DEV_HMR_HOST ? { host: process.env.ITX_LOCAL_DEV_HMR_HOST } : {}),
            clientPort: Number(process.env.ITX_LOCAL_DEV_HMR_CLIENT_PORT),
          },
        }
      : {}),
  },
});
