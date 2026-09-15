import { describe, expect, it, vi } from 'vitest';
import { writeScenarioAfterAssertions } from '../../../../../dev/local-chain/scripts/local/scenarios/scenario-runner.mjs';

describe('scenario persistence', () => {
  it('does not write scenario metadata when assertions fail', async () => {
    const clear = vi.fn();
    const write = vi.fn();
    await expect(
      writeScenarioAfterAssertions({
        clear,
        build: async () => {
          throw new Error('assertion failed');
        },
        write,
      }),
    ).rejects.toThrow('assertion failed');
    expect(clear).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes only the asserted summary', async () => {
    const order = [];
    const summary = { name: 'fixture' };
    await writeScenarioAfterAssertions({
      clear: async () => {
        order.push('clear');
      },
      build: async () => {
        order.push('build');
        return summary;
      },
      write: async (value) => {
        order.push('write');
        expect(value).toBe(summary);
      },
    });
    expect(order).toEqual(['clear', 'build', 'write']);
  });
});
