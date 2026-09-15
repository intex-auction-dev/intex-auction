import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell, Banner, Button, Card, InfoTip, Notice } from '@/ui/primitives';

describe('production presentation primitives', () => {
  it('renders the shell landmarks and assertive status semantics', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        contextLabel="Local bidder application"
        status={
          <Banner eyebrow="Startup blocked" icon="!" live="assertive" title="Configuration failed" tone="danger">
            <p>Reads and writes remain blocked.</p>
          </Banner>
        }
      >
        <Card aria-label="Phase 3 content">Content slot</Card>
      </AppShell>,
    );

    expect(markup).toContain('<header class="app-shell__header">');
    expect(markup).toContain('<main class="app-shell__main" id="main-content">');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-label="Phase 3 content"');
  });

  it('marks Portfolio as the active navigation destination', () => {
    const markup = renderToStaticMarkup(
      <AppShell activePage="portfolio" auctionHref="/auction/20260804" contextLabel="Local venue" />,
    );
    expect(markup).toContain('href="/auction/20260804"');
    expect(markup).toContain(
      'app-shell__nav-item app-shell__nav-item--active" href="#portfolio" aria-current="page">Portfolio',
    );
    expect(markup).not.toContain('href="/auction/20260804" aria-current="page"');
  });

  it('keeps tooltip help available to assistive technology', () => {
    const markup = renderToStaticMarkup(
      <InfoTip label="Auction timing help">Times use the selected display zone.</InfoTip>,
    );
    expect(markup).toContain('class="info-tip"');
    expect(markup).toContain('aria-label="Auction timing help"');
  });

  it('renders Button with all variants and sizes', () => {
    const markup = renderToStaticMarkup(
      <>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Disconnect</Button>
        <Button variant="ghost" size="icon" aria-label="Previous month">
          ←
        </Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
        <Button type="submit">Submit</Button>
      </>,
    );

    expect(markup).toContain('class="button button--default button--size-default"');
    expect(markup).toContain('class="button button--secondary button--size-default"');
    expect(markup).toContain('class="button button--outline button--size-default"');
    expect(markup).toContain('class="button button--ghost button--size-default"');
    expect(markup).toContain('class="button button--destructive button--size-default"');
    expect(markup).toContain('class="button button--ghost button--size-icon"');
    expect(markup).toContain('class="button button--default button--size-sm"');
    expect(markup).toContain('disabled');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('type="submit"');
  });

  it('renders Notice with tones and live region semantics', () => {
    const staticMarkup = renderToStaticMarkup(<Notice tone="warning">Persistent context.</Notice>);
    expect(staticMarkup).toContain('class="notice notice--warning"');
    expect(staticMarkup).not.toContain('role=');
    expect(staticMarkup).not.toContain('aria-live=');

    const politeMarkup = renderToStaticMarkup(
      <Notice tone="info" live="polite">
        Updated context.
      </Notice>,
    );
    expect(politeMarkup).toContain('class="notice notice--info"');
    expect(politeMarkup).toContain('role="status"');
    expect(politeMarkup).toContain('aria-live="polite"');

    const assertiveMarkup = renderToStaticMarkup(
      <Notice tone="danger" live="assertive">
        Read failed.
      </Notice>,
    );
    expect(assertiveMarkup).toContain('class="notice notice--danger"');
    expect(assertiveMarkup).toContain('role="alert"');
    expect(assertiveMarkup).toContain('aria-live="assertive"');
  });
});
