import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  executableName,
  findExecutable,
  run,
} from '../../../../../dev/local-chain/scripts/local/infrastructure/process.mjs';

const fixtureRoot = () => mkdtemp(resolve(tmpdir(), 'intex local tools '));

describe('local command helpers', () => {
  it('uses platform-specific executable names', () => {
    expect(executableName('forge', 'win32')).toBe('forge.exe');
    expect(executableName('forge', 'linux')).toBe('forge');
    expect(executableName('forge', 'darwin')).toBe('forge');
  });

  it('passes paths and arguments without shell reinterpretation', async () => {
    const root = await fixtureRoot();
    const script = resolve(root, 'echo arguments.mjs');
    await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));\n');

    const output = run(process.execPath, [script, 'value with spaces', '"quoted"'], {
      cwd: root,
      capture: true,
    });

    expect(JSON.parse(output)).toEqual(['value with spaces', '"quoted"']);
  });

  it('fails clearly when a required executable is missing', async () => {
    const emptyPath = [await fixtureRoot(), await fixtureRoot()].join(delimiter);
    await expect(findExecutable('missing-tool', { path: emptyPath })).rejects.toThrow(
      'missing-tool is required but was not found on PATH.',
    );
  });
});
