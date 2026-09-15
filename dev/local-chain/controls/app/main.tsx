import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getAddress } from 'viem';
import { ErrorBoundary } from '@/ui/error-boundary';
import { DevControlView, type LocalStatus } from './dev-control-app';
import './dev-controls.css';

async function request(command = 'status', count?: number, address?: string): Promise<LocalStatus> {
  const response = await fetch('/__dev/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command,
      ...(count === undefined ? {} : { count }),
      ...(address === undefined ? {} : { address }),
    }),
  });
  const body = (await response.json()) as LocalStatus | { error: string };
  if (!response.ok || 'error' in body)
    throw new Error('error' in body ? body.error : `Control request failed with HTTP ${response.status}.`);
  return body;
}

const normalizeTesterAddress = (value: string): string | null => {
  try {
    return getAddress(value.trim());
  } catch {
    return null;
  }
};

export function App() {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fundingMessage, setFundingMessage] = useState<string | null>(null);
  const [seedCount, setSeedCount] = useState(20);
  const [testerAddress, setTesterAddress] = useState<string | null>(null);
  const normalizedTesterAddress = useMemo(
    () => (testerAddress === null ? null : normalizeTesterAddress(testerAddress)),
    [testerAddress],
  );
  const testerAddressError =
    testerAddress !== null && normalizedTesterAddress === null ? 'Enter a valid EVM address.' : null;

  const refresh = useCallback(async () => {
    if (testerAddress !== null && normalizedTesterAddress === null) {
      setError('Enter a valid tester wallet address before refreshing.');
      return;
    }
    try {
      const next = await request('status', undefined, normalizedTesterAddress ?? undefined);
      setStatus(next);
      setTesterAddress((current) => current ?? next.tester.address);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load local state.');
    }
  }, [normalizedTesterAddress, testerAddress]);

  const run = useCallback(
    async (command: string, count?: number) => {
      if (normalizedTesterAddress === null) {
        setError('Enter a valid tester wallet address before running a control.');
        return;
      }
      setBusy(count === undefined ? command : `${command} ${count}`);
      setError(null);
      setFundingMessage(null);
      if (command === 'fund') setStatus(null);
      try {
        const next = await request(command, count, normalizedTesterAddress);
        setStatus(next);
        if (command === 'fund') {
          setFundingMessage(
            `Funding completed for ${next.tester.address}. Balances below are fresh; no EscrowAdapter approval was submitted.`,
          );
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Local command failed.');
      } finally {
        setBusy(null);
      }
    },
    [normalizedTesterAddress],
  );

  const changeTesterAddress = useCallback((value: string) => {
    setTesterAddress(value);
    setStatus(null);
    setFundingMessage(null);
    setError(null);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = globalThis.setInterval(() => {
      if (!busy && (testerAddress === null || normalizedTesterAddress !== null)) void refresh();
    }, 2_000);
    return () => globalThis.clearInterval(timer);
  }, [busy, normalizedTesterAddress, refresh, testerAddress]);

  return (
    <DevControlView
      status={status}
      busy={busy}
      error={error}
      fundingMessage={fundingMessage}
      seedCount={seedCount}
      testerAddress={testerAddress ?? status?.tester.address ?? ''}
      testerAddressError={testerAddressError}
      onRefresh={() => void refresh()}
      onRun={(command, count) => void run(command, count)}
      onSeedCountChange={setSeedCount}
      onTesterAddressChange={changeTesterAddress}
    />
  );
}

const root = document.getElementById('dev-root');
if (!root) throw new Error('Missing #dev-root mount point.');
createRoot(root).render(
  <ErrorBoundary name="Local control panel" layout="full" title="Local control panel could not be loaded">
    <App />
  </ErrorBoundary>,
);
