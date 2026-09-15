export const scenarioNames = [
  'commit-open',
  'reveal-open',
  'oracle-unavailable',
  'reaped-historical-auction',
  'failed-green',
  'cleaned-history-unavailable',
  'completed-green-sold-out',
  'completed-green-partial',
  'completed-green-no-sale',
  'completed-red',
  'terminal-no-auction',
  'venue-delivery-pending',
  'venue-chain-skipped',
  'origin-send-parked',
  'origin-send-flushed-target-pending',
  'unrevealed-bond-waiting',
  'unrevealed-bond-claimable',
  'abandoned-commit-bond-waiting',
  'abandoned-commit-bond-claimable',
  'unfinalized-escrow-waiting',
  'unfinalized-escrow-claimable',
  'finalized-failed-split',
  'finalized-without-split',
  'finalization-no-op',
  'past-auctions',
];

export const requireScenarioName = (name) => {
  if (!scenarioNames.includes(name)) {
    throw new Error(`Usage: npm run local:seed -- <scenario>\n\n${scenarioNames.join('\n')}`);
  }
  return name;
};
