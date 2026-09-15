import { describe, expect, it } from 'vitest';
import { motionDurationMs } from '@/ui/flowing-number-text';

describe('motionDurationMs', () => {
  it.each([
    ['560ms', 560],
    ['.56s', 560],
  ])('normalizes %s to %d milliseconds', (value, expected) => {
    expect(motionDurationMs(value)).toBe(expected);
  });
});
