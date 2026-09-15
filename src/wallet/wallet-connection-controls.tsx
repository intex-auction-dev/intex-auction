import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Wallet, X } from 'lucide-react';
import type { ResolvedVenueReadProfile } from '../runtime-config/load-reviewed-runtime-config';
import { Button, Icon, Notice } from '../ui/primitives';
import { usePresence } from '../ui/use-presence';
import type { WalletUiController } from './use-wallet-controller';
import { isWalletConnected, type WalletState } from './wallet-state';
import './wallet.css';

interface WalletControlsProps extends WalletUiController {
  venues: readonly ResolvedVenueReadProfile[];
  walletConnectAvailable: boolean;
}

const abbreviated = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const injectedProviderSubtitle = (name: string): string =>
  name === 'Injected wallet' ? 'Browser wallet' : 'Injected wallet';

const connectedLabel = (
  state: Extract<WalletState, { kind: 'connected-supported' | 'connected-unsupported' }>,
): string => abbreviated(state.connection.address);

export function WalletControls({
  state,
  venues,
  walletConnectAvailable,
  connect,
  connectWalletConnect,
  disconnect,
  switchChain,
}: WalletControlsProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousKind = useRef(state.kind);
  const presence = usePresence(open);
  const dataPresence =
    presence.state === 'starting'
      ? { 'data-starting-style': '' }
      : presence.state === 'ending'
        ? { 'data-ending-style': '' }
        : {};

  const close = useCallback(() => {
    setOpen(false);
    globalThis.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const openFromAuction = () => setOpen(true);
    globalThis.addEventListener('itx-acn:open-wallet', openFromAuction);
    return () => globalThis.removeEventListener('itx-acn:open-wallet', openFromAuction);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('mousedown', onMouseDown);
    panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, close]);

  useEffect(() => {
    const wasConnecting = previousKind.current === 'connecting' || previousKind.current === 'reconnecting';
    previousKind.current = state.kind;
    if (open && wasConnecting && isWalletConnected(state)) close();
  }, [open, state, close]);

  const connecting = state.kind === 'connecting' || state.kind === 'reconnecting';
  const label = connecting
    ? state.kind === 'reconnecting'
      ? 'Restoring…'
      : 'Connecting…'
    : isWalletConnected(state)
      ? connectedLabel(state)
      : 'Connect Wallet';

  return (
    <div className="wallet-control">
      <Button
        className={`app-shell__wallet${state.kind === 'failed' ? ' app-shell__wallet--failed' : ''}`}
        ref={triggerRef}
        disabled={state.kind === 'discovering' || connecting}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon icon={Wallet} size={14} />
        {label}
      </Button>
      {presence.mounted && (
        <div
          className="wallet-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-panel-title"
          ref={panelRef}
          {...dataPresence}
        >
          <div className="wallet-panel__header">
            <div>
              <span>Wallet</span>
              <h2 id="wallet-panel-title">{isWalletConnected(state) ? 'Connection' : 'Choose a provider'}</h2>
            </div>
            <Button variant="ghost" size="icon" aria-label="Close wallet controls" onClick={close}>
              <Icon icon={X} size={18} />
            </Button>
          </div>
          {connecting && (
            <Notice tone="info" live="polite">
              {state.kind === 'reconnecting'
                ? 'Restoring the previous wallet session…'
                : 'Waiting for the selected wallet…'}
            </Notice>
          )}
          {isWalletConnected(state) ? (
            <div className="wallet-panel__connected">
              <dl>
                <div>
                  <dt>Account</dt>
                  <dd>{state.connection.address}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{state.connection.provider.name}</dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>
                    {state.kind === 'connected-supported'
                      ? state.activeVenue.name
                      : `Unsupported chain · ${state.connection.chainId}`}
                  </dd>
                </div>
              </dl>
              <div className="wallet-panel__networks">
                <span>Switch network</span>
                {venues.map((venue) => (
                  <Button
                    variant="outline"
                    key={`${venue.deploymentId}:${venue.chainId}`}
                    disabled={venue.chainId === state.connection.chainId || state.networkSwitch.kind === 'pending'}
                    onClick={() => switchChain(venue.chainId)}
                  >
                    {venue.name}
                    {state.networkSwitch.kind === 'pending' && state.networkSwitch.chainId === venue.chainId
                      ? ' · switching…'
                      : ''}
                  </Button>
                ))}
              </div>
              <Button
                variant="destructive"
                onClick={() => {
                  disconnect();
                  close();
                }}
              >
                <Icon icon={LogOut} size={16} /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="wallet-provider-list">
              {state.providers.flatMap((provider) =>
                provider.type !== 'injected'
                  ? []
                  : [
                      <Button
                        variant="outline"
                        key={provider.id}
                        disabled={connecting}
                        onClick={() => connect(provider.id)}
                      >
                        <Icon icon={Wallet} size={17} />
                        <span>
                          <strong>{provider.name}</strong>
                          <small>{injectedProviderSubtitle(provider.name)}</small>
                        </span>
                      </Button>,
                    ],
              )}
              {walletConnectAvailable && (
                <Button variant="outline" disabled={connecting} onClick={connectWalletConnect}>
                  <Icon icon={Wallet} size={17} />
                  <span>
                    <strong>WalletConnect</strong>
                    <small>Scan with a compatible wallet</small>
                  </span>
                </Button>
              )}
              {state.providers.length === 0 && !walletConnectAvailable && (
                <Notice tone="neutral">No injected wallet was detected.</Notice>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function UnsupportedWalletChainWarning({
  state,
  venues,
  switchChain,
}: Pick<WalletControlsProps, 'state' | 'venues' | 'switchChain'>) {
  if (state.kind !== 'connected-unsupported') return null;
  return (
    <div className="network-takeover" role="alert" aria-live="assertive" aria-atomic="true">
      <div className="network-takeover__card">
        <div className="network-takeover__icon" aria-hidden="true">
          !
        </div>
        <h1 className="network-takeover__title">Selected network is not supported</h1>
        <p className="network-takeover__sub">Switch your wallet to a supported network to continue.</p>
        <div className="network-takeover__actions">
          {venues.map((venue) => (
            <Button
              variant="default"
              key={`${venue.deploymentId}:${venue.chainId}`}
              disabled={state.networkSwitch.kind === 'pending'}
              onClick={() => switchChain(venue.chainId)}
            >
              {state.networkSwitch.kind === 'pending' && state.networkSwitch.chainId === venue.chainId
                ? `Switching to ${venue.name}…`
                : `Switch to ${venue.name}`}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
