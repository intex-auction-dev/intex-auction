import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReviewedRuntime } from '@/runtime-config/load-reviewed-runtime-config';
import { App } from '@/app/App';

const browserSupport = { supported: true, missingCapabilities: [] as string[] };

describe('viewport gate', () => {
  it('allows 600px-wide viewports and keeps the blocker copy aligned', () => {
    const markup = renderToStaticMarkup(<App browserSupport={browserSupport} state={{ kind: 'loading-runtime' }} />);
    const css = readFileSync(new URL('../../../../src/app/app.css', import.meta.url), 'utf8');

    expect(markup).toContain('The supported minimum viewport is 600 × 720 pixels.');
    expect(css).toContain('@media (max-width: 599px), (max-height: 719px)');
    expect(css).not.toContain('@media (max-width: 1279px), (max-height: 719px)');
  });

  it('uses the FadeArc instead of the runtime configuration banner during startup', () => {
    const markup = renderToStaticMarkup(<App browserSupport={browserSupport} state={{ kind: 'loading-runtime' }} />);

    expect(markup).toContain('auction-loading-state__arc');
    expect(markup).toContain('Loading application');
    expect(markup).not.toContain('Loading runtime configuration');
  });

  it('renders auction loading with the FadeArc below the fixed header', () => {
    const markup = renderToStaticMarkup(
      <App browserSupport={browserSupport} state={{ kind: 'loading-auction', runtime: {} as ReviewedRuntime }} />,
    );

    expect(markup).toContain('auction-loading-state__arc');
    expect(markup).toContain('Loading auction');
    expect(markup).not.toContain('Loading auction evidence');
  });
});
