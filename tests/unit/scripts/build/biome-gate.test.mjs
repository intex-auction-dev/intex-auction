import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (name) => readFileSync(resolve(ROOT, name), 'utf8');

const scripts = JSON.parse(read('package.json')).scripts;
const config = read('biome.jsonc');

/**
 * The sibling gates in `scripts/build/` each have a test beside them so they cannot silently
 * stop catching things. Biome is a third gate, so it gets the same treatment: these assertions
 * fail if the gate is unwired, if reviewed artifacts stop being excluded, or if a rule is
 * switched off without a written reason.
 */
describe('Biome gate', () => {
  it('runs inside both check and verify', () => {
    expect(scripts['check:biome']).toBe('biome ci .');
    for (const name of ['check', 'verify']) {
      expect(scripts[name]).toContain('npm run check:biome');
    }
  });

  it('does not replace the layer-boundary gate, which Biome cannot express', () => {
    // Biome has no import-cycle or restricted-path rule.
    for (const name of ['check', 'verify']) {
      expect(scripts[name]).toContain('npm run check:layers');
    }
  });

  it('keeps the read-only submodule and reviewed config out of scope', () => {
    expect(config).toContain('"!blockchain/outbe-chain"');
    expect(config).toContain('"!config"');
  });

  it('does not exclude first-party source to pass', () => {
    for (const excluded of ['"!src', '"!tests', '"!scripts']) {
      expect(config).not.toContain(excluded);
    }
  });

  it('states a reason for every disabled rule', () => {
    const lines = config.split('\n');
    const disabled = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => /^"[a-zA-Z]+":\s*"off"/.test(line));
    expect(disabled.length).toBeGreaterThan(0);
    for (const { line, index } of disabled) {
      const preceding = lines
        .slice(0, index)
        .reverse()
        .findIndex((candidate) => !candidate.trim().startsWith('//'));
      expect(preceding, `${line} needs a comment explaining why it is off`).toBeGreaterThan(0);
    }
  });
});
