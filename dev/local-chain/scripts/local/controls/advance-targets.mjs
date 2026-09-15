export const advanceTargets = [
  'commit-before-end',
  'commit-end',
  'reveal',
  'reveal-before-end',
  'reveal-end',
  'issuance',
  'issuance-end',
  'unrevealed-bond-before-claimable',
  'unrevealed-bond-claimable',
  'abandoned-bond-before-claimable',
  'abandoned-bond-claimable',
  'unfinalized-refund-before-claimable',
  'unfinalized-refund-claimable',
  'failed-split-before-claimable',
  'failed-split-claimable',
  'no-split-before-claimable',
  'no-split-claimable',
];

const compatible = {
  'commit-open': new Set([
    'commit-before-end',
    'commit-end',
    'reveal',
    'reveal-before-end',
    'reveal-end',
    'issuance',
    'issuance-end',
  ]),
  'reveal-open': new Set(['reveal-before-end', 'reveal-end', 'issuance', 'issuance-end']),
  'unrevealed-bond-waiting': new Set(['unrevealed-bond-before-claimable', 'unrevealed-bond-claimable']),
  'abandoned-commit-bond-waiting': new Set(['abandoned-bond-before-claimable', 'abandoned-bond-claimable']),
  'unfinalized-escrow-waiting': new Set(['unfinalized-refund-before-claimable', 'unfinalized-refund-claimable']),
  'finalized-failed-split': new Set(['failed-split-before-claimable', 'failed-split-claimable']),
  'finalized-without-split': new Set(['no-split-before-claimable', 'no-split-claimable']),
  'finalization-no-op': new Set(['no-split-before-claimable', 'no-split-claimable']),
};

export const requireLocalChainId = (actual, expected) => {
  if (actual !== expected)
    throw new Error(`Refusing time control on chain ${actual}; expected local chain ${expected}.`);
};

export const requireScenarioSummary = (scenario) => {
  if (!scenario || typeof scenario !== 'object' || typeof scenario.name !== 'string') {
    throw new Error('No seeded scenario found. Run npm run local:seed -- <scenario>.');
  }
  return scenario;
};

export const requireAdvanceTarget = (scenarioName, target) => {
  if (!advanceTargets.includes(target)) {
    throw new Error(`Usage: npm run local:advance -- <target>\n\n${advanceTargets.join('\n')}`);
  }
  if (!compatible[scenarioName]?.has(target)) {
    throw new Error(`Target ${target} is incompatible with seeded scenario ${scenarioName}.`);
  }
  return target;
};

export const boundaryTriplet = (deadline) => ({
  before: deadline - 1,
  exact: deadline,
  after: deadline + 1,
});
