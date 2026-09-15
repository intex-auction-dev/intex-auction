import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Eip1193Provider } from '@/wallet/eip1193';
import type { WalletProviderDescriptor } from '@/wallet/injected-providers';
import { createWalletController } from '@/wallet/wallet-controller';

const RESET_MESSAGE = 'Connection request reset. Please try again.';

class ResetWalletConnectProvider implements Eip1193Provider {
  async enable(): Promise<unknown> {
    throw new Error(RESET_MESSAGE);
  }

  async request(): Promise<unknown> {
    throw new Error('Unexpected request after WalletConnect reset.');
  }
}

describe('wallet connection reset regression', () => {
  it('treats closing the WalletConnect modal as a cancellation, not a failed wallet state', async () => {
    const provider = new ResetWalletConnectProvider();
    const descriptor: WalletProviderDescriptor = {
      id: 'walletconnect',
      sessionId: 'walletconnect',
      type: 'walletconnect',
      name: 'WalletConnect',
      provider,
    };
    const controller = createWalletController({
      target: new EventTarget(),
      venues: [],
      walletConnectLoader: async () => descriptor,
    });

    await controller.connectWalletConnect();

    expect(controller.getState().kind).toBe('disconnected');
    controller.stop();
  });

  it('keeps the connect button blue and removes the chooser overlay layer', () => {
    const css = readFileSync(new URL('../../../../src/wallet/wallet.css', import.meta.url), 'utf8');
    const controls = readFileSync(
      new URL('../../../../src/wallet/wallet-connection-controls.tsx', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/\.app-shell__wallet--failed\s*\{[^}]*background:\s*var\(--color-accent\);/s);
    expect(css).not.toContain('.wallet-overlay');
    expect(controls).not.toContain('wallet-overlay');
    expect(css).toContain('position: fixed;');
  });
});
