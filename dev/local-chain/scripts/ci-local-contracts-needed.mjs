import process from 'node:process';

const relevantPatterns = [
  /^blockchain\//,
  /^config\//,
  /^playwright\.config\./,
  /^dev\/local-chain\/(?:blockchain|scripts)\//,
  /^tests\/e2e\//,
  /^(?:src|tests\/unit\/src)\/(?:chain|receipts|runtime-config|wallet)\//,
  /^(?:src|tests\/unit\/src)\/app\/runtime-gates(?:\.test)?\.ts$/,
  /^(?:src|tests\/unit\/src)\/auction\/.*(?:transaction|adapter|escrow|recovery|controller|loader|history|polling|read-model|commit-domain)/,
  /^package(?:-lock)?\.json$/,
];

export const needsLocalContracts = (paths) =>
  paths.some((path) => relevantPatterns.some((pattern) => pattern.test(path)));

if (process.argv.includes('--self-test')) {
  const cases = [
    [['docs/readme.md'], false],
    [['src/app/app.css'], false],
    [['scripts/server/serve.mjs'], false],
    [['src/auction/commit-transaction.ts'], true],
    [['tests/unit/src/auction/commit-transaction.test.ts'], true],
    [['dev/local-chain/scripts/local/commands/local-scenario.mjs'], true],
    [['dev/local-chain/scripts/runners/run-phase7-local.mjs'], true],
    [['tests/e2e/anvil/phase7-commit-anvil.test.mts'], true],
    [['dev/local-chain/blockchain/deploy/local/DeployLocal.s.sol'], true],
    [['package-lock.json'], true],
  ];

  for (const [paths, expected] of cases) {
    const actual = needsLocalContracts(paths);
    if (actual !== expected) {
      throw new Error(`Expected ${JSON.stringify(paths)} => ${expected}, received ${actual}`);
    }
  }

  console.log('ci-local-contracts-needed self-test passed');
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const paths = input
  .split(/\r?\n/u)
  .map((path) => path.trim())
  .filter(Boolean);
process.stdout.write(needsLocalContracts(paths) ? 'true' : 'false');
