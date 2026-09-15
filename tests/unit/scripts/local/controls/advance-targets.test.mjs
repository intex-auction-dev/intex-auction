import { describe, expect, it } from 'vitest';
import {
  boundaryTriplet,
  requireAdvanceTarget,
  requireLocalChainId,
  requireScenarioSummary,
} from '../../../../../dev/local-chain/scripts/local/controls/advance-targets.mjs';

describe('local stage advancement guards', () => {
  it('rejects a missing seeded scenario', () => {
    expect(() => requireScenarioSummary(null)).toThrow('No seeded scenario found');
  });

  it('rejects a target incompatible with the seeded scenario', () => {
    expect(() => requireAdvanceTarget('commit-open', 'abandoned-bond-claimable')).toThrow(
      'incompatible with seeded scenario commit-open',
    );
  });

  it('rejects non-local chains', () => {
    expect(() => requireLocalChainId(1, 31337)).toThrow('Refusing time control on chain 1');
  });

  it('keeps exact deadline checks one second apart', () => {
    expect(boundaryTriplet(100)).toEqual({ before: 99, exact: 100, after: 101 });
  });
});
