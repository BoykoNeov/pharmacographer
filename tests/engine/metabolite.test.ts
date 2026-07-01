import { describe, expect, it } from 'vitest';
import {
  metaboliteConcentrationCurve,
  singleDoseMetaboliteConcentration,
} from '../../src/engine/metabolite.ts';
import { FLIP_FLOP_REL_TOL } from '../../src/engine/models.ts';
import type { MetaboliteParams } from '../../src/engine/types.ts';

/**
 * Metabolite kinetics are proven against closed-form analytic answers, not golden
 * snapshots (handoff §10). For an IV-bolus parent the metabolite is a Bateman
 * function, so the oracles are: `C_m(0) = 0`; total exposure
 * `AUC_m = fm·D/(k_m·Vd_m)` (independent of the parent rate k_p); the Bateman peak
 * time `ln(k_p/k_m)/(k_p − k_m)`; the `k_p ≈ k_m` flip-flop limit; the terminal
 * log-slope `−min(k_p, k_m)` (formation- vs elimination-rate-limited); and
 * superposition of a single dose reproducing the single-dose curve.
 */

/** Composite trapezoidal integral of `f` over [0, tEnd] with `steps` panels. */
function trapezoid(f: (tau: number) => number, tEnd: number, steps: number): number {
  const dt = tEnd / steps;
  let sum = 0.5 * (f(0) + f(tEnd));
  for (let i = 1; i < steps; i++) {
    sum += f(i * dt);
  }
  return sum * dt;
}

/** Grid-search the time of peak concentration (numeric Tmax oracle). */
function numericTmax(f: (tau: number) => number, tEnd: number, steps: number): number {
  const dt = tEnd / steps;
  let bestT = 0;
  let bestC = f(0);
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;
    const c = f(t);
    if (c > bestC) {
      bestC = c;
      bestT = t;
    }
  }
  return bestT;
}

/** Assert `actual` is within a relative tolerance of `expected`. */
function expectRelClose(actual: number, expected: number, relTol: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
}

