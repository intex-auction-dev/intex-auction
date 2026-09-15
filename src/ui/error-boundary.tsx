import { Component, type ErrorInfo, type ReactNode } from 'react';
import { diagnosticError, emitDiagnostic } from '../diagnostics/local-diagnostics';
import { friendlyErrorMessage } from '../chain/contract-errors';
import { Banner, Button } from './primitives';
import './ui.css';

declare global {
  var __ITX_ERROR_BOUNDARY_TEST_CRASH__: string | undefined;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  name: string;
  layout?: 'full' | 'inline';
  resetKey?: string;
  title?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

export interface ErrorBoundaryState {
  error: Error | null;
  lastResetKey: string | null;
}

export const errorMessage = (error: unknown): string => friendlyErrorMessage(error);

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(errorMessage(error)));

export function ErrorFallback({
  error,
  layout = 'inline',
  onReload,
  title,
}: {
  error: Error | null;
  layout?: 'full' | 'inline';
  onReload: () => void;
  title: string;
}) {
  const banner = (
    <Banner eyebrow="Something went wrong" icon="!" live="assertive" title={title} tone="danger">
      <p>{error ? errorMessage(error) : 'An unexpected application error occurred.'}</p>
      <Button className="error-fallback__reload" onClick={onReload}>
        Reload application
      </Button>
    </Banner>
  );
  return layout === 'full' ? (
    <main className="error-fallback error-fallback--full">{banner}</main>
  ) : (
    <div className="error-fallback">{banner}</div>
  );
}

// The test seam is development-only and excluded from production builds.
function CrashProbe({ name }: { name: string }) {
  if (import.meta.env.DEV && globalThis.__ITX_ERROR_BOUNDARY_TEST_CRASH__ === name) {
    throw new Error(`Injected render crash for the ${name} error-boundary check.`);
  }
  return null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (state.error !== null && props.resetKey !== undefined && props.resetKey !== state.lastResetKey) {
      return { error: null, lastResetKey: props.resetKey };
    }
    return null;
  }

  state: ErrorBoundaryState = { error: null, lastResetKey: this.props.resetKey ?? null };

  componentDidCatch(error: Error, info: ErrorInfo) {
    emitDiagnostic({
      category: 'error',
      event: 'caught',
      boundary: this.props.name,
      ...diagnosticError(error),
    });
    console.error(`[error-boundary:${this.props.name}]`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private renderFallback(error: Error): ReactNode {
    const { fallback, layout, title } = this.props;
    if (fallback) return fallback(error, this.reset);
    return (
      <ErrorFallback
        error={error}
        layout={layout ?? 'inline'}
        onReload={() => globalThis.location.reload()}
        title={title ?? `${this.props.name} could not be rendered`}
      />
    );
  }

  render(): ReactNode {
    if (this.state.error !== null) return this.renderFallback(this.state.error);
    return (
      <>
        <CrashProbe name={this.props.name} />
        {this.props.children}
      </>
    );
  }

  private readonly reset = (): void => {
    this.setState({ error: null, lastResetKey: this.props.resetKey ?? null });
  };
}
