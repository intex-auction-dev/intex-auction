import { useEffect, useState, type ReactNode } from 'react';
import type { BrowserSupportResult } from './runtime-gates';
import type { AuctionRouteResult } from '../discovery/auction-route';
import type { PublicAuctionRead } from '../discovery/load-public-auction';
import type { CalendarRangeRead } from '../discovery/calendar-evidence';
import type { WorldwideDayCalendarMonth, WorldwideDayKey, WorldwideDayMonth } from '../domain/protocol-time';
import { PublicDiscoveryView, type OraclePriceSectionProps } from '../discovery/public-discovery-view';
import type { VenueLadderViewState } from '../demand/venue-demand-ladder';
import { PublicAuctionView } from '../discovery/public-auction-view';
import type { ReviewedRuntime } from '../runtime-config/load-reviewed-runtime-config';
import type { RuntimeConfigEvaluation } from '../runtime-config/runtime-config';
import { WalletControls, UnsupportedWalletChainWarning } from '../wallet/wallet-controls';
import type { OracleConversions } from '../oracle/oracle-conversions';
import { CurrencyRatesProvider } from '../oracle/currency-state';
import type { WalletUiController } from '../wallet/use-wallet-controller';
import { ErrorBoundary } from '../ui/error-boundary';
import { FadeArc } from '../ui/fade-arc';
import { AppShell, Badge, Banner, Card, type PresentationTone } from '../ui/primitives';
import { TooltipProvider } from '../ui/tooltip';
import './app.css';

export type ApplicationState =
  | { kind: 'loading-runtime' }
  | { kind: 'invalid-route'; route: Extract<AuctionRouteResult, { kind: 'invalid-auction' }> }
  | { kind: 'loaded-runtime'; runtime: ReviewedRuntime }
  | { kind: 'loading-auction'; runtime: ReviewedRuntime }
  | { kind: 'loaded-auction'; runtime: ReviewedRuntime; auction: PublicAuctionRead }
  | {
      kind: 'loaded-discovery';
      actionRail?: ReactNode;
      activePage: 'auctions' | 'portfolio';
      portfolio: ReactNode;
      runtime: ReviewedRuntime;
      calendar: CalendarRangeRead;
      firstMonth: WorldwideDayMonth;
      monthGrids: readonly [WorldwideDayCalendarMonth, WorldwideDayCalendarMonth];
      selectedWorldwideDay: WorldwideDayKey;
      selectedAuction: PublicAuctionRead | null;
      selectedAuctionLoading: boolean;
      oracle: OraclePriceSectionProps;
      ladder: VenueLadderViewState;
      onLoadEarlierDemand?: (beforeWorldwideDay: WorldwideDayKey) => Promise<CalendarRangeRead | null>;
      onPreviousMonth: () => void;
      onNextMonth: () => void;
      onSelectDay: (worldwideDay: WorldwideDayKey) => void;
    }
  | { kind: 'failed'; message: string };

interface AppProps {
  browserSupport: BrowserSupportResult;
  state: ApplicationState;
  wallet?: WalletUiController;
  oracleConversions?: OracleConversions | null;
}

interface StatusPresentation {
  copy: ReactNode;
  eyebrow: string;
  icon: ReactNode;
  live: 'polite' | 'assertive';
  title: string;
  tone: PresentationTone;
}

const profileSummary = (config: RuntimeConfigEvaluation): string => {
  const origin = config.originProfile;
  const venueCount = config.venueProfiles.length;
  const venueLabel = `${venueCount} venue profile${venueCount === 1 ? '' : 's'}`;
  return origin ? `${origin.name}; ${venueLabel} found.` : `No designated Outbe origin; ${venueLabel} found.`;
};

