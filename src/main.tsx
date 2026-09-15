import '@fontsource-variable/geist';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ErrorBoundary } from './ui/error-boundary';
import { evaluateBrowserSupport } from './app/runtime-gates';
import { PublicDiscoveryController } from './app/public-discovery-controller';
import { Toaster } from './ui/toast';
import { applyTheme, resolveTheme } from './domain/theme';
import { emitDiagnostic } from './diagnostics/local-diagnostics';

declare const __ITX_APP_VERSION__: string;
declare const __ITX_APP_COMMIT__: string;

if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
  const prototype = BigInt.prototype as unknown as { toJSON?: () => string };
  if (!prototype.toJSON) {
    Object.defineProperty(prototype, 'toJSON', {
      configurable: true,
      value(this: bigint) {
        return this.toString();
      },
    });
  }
}

applyTheme(resolveTheme());

// The released bundle carries its own identity: release packaging verifies it against RELEASE.json,
// and it stays readable on any host, unlike the development-only diagnostics journal below.
const build = { version: __ITX_APP_VERSION__, commit: __ITX_APP_COMMIT__ };
(globalThis as { __ITX_BUILD__?: typeof build }).__ITX_BUILD__ = build;

emitDiagnostic({
  category: 'app',
  event: 'started',
  ...build,
  browser: globalThis.navigator.userAgent,
  path: globalThis.location.pathname,
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root application mount point.');

createRoot(rootElement).render(
  <ErrorBoundary name="Application" layout="full" title="Application could not be loaded">
    <PublicDiscoveryController browserSupport={evaluateBrowserSupport(globalThis)} />
    <Toaster />
  </ErrorBoundary>,
);
