import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../../src/bidding/receipt-tools.css', import.meta.url), 'utf8');
const walletCss = readFileSync(new URL('../../../../src/wallet/wallet.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../../../src/app/app.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../../../src/ui/tokens.css', import.meta.url), 'utf8');

describe('receipt modal presentation', () => {
  it('uses shared dialog layout instead of wallet flyout coupling', () => {
    expect(css).not.toContain('wallet-overlay');
    expect(css).not.toContain('receipt-modal-pop');
    expect(css).not.toMatch(/\.wallet-panel\.receipt-tools__/);
    expect(css).not.toContain('@keyframes receipt-overlay-fade');
    expect(css).not.toContain('receipt-content-enter');
    expect(css).not.toContain('receipt-loading-pulse');
    expect(walletCss).not.toMatch(/\.wallet-panel\.receipt-tools__/);
  });

  it('uses a soft spring only for auction card entrance animations with reduced-motion guard', () => {
    expect(tokensCss).toContain('--ease-spring-soft: linear(');
    expect(appCss).toContain('auction-card-enter');
    expect(appCss).toContain('animation-delay');
    expect(appCss).toMatch(
      /\.auction-product-main\s*>\s*\.card\s*\{[^}]*animation:\s*auction-card-enter var\(--motion-slow\) var\(--ease-spring-soft\) both/s,
    );
    expect(appCss).toMatch(/\.auction-product-main\s*>\s*\.card:nth-child\(2\)\s*\{[^}]*animation-delay:\s*90ms/s);
    expect(appCss).toMatch(/\.auction-product-main\s*>\s*\.card:nth-child\(3\)\s*\{[^}]*animation-delay:\s*180ms/s);
    expect(appCss).toMatch(/\.auction-product-main\s*>\s*\.card:nth-child\(4\)\s*\{[^}]*animation-delay:\s*270ms/s);
    expect(appCss).toMatch(/\.auction-product-main\s*>\s*\.card:nth-child\(5\)\s*\{[^}]*animation-delay:\s*360ms/s);
    expect(appCss).toMatch(
      /\.auction-product-rail\s*>\s*\.card\s*\{[^}]*animation:\s*auction-card-enter var\(--motion-slow\) var\(--ease-spring-soft\) both/s,
    );
    expect(appCss).toMatch(/\.auction-product-rail\s*>\s*\.card:nth-child\(1\)\s*\{[^}]*animation-delay:\s*450ms/s);
    expect(appCss).toMatch(/\.auction-product-rail\s*>\s*\.card:nth-child\(2\)\s*\{[^}]*animation-delay:\s*540ms/s);
    expect(appCss).toMatch(
      /\.portfolio-card\s*\{[^}]*animation:\s*auction-card-enter var\(--motion-slow\) var\(--ease-spring-soft\) both;/s,
    );
    expect(appCss).toMatch(/\.auction-product-main\s*>\s*\.card\s*\{[^}]*animation:\s*none[^}]*\}/s);
    expect(appCss).toMatch(/\.auction-product-rail\s*>\s*\.card\s*\{[^}]*animation:\s*none[^}]*\}/s);
  });

  it('keeps receipt metadata and secondary-button presentation', () => {
    expect(css).toMatch(
      /\.receipt-modal__metadata code\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
    );
    expect(css).toMatch(/\.receipt-modal__metadata a::before\s*\{\s*content:\s*['"]↗['"];/s);
    expect(css).toMatch(/\.receipt-modal__download\s*\{[^}]*background:\s*color-mix\(/s);
    expect(css).toMatch(/\.receipt-modal__download svg\s*\{[^}]*width:\s*15px;[^}]*height:\s*15px;/s);
  });
});

describe('receipt manager interface copy', () => {
  it('omits retired backup notices while retaining receipt actions', () => {
    const receiptTools = readFileSync(new URL('../../../../src/bidding/receipt-tools.tsx', import.meta.url), 'utf8');

    expect(receiptTools).not.toContain('SENSITIVE_RECEIPT_WARNING');
    expect(receiptTools).not.toContain(
      'Downloads are best-effort. A browser download event is not proof that a backup was saved.',
    );
    expect(receiptTools).toContain('Import JSON files');
    expect(receiptTools).toContain('Export all receipts');
    expect(receiptTools).toContain('Download receipt');
  });
});
