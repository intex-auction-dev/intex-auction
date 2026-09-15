import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WalletControls } from '@/wallet/wallet-controls';
import { injectedProviderSubtitle } from '@/wallet/wallet-connection-controls';

describe('header wallet utilities', () => {
  it('keeps receipts inside the overflow menu', () => {
    const markup = renderToStaticMarkup(
      <WalletControls
        state={{ kind: 'disconnected', providers: [] }}
        venues={[]}
        walletConnectAvailable={false}
        connect={() => undefined}
        connectWalletConnect={() => undefined}
        openWalletConnectModal={() => false}
        disconnect={() => undefined}
        switchChain={() => undefined}
      />,
    );

    expect(markup).toContain('Connect Wallet');
    expect(markup).toContain('aria-label="More options"');
    expect(markup).not.toContain('receipt-tools__trigger');
    expect(markup).not.toContain('>Receipts</button>');
    expect(markup).toContain('aria-label="Import bid receipt"');
    expect(markup).not.toContain('Local safety records');
    expect(markup).not.toContain('No local bid receipts are stored.');
    expect(markup).not.toContain('A browser download event is not proof');
  });

  it('does not repeat the generic injected provider name', () => {
    expect(injectedProviderSubtitle('Injected wallet')).toBe('Browser wallet');
    expect(injectedProviderSubtitle('MetaMask')).toBe('Injected wallet');
  });
});
