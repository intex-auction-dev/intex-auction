import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import { isNotWhitelisted } from '@/chain/revert-classify';

describe('revert classification — NotWhitelisted', () => {
  it('names a decoded NotWhitelisted revert', () => {
    const error = {
      cause: {
        data: { errorName: 'NotWhitelisted', args: ['0x00000000000000000000000000000000000000A1'] },
      },
    };
    expect(isNotWhitelisted(error)).toBe(true);
  });

  it('names a raw NotWhitelisted revert by selector', () => {
    const error = { cause: { data: toFunctionSelector('NotWhitelisted(address)') } };
    expect(isNotWhitelisted(error)).toBe(true);
  });

  it('does not misclassify an unrelated revert', () => {
    expect(isNotWhitelisted({ cause: { data: { errorName: 'AuctionNotFound', args: [] } } })).toBe(false);
    expect(isNotWhitelisted(new Error('boom'))).toBe(false);
  });
});
