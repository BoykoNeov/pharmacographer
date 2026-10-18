/**
 * The sampling machinery every curve builder shares: the uniform grid, merging in
 * the instants that must be sampled exactly, a readable axis bound, and the
 * argmax that reports the plotted peak.
 */

import type { CurvePoint } from './types.ts';

/** Number of sample points across the time grid (chart resolution). */
export const DEFAULT_SAMPLES = 300;

/**
 * The maximum-concentration point of a sampled curve — the model's predicted
 * Cmax (mg/L) and Tmax (h). Argmax over the grid; exact for IV bolus (peak at
 * the dose instant), infusion (peak at end-of-infusion) and a single oral dose
 * because each builder's `criticalTimes` samples each of those instants precisely. For a
 * multi-dose oral schedule the true peak has no closed form, so this is the
 * grid's best sample (still pinned near each dose's single-dose peak). Empty or
 * all-zero curves yield the first point (t = 0, c = 0).
 */
export function findPeak(points: CurvePoint[]): CurvePoint {
  let peak = points[0] ?? { t: 0, c: 0 };
  for (const p of points) {
    if (p.c > peak.c) peak = p;
  }
  return peak;
}

/** Round up to a "nice" axis bound: 1, 2, 5 × 10ⁿ. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(x)));
  const normalized = x / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** A uniform grid of `samples + 1` times from 0 to `horizonH` inclusive. */
export function sampleGrid(horizonH: number, samples: number): number[] {
  return Array.from({ length: samples + 1 }, (_, i) => (i / samples) * horizonH);
}

/**
 * Merge the uniform grid with a builder's `criticalTimes` marks into one ascending,
 * de-duplicated grid. Recharts draws points in array order, so the result MUST be
 * sorted (an unsorted merge zigzags the line) and free of duplicate x (a dose
 * time landing on a uniform point). The dedupe threshold only removes true
 * coincidences — it is far below `jumpEps`, so a pre-dose mark is always kept.
 */
export function mergeGrid(uniform: number[], marks: number[]): number[] {
  const all = [...uniform, ...marks].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) {
    if (out.length === 0 || t - out[out.length - 1]! > 1e-9) out.push(t);
  }
  return out;
}
