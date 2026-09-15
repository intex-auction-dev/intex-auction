import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary, ErrorFallback, type ErrorBoundaryState } from '@/ui/error-boundary';

describe('error boundary presentation', () => {
  it('renders the assertive fallback with the surfaced message', () => {
    const markup = renderToStaticMarkup(
      <ErrorFallback
        title="Auction content could not be rendered"
        error={new Error('Eye is not defined')}
        onReload={() => undefined}
      />,
    );

    expect(markup).toContain('Auction content could not be rendered');
    expect(markup).toContain('Eye is not defined');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Reload application');
  });

  it('uses a readable message when no error details exist', () => {
    const markup = renderToStaticMarkup(
      <ErrorFallback title="Wallet controls could not be rendered" error={null} onReload={() => undefined} />,
    );

    expect(markup).toContain('An unexpected application error occurred.');
  });

  it('renders the full-page layout for the root fallback', () => {
    const markup = renderToStaticMarkup(
      <ErrorFallback
        title="Application could not be loaded"
        error={new Error('boom')}
        layout="full"
        onReload={() => undefined}
      />,
    );

    expect(markup).toContain('error-fallback error-fallback--full');
  });
});

describe('error boundary state derivation', () => {
  it('turns a thrown non-Error value into an Error message', () => {
    const state = ErrorBoundary.getDerivedStateFromError('boom') as { error: Error };
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error.message).toBe('boom');
  });

  it('keeps an already-thrown Error unwrapped', () => {
    const original = new Error('Eye is not defined');
    const state = ErrorBoundary.getDerivedStateFromError(original) as { error: Error };
    expect(state.error).toBe(original);
  });

  it('keeps the error while resetKey is unchanged and clears it when resetKey changes', () => {
    const propsA = { name: 'x', children: null, resetKey: 'a' };
    const errored: ErrorBoundaryState = { error: new Error('boom'), lastResetKey: 'a' };

    expect(ErrorBoundary.getDerivedStateFromProps(propsA, errored)).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps({ ...propsA, resetKey: 'b' }, errored)).toEqual({
      error: null,
      lastResetKey: 'b',
    });
  });

  it('does not auto-reset when resetKey is omitted', () => {
    const errored: ErrorBoundaryState = { error: new Error('boom'), lastResetKey: null };
    expect(ErrorBoundary.getDerivedStateFromProps({ name: 'x', children: null }, errored)).toBeNull();
  });
});

describe('error boundary component', () => {
  it('renders its children when no error occurred', () => {
    const markup = renderToStaticMarkup(
      <ErrorBoundary name="test" resetKey="a">
        <span>content</span>
      </ErrorBoundary>,
    );

    expect(markup).toContain('content');
  });
});
