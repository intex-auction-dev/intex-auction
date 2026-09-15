import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const findTests = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) return findTests(full);
      return /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(entry.name) ? [full] : [];
    }),
  );
  return found.flat();
};

describe('test layout', () => {
  it('keeps every test out of src and scripts so default discovery cannot miss it', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const strays = [...(await findTests(resolve(root, 'src'))), ...(await findTests(resolve(root, 'scripts')))];
    expect(strays).toEqual([]);
  });
});
