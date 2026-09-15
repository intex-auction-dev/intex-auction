import { describe, expect, it } from 'vitest';
import {
  requireScenarioName,
  scenarioNames,
} from '../../../../../dev/local-chain/scripts/local/scenarios/scenario-names.mjs';

const recoveryScenarios = [
  'unrevealed-bond-waiting',
  'unrevealed-bond-claimable',
  'abandoned-commit-bond-waiting',
  'abandoned-commit-bond-claimable',
  'unfinalized-escrow-waiting',
  'unfinalized-escrow-claimable',
  'finalized-failed-split',
  'finalized-without-split',
  'finalization-no-op',
];

describe('local recovery scenarios', () => {
  it('exports every deterministic recovery scenario', () => {
    expect(scenarioNames).toEqual(expect.arrayContaining(recoveryScenarios));
  });

  it('rejects invalid scenario names', () => {
    expect(() => requireScenarioName('not-a-scenario')).toThrow('Usage: npm run local:seed');
  });
});
