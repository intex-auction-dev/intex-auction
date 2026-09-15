import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production entrypoint safety', () => {
  it('does not replace JSON.stringify globally', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(source).not.toMatch(/\bJSON\.stringify\s*=/);
  });
});