const statusPresentation = (state: ApplicationState): StatusPresentation => {
  if (state.kind === 'loading-runtime') {
    return {
      copy: <p>Reading and validating local chain, deployment and ABI configuration.</p>,
      eyebrow: 'Startup check',
      icon: <span className="status-spinner" />,
      live: 'polite',
      title: 'Loading runtime configuration',
      tone: 'info',
    };
  }
  if (state.kind === 'loading-auction') {
    return {
      copy: <p>Selecting configured RPC endpoints and reading canonical origin and active-venue state.</p>,
      eyebrow: 'Public auction read',
      icon: <span className="status-spinner" />,
      live: 'polite',
      title: 'Loading auction evidence',
      tone: 'info',
    };
  }
  if (state.kind === 'invalid-route') {
    return {
      copy: (
        <p>
          {state.route.reason === 'format'
            ? 'Use /auction/YYYYMMDD with an eight-digit WorldwideDay key.'
            : 'The eight-digit key is not a possible calendar date.'}
        </p>
      ),
      eyebrow: 'Route rejected',
      icon: '!',
      live: 'assertive',
      title: state.route.reason === 'format' ? 'Malformed WorldwideDay route' : 'Invalid WorldwideDay date',
      tone: 'danger',
    };
  }
  if (state.kind === 'failed') {
    return {
      copy: <p>{state.message}</p>,
      eyebrow: 'Startup blocked',
      icon: '!',
      live: 'assertive',
      title: 'Application could not be loaded',
      tone: 'danger',
    };
  }
  if (state.kind === 'loaded-auction') {
    return {
      copy: <p>One read-only startup snapshot from the configured Outbe origin and active venue.</p>,
      eyebrow: 'Public auction',
      icon: '✓',
      live: 'polite',
      title: `WorldwideDay ${state.auction.worldwideDay}`,
      tone: 'success',
    };
  }

  if (state.kind === 'loaded-discovery') {
    return {
      copy: (
        <p>
          Canonical origin, global auction, cross-chain delivery, active-venue and Oracle evidence remain independently
          labelled.
        </p>
      ),
      eyebrow: 'Public auction discovery',
      icon: '✓',
      live: 'polite',
      title: `WorldwideDay ${state.selectedWorldwideDay}`,
      tone: 'success',
    };
  }

  const config = state.runtime.evaluation;
  if (config.state === 'invalid') {
    return {
      copy: <p>Invalid or incompatible profiles remain read- and write-incapable.</p>,
      eyebrow: 'Production application',
      icon: '!',
      live: 'assertive',
      title: 'Configuration requires attention',
      tone: 'danger',
    };
  }
  if (config.state === 'ready') {
    return {
      copy: <p>The reviewed runtime is ready. Open a valid /auction/YYYYMMDD route.</p>,
      eyebrow: 'Production application',
      icon: '✓',
      live: 'polite',
      title: 'Deployment configuration is ready',
      tone: 'success',
    };
  }
  return {
    copy: <p>The committed starter profiles are disabled. No configured RPC endpoint was contacted.</p>,
    eyebrow: 'Production application',
    icon: '—',
    live: 'polite',
    title: 'Deployment not configured',
    tone: 'info',
  };
};

function RuntimeStatus({ state }: { state: ApplicationState }) {
  const presentation = statusPresentation(state);
  return (
    <Banner
      eyebrow={presentation.eyebrow}
      icon={presentation.icon}
      live={presentation.live}
      title={presentation.title}
      tone={presentation.tone}
    >
      {presentation.copy}
    </Banner>
  );
}

const LOADING_LINGER_MS = 180;

function AuctionLoadingState({ visible, title = 'Loading auction' }: { visible: boolean; title?: string }) {
  const [lingering, setLingering] = useState(visible);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let frame: number | undefined;
    let unmountTimer: number | undefined;
    if (visible) {
      setLingering(true);
      frame = window.requestAnimationFrame(() => setShown(true));
    } else {
      setShown(false);
      unmountTimer = window.setTimeout(() => setLingering(false), LOADING_LINGER_MS);
    }
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (unmountTimer !== undefined) window.clearTimeout(unmountTimer);
    };
  }, [visible]);

  if (!visible && !lingering) return null;
  return (
    <div
      className="auction-loading-state"
      data-active={visible ? 'true' : 'false'}
      aria-hidden={!visible}
      role="status"
      aria-live="polite"
    >
      <div className={`auction-loading-state__content${shown ? ' auction-loading-state__content--shown' : ''}`}>
        <FadeArc className="auction-loading-state__arc" aria-hidden="true" />
        <h2 className="auction-loading-state__title">{title}</h2>
      </div>
    </div>
  );
}