describe('single IV-bolus parent dose → metabolite (Bateman)', () => {
  // Elimination-rate-limited: metabolite clears slower than it forms (k_m < k_p).
  const params: MetaboliteParams = { vdM: 40, keM: 0.2, keParent: Math.LN2 / 1, fractionFormed: 0.6 };
  const dose = 500;
  const curve = (tau: number) => singleDoseMetaboliteConcentration(params, dose, tau);

  it('C_m(0) = 0 (no metabolite has formed yet)', () => {
    expect(curve(0)).toBe(0);
  });

  it('contributes nothing before the parent dose (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });

  it('numeric peak time ≈ ln(k_p/k_m) / (k_p − k_m)', () => {
    const { keParent: kp, keM: km } = params;
    const analyticTmax = Math.log(kp / km) / (kp - km);
    const tmax = numericTmax(curve, 6 * analyticTmax, 200_000);
    expect(tmax).toBeCloseTo(analyticTmax, 3);
  });

  it('numeric AUC_0→∞ ≈ fm·D / (k_m·Vd_m)', () => {
    const halfLifeSlow = Math.LN2 / params.keM;
    const auc = trapezoid(curve, 30 * halfLifeSlow, 400_000);
    expectRelClose(auc, (params.fractionFormed * dose) / (params.keM * params.vdM), 1e-4);
  });
});

describe('metabolite AUC is independent of the parent rate k_p', () => {
  // The clean oracle: total metabolite exposure depends only on how much forms
  // (fm·D) and how fast it clears (k_m·Vd_m), NOT on how fast the parent delivers
  // it. Two very different parent rates must give the same AUC.
  const dose = 250;
  const base = { vdM: 30, keM: 0.15, fractionFormed: 0.5 };
  const analyticAuc = (base.fractionFormed * dose) / (base.keM * base.vdM);

  for (const keParent of [0.4, 2.5]) {
    it(`AUC matches fm·D/(k_m·Vd_m) for k_p = ${keParent}/h`, () => {
      const params: MetaboliteParams = { ...base, keParent };
      const curve = (tau: number) => singleDoseMetaboliteConcentration(params, dose, tau);
      const auc = trapezoid(curve, 40 * (Math.LN2 / base.keM), 400_000);
      expectRelClose(auc, analyticAuc, 1e-4);
    });
  }
});

describe('terminal slope = −min(k_p, k_m) (formation- vs elimination-rate-limited)', () => {
  const dose = 100;

  /** Log-slope of the curve between two late times t1 < t2. */
  const logSlope = (f: (t: number) => number, t1: number, t2: number) =>
    (Math.log(f(t2)) - Math.log(f(t1))) / (t2 - t1);

  it('elimination-rate-limited (k_m < k_p): terminal slope → −k_m', () => {
    const params: MetaboliteParams = { vdM: 20, keM: 0.2, keParent: 1.0, fractionFormed: 0.7 };
    const curve = (t: number) => singleDoseMetaboliteConcentration(params, dose, t);
    expect(logSlope(curve, 60, 65)).toBeCloseTo(-params.keM, 6);
  });

  it('formation-rate-limited (k_m > k_p): terminal slope tracks the PARENT, → −k_p', () => {
    const params: MetaboliteParams = { vdM: 20, keM: 1.0, keParent: 0.2, fractionFormed: 0.7 };
    const curve = (t: number) => singleDoseMetaboliteConcentration(params, dose, t);
    expect(logSlope(curve, 60, 65)).toBeCloseTo(-params.keParent, 6);
  });
});

describe('flip-flop / equal-rates limit (k_p ≈ k_m)', () => {
  const base = { vdM: 25, keM: 0.3, fractionFormed: 0.8 };
  const dose = 200;

  /** The analytic limit C_m(t) = (fm·D·k/Vd_m)·t·e^(−k·t) with k = k_m. */
  const limit = (tau: number) =>
    ((base.fractionFormed * dose * base.keM) / base.vdM) * tau * Math.exp(-base.keM * tau);

  it('k_p exactly equal to k_m returns finite values matching the limit form', () => {
    const params: MetaboliteParams = { ...base, keParent: base.keM };
    for (const tau of [0, 0.5, 2, 5, 10, 25]) {
      const c = singleDoseMetaboliteConcentration(params, dose, tau);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeCloseTo(limit(tau), 12);
    }
  });

  it('triggers the limit branch within FLIP_FLOP_REL_TOL', () => {
    const params: MetaboliteParams = { ...base, keParent: base.keM * (1 + FLIP_FLOP_REL_TOL / 10) };
    const c = singleDoseMetaboliteConcentration(params, dose, 3);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeCloseTo(limit(3), 6);
  });

  it('Bateman just outside the tolerance is continuous with the limit', () => {
    const params: MetaboliteParams = { ...base, keParent: base.keM * 1.0001 };
    const c = singleDoseMetaboliteConcentration(params, dose, 3);
    expectRelClose(c, limit(3), 1e-3);
  });
});

describe('superposition over a dose schedule', () => {
  const params: MetaboliteParams = { vdM: 35, keM: 0.25, keParent: 0.9, fractionFormed: 0.4 };

  it('a single-dose schedule reproduces the single-dose curve', () => {
    const dose = 300;
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = metaboliteConcentrationCurve(params, [{ time: 0, amount: dose }], grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        singleDoseMetaboliteConcentration(params, dose, grid[i]!),
        12,
      );
    }
  });

  it('two doses superpose linearly (sum of the two shifted single-dose curves)', () => {
    const grid = [0, 2, 4, 8, 12, 24];
    const doses = [
      { time: 0, amount: 200 },
      { time: 6, amount: 100 },
    ];
    const total = metaboliteConcentrationCurve(params, doses, grid);
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i]!;
      const expected =
        singleDoseMetaboliteConcentration(params, 200, t) +
        singleDoseMetaboliteConcentration(params, 100, t - 6);
      expect(total[i]).toBeCloseTo(expected, 12);
    }
  });

  it('an empty schedule yields all zeros', () => {
    expect(metaboliteConcentrationCurve(params, [], [0, 1, 2])).toEqual([0, 0, 0]);
  });
});
