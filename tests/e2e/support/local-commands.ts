import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Local-chain command scripts live under the `dev/local-chain` overlay, not in the
 * repository-root `scripts/` directory. Several specs previously resolved
 * `<root>/scripts/local-scenario.mjs` and failed at run time with a module-not-found
 * error, which is invisible to typecheck because the path is a runtime string.
 *
 * Keeping the location in one place means a future move of the overlay breaks one
 * constant instead of every spec that seeds a scenario.
 */
const COMMANDS_DIR = resolve(ROOT, 'dev/local-chain/scripts/local/commands');

export const localCommandPath = (script: string): string => {
  const path = resolve(COMMANDS_DIR, script);
  if (!existsSync(path)) {
    throw new Error(
      `Local chain command "${script}" does not exist at ${path}. ` +
        'Update tests/e2e/support/local-commands.ts if the overlay moved.',
    );
  }
  return path;
};

/** Runs a local-chain command synchronously, failing the spec if the command fails. */
export const runLocalCommand = (script: string, ...args: string[]): string =>
  execFileSync(process.execPath, [localCommandPath(script), ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });

export const seedScenario = (scenario: string): string => runLocalCommand('local-scenario.mjs', scenario);

export const seedCommitOpen = (): string => seedScenario('commit-open');

export const advanceTo = (target: string): string => runLocalCommand('local-advance.mjs', target);

export const control = (action: string): string => runLocalCommand('local-control.mjs', action);