function RuntimeDetails({ config }: { config: RuntimeConfigEvaluation }) {
  const tone: PresentationTone = config.state === 'ready' ? 'success' : config.state === 'invalid' ? 'danger' : 'info';
  const label = config.state === 'ready' ? 'Ready' : config.state === 'invalid' ? 'Invalid' : 'Disabled';
  return (
    <>
      <Card className="runtime-summary" aria-label="Runtime configuration summary">
        <dl>
          <div className="runtime-summary__row">
            <dt>Configuration</dt>
            <dd>
              <Badge tone={tone}>{label}</Badge>
            </dd>
          </div>
          <div className="runtime-summary__row">
            <dt>Profiles</dt>
            <dd>{profileSummary(config)}</dd>
          </div>
          <div className="runtime-summary__row">
            <dt>RPC activity</dt>
            <dd>{config.networkAccessAllowed ? 'Enabled for valid auction routes' : 'Blocked'}</dd>
          </div>
          <div className="runtime-summary__row">
            <dt>WalletConnect</dt>
            <dd>{config.walletConnect.usable ? 'Configured' : 'Disabled'}</dd>
          </div>
        </dl>
      </Card>
      {config.issues.length > 0 && (
        <Card className="issues-card" aria-labelledby="configuration-issues-title">
          <h2 id="configuration-issues-title">Configuration issues</h2>
          <ul>
            {config.issues.map((issue) => (
              <li key={`${issue.code}:${issue.profileId ?? 'global'}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </Card>
      )}
      <p className="configuration-hint">
        Edit <code>config/chains.json</code>, <code>config/deployments.json</code> and{' '}
        <code>config/walletconnect.json</code>, then restart.
      </p>
    </>
  );
}

function GateCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <Card className="gate-card">
      <p className="gate-card__eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <div className="gate-card__copy">{children}</div>
    </Card>
  );
}

export function App({ browserSupport, state, wallet, oracleConversions }: AppProps) {
  if (!browserSupport.supported) {
    return (
      <main className="gate-page">
        <GateCard eyebrow="Unsupported browser" title="This browser is missing required capabilities">
          <p>
            Use a current desktop release of Chrome, Edge, Firefox or Safari. Missing:{' '}
            {browserSupport.missingCapabilities.join(', ')}.
          </p>
        </GateCard>
      </main>
    );
  }
  const runtime = 'runtime' in state ? state.runtime : null;
  const productLoaded = state.kind === 'loaded-auction' || state.kind === 'loaded-discovery';
  const auctionLoading =
    state.kind === 'loading-auction' ||
    (state.kind === 'loaded-discovery' && state.activePage === 'auctions' && state.selectedAuctionLoading);
  const appLoading = state.kind === 'loading-runtime' || auctionLoading;
  const appLoadingTitle = state.kind === 'loading-runtime' ? 'Loading application' : 'Loading auction';
  let contextLabel = productLoaded
    ? (state.runtime.selectedVenue?.name ?? 'Active venue unavailable')
    : 'Read-only auction';
  if (runtime && wallet) {
    if (wallet.state.kind === 'connected-supported') contextLabel = wallet.state.activeVenue.name;
    if (wallet.state.kind === 'connected-unsupported')
      contextLabel = `Unsupported chain ${wallet.state.connection.chainId}`;
    if (wallet.state.kind === 'connecting' || wallet.state.kind === 'reconnecting')
      contextLabel = 'Wallet connection pending';
    if (wallet.state.kind === 'failed' && wallet.state.connection) contextLabel = 'Wallet context unavailable';
  }
  const contentBoundaryKey =
    state.kind === 'loaded-discovery' ? `${state.selectedWorldwideDay}:${state.activePage}` : state.kind;
  const walletContextKey = wallet
    ? wallet.state.kind === 'connected-supported'
      ? `${wallet.state.connection.chainId}:${wallet.state.connection.address}`
      : wallet.state.kind
    : 'no-wallet';
  const walletControl =
    runtime && wallet ? (
      <ErrorBoundary name="Wallet controls" resetKey={walletContextKey}>
        <WalletControls
          {...wallet}
          venues={runtime.venues}
          walletConnectAvailable={runtime.evaluation.walletConnect.usable}
        />
      </ErrorBoundary>
    ) : undefined;
  return (
    <TooltipProvider>
      <CurrencyRatesProvider conversions={oracleConversions}>
        <div className="supported-viewport">
          <AppShell
            activePage={state.kind === 'loaded-discovery' ? state.activePage : 'auctions'}
            auctionHref={state.kind === 'loaded-discovery' ? `/auction/${state.selectedWorldwideDay}` : '/'}
            contextLabel={contextLabel}
            status={
              productLoaded || state.kind === 'loading-auction' || state.kind === 'loading-runtime' ? undefined : (
                <RuntimeStatus state={state} />
              )
            }
            walletControl={walletControl}
          >
            {runtime && wallet && wallet.state.kind === 'connected-unsupported' ? (
              <UnsupportedWalletChainWarning
                state={wallet.state}
                venues={runtime.venues}
                switchChain={wallet.switchChain}
              />
            ) : (
              <>
                <AuctionLoadingState visible={appLoading} title={appLoadingTitle} />
                <ErrorBoundary name="Auction content" resetKey={contentBoundaryKey}>
                  {state.kind === 'loaded-runtime' && <RuntimeDetails config={state.runtime.evaluation} />}
                  {state.kind === 'loaded-auction' && <PublicAuctionView auction={state.auction} />}
                  {state.kind === 'loaded-discovery' &&
                    (state.activePage === 'portfolio' ? (
                      state.portfolio
                    ) : (
                      <PublicDiscoveryView
                        actionRail={state.actionRail}
                        calendar={state.calendar}
                        firstMonth={state.firstMonth}
                        monthGrids={state.monthGrids}
                        selectedWorldwideDay={state.selectedWorldwideDay}
                        selectedAuction={state.selectedAuction}
                        selectedAuctionLoading={state.selectedAuctionLoading}
                        oracle={state.oracle}
                        ladder={state.ladder}
                        onLoadEarlierDemand={state.onLoadEarlierDemand}
                        onPreviousMonth={state.onPreviousMonth}
                        onNextMonth={state.onNextMonth}
                        onSelectDay={state.onSelectDay}
                      />
                    ))}
                </ErrorBoundary>
              </>
            )}
          </AppShell>
        </div>
        <main className="viewport-gate">
          <GateCard eyebrow="Desktop application" title="A larger viewport is required">
            <p>The supported minimum viewport is 600 × 720 pixels.</p>
          </GateCard>
        </main>
      </CurrencyRatesProvider>
    </TooltipProvider>
  );
}
