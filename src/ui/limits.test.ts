/**
 * limits.ts — the input clamp that actually enforces the field bounds (the
 * `max`/`min` HTML attributes only drive the spinner, not typed/pasted values).
 */

import { describe, expect, it } from 'vitest';
import { INPUT_LIMITS, clampInput } from './limits.ts';

describe('clampInput', () => {
  const bounds = { min: 1, max: 200 };

  it('passes an in-range value through unchanged', () => {
    expect(clampInput(50, bounds)).toBe(50);
  });

  it('caps an over-max value (the pasted/fat-fingered case)', () => {
    expect(clampInput(1e9, bounds)).toBe(200);
  });

  it('floors an under-min value', () => {
    expect(clampInput(-5, bounds)).toBe(1);
  });

  it('collapses a non-finite value to min (empty/garbage field)', () => {
    expect(clampInput(NaN, bounds)).toBe(1);
    expect(clampInput(Infinity, bounds)).toBe(1);
  });

  it('keeps the dose-count cap that bounds superposition cost', () => {
    // The one bound whose value is load-bearing for performance (O(samples × doses)).
    expect(clampInput(100_000, INPUT_LIMITS.doseCount)).toBe(200);
    expect(INPUT_LIMITS.doseCount.min).toBe(1);
  });
});
