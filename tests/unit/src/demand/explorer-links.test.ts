import { describe, expect, it } from 'vitest';
import { explorerLink } from '@/demand/explorer-links';

describe('explorer links', () => {
  it('joins reviewed explorer bases without dropping a path prefix', () => {
    expect(explorerLink('https://bscscan.com', 'tx', '0xabc')).toBe('https://bscscan.com/tx/0xabc');
    expect(explorerLink('https://bscscan.com/', 'address', '0xdef')).toBe('https://bscscan.com/address/0xdef');
    expect(explorerLink('https://explorer.example/outbe', 'tx', '0xabc')).toBe(
      'https://explorer.example/outbe/tx/0xabc',
    );
  });

  it('produces no link without reviewed or usable metadata', () => {
    expect(explorerLink(null, 'tx', '0xabc')).toBeNull();
    expect(explorerLink('javascript:alert(1)', 'tx', '0xabc')).toBeNull();
    expect(explorerLink('not a url', 'tx', '0xabc')).toBeNull();
  });
});
