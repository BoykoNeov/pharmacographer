import { describe, expect, it } from 'vitest';
import {
  batemanMode,
  infusionMetaboliteConcentrationCurve,
  infusionMetaboliteConcentrationFromModes,
  metabolite2cConcentrationCurve,
  metaboliteConcentrationCurve,
  oralMetaboliteConcentrationCurve,
  oralMetaboliteConcentrationFromModes,
  singleDose2cMetaboliteConcentration,
  singleDoseMetaboliteConcentration,
} from '../../src/engine/metabolite.ts';
import { infusionConcentrationFromModes, oralConcentrationFromModes } from '../../src/engine/modes.ts';
import { FLIP_FLOP_REL_TOL } from '../../src/engine/models.ts';
import { twoCompModes, twoCompRates } from '../../src/engine/models2c.ts';
import { threeCompModes } from '../../src/engine/models3c.ts';
import type {
  ExpMode,
  MetaboliteDisposition,
  MetaboliteParams,
  ThreeCompParams,
  TwoCompParams,
} from '../../src/engine/types.ts';

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

/**
 * Two-compartment parent → metabolite (handoff §12 multi-compartment extension).
 * The parent central concentration is bi-exponential (α, β), so the metabolite is
 * a 3-exponential curve. The load-bearing subtlety proven here: the formation
 * amplitude carries the parent CLEARANCE (via k10), NOT the mode rates α/β — so
 * (1) the total exposure `AUC_m = fm·D/(k_m·Vd_m)` is STILL independent of the
 * parent's disposition, exactly as in one compartment, and (2) the `Q → 0`
 * collapse reproduces the one-compartment Bateman metabolite exactly.
 */
describe('two-compartment parent → metabolite', () => {
  const parent: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 }; // α≈1.866, β≈0.134
  const meta: MetaboliteDisposition = { vdM: 30, keM: 0.15, fractionFormed: 0.5 };
  const dose = 250;
  const curve = (tau: number) => singleDose2cMetaboliteConcentration(parent, meta, dose, tau);

  it('C_m(0) = 0 (no metabolite has formed yet)', () => {
    expect(curve(0)).toBe(0);
  });

  it('contributes nothing before the parent dose (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });

  it('numeric AUC_0→∞ ≈ fm·D / (k_m·Vd_m) — independent of parent disposition', () => {
    const halfLifeSlow = Math.LN2 / meta.keM;
    const auc = trapezoid(curve, 40 * halfLifeSlow, 400_000);
    expectRelClose(auc, (meta.fractionFormed * dose) / (meta.keM * meta.vdM), 1e-4);
  });

  it('terminal slope → −β when the metabolite clears faster (formation-rate-limited)', () => {
    const { beta } = twoCompRates(parent); // ≈ 0.134
    const fast: MetaboliteDisposition = { vdM: 30, keM: 0.6, fractionFormed: 0.5 }; // k_m ≫ β
    const c = (tau: number) => singleDose2cMetaboliteConcentration(parent, fast, dose, tau);
    const slope = (Math.log(c(65)) - Math.log(c(60))) / (65 - 60);
    expect(slope).toBeCloseTo(-Math.min(beta, fast.keM), 5); // → −β
  });

  it('terminal slope → −k_m when the metabolite clears slower (elimination-rate-limited)', () => {
    const { beta } = twoCompRates(parent); // ≈ 0.134
    const slow: MetaboliteDisposition = { vdM: 30, keM: 0.03, fractionFormed: 0.5 }; // k_m ≪ β
    const c = (tau: number) => singleDose2cMetaboliteConcentration(parent, slow, dose, tau);
    const slope = (Math.log(c(200)) - Math.log(c(180))) / (200 - 180);
    expect(slope).toBeCloseTo(-Math.min(beta, slow.keM), 5); // → −k_m
  });
});

describe('two-compartment metabolite collapses to the one-compartment Bateman (Q → 0)', () => {
  // No inter-compartmental transfer ⇒ the 2-comp parent IS one compartment with
  // ke = CL/Vc, so its metabolite must match the original spike's Bateman.
  const vdP = 15;
  const keParent = 0.4;
  const parent: TwoCompParams = { vc: vdP, cl: keParent * vdP, q: 0, vp: 25 };
  const meta: MetaboliteDisposition = { vdM: 30, keM: 0.15, fractionFormed: 0.6 };
  const oneComp: MetaboliteParams = { ...meta, keParent };
  const dose = 200;

  it('matches singleDoseMetaboliteConcentration exactly', () => {
    for (const tau of [0, 0.5, 2, 5, 10, 25, 50]) {
      expect(singleDose2cMetaboliteConcentration(parent, meta, dose, tau)).toBeCloseTo(
        singleDoseMetaboliteConcentration(oneComp, dose, tau),
        12,
      );
    }
  });
});

describe('two-compartment metabolite superposition', () => {
  const parent: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };
  const meta: MetaboliteDisposition = { vdM: 35, keM: 0.25, fractionFormed: 0.4 };

  it('a single-dose schedule reproduces the single-dose curve', () => {
    const dose = 300;
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = metabolite2cConcentrationCurve(parent, meta, [{ time: 0, amount: dose }], grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        singleDose2cMetaboliteConcentration(parent, meta, dose, grid[i]!),
        12,
      );
    }
  });

  it('an empty schedule yields all zeros', () => {
    expect(metabolite2cConcentrationCurve(parent, meta, [], [0, 1, 2])).toEqual([0, 0, 0]);
  });
});

/**
 * ORAL parent → metabolite (the residue-form generalisation). An oral parent's
 * central concentration is a sum of Bateman terms, re-expressed as plain exponential
 * modes over {ka, λ…}; those feed the same metabolite core the IV cases use. Oracles:
 * `C_m(0) = 0`; total exposure `AUC_m = fm·F·D/(k_m·Vd_m)` (CL and the (λ−ka) factors
 * cancel — only F remains); an independent RK4 integration of the defining ODE
 * `dA_m/dt = fm·CL·C_p(t) − k_m·A_m` (driving C_p from the engine's oral parent curve)
 * matches the analytic curve — the check that catches residue-coefficient SIGN errors
 * the scalar AUC cannot; collapse ka→∞ reproduces the IV-bolus metabolite and Q→0
 * reproduces the lower-compartment oral metabolite; superposition; and the refusal at
 * ka ≈ λ. Engine capability only — no shipped compound has an oral parent with a
 * metabolite (diazepam is IV-only), so these params are synthetic.
 */
describe('oral parent → metabolite (residue form)', () => {
  /** The one-compartment disposition as a single per-unit-dose mode (g = 1/Vd at ke). */
  const oneCompModes = (vd: number, ke: number): ExpMode[] => [{ coef: 1 / vd, rate: ke }];

  const meta: MetaboliteDisposition = { vdM: 30, keM: 0.15, fractionFormed: 0.5 };
  const dose = 250;

  it('C_m(0) = 0 and nothing before the dose (tau < 0 → 0)', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    expect(oralMetaboliteConcentrationFromModes(modes, 5, 1.2, 0.9, meta, dose, 0)).toBe(0);
    expect(oralMetaboliteConcentrationFromModes(modes, 5, 1.2, 0.9, meta, dose, -1)).toBe(0);
  });

  it('AUC_0→∞ ≈ fm·F·D/(k_m·Vd_m) for a 1-, 2- and 3-compartment oral parent', () => {
    const F = 0.8;
    const ka = 1.1;
    const expected = (meta.fractionFormed * F * dose) / (meta.keM * meta.vdM);
    const cases: { label: string; modes: ExpMode[]; cl: number }[] = [
      { label: '1c', modes: oneCompModes(15, 0.4), cl: 0.4 * 15 },
      { label: '2c', modes: twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1), cl: 5 },
      {
        label: '3c',
        modes: threeCompModes({ vc: 10, cl: 5, q2: 10, vp2: 20, q3: 2, vp3: 40 }, 1),
        cl: 5,
      },
    ];
    for (const { modes, cl } of cases) {
      const curve = (tau: number) =>
        oralMetaboliteConcentrationFromModes(modes, cl, ka, F, meta, dose, tau);
      // Size the horizon on the SLOWEST exponential in play — the metabolite k_m or a
      // slower disposition eigenvalue (the 3-comp γ here is < k_m), else its tail is
      // truncated and the numeric AUC falls short.
      const slowestRate = Math.min(meta.keM, ...modes.map((m) => m.rate).filter((r) => r > 0));
      const auc = trapezoid(curve, 40 * (Math.LN2 / slowestRate), 400_000);
      expectRelClose(auc, expected, 1e-3);
    }
  });

  it('matches an independent RK4 integration of dA_m/dt = fm·CL·C_p(t) − k_m·A_m', () => {
    // De-risks the residue-coefficient SIGN (the AUC pins only a scalar): integrate the
    // defining ODE with C_p driven by the engine's own oral parent curve, compare to the
    // analytic metabolite. A flipped residue sign integrates to the same AUC but fails here.
    const parent: TwoCompParams = { vc: 12, cl: 4, q: 8, vp: 30 };
    const modes = twoCompModes(parent, 1);
    const F = 0.75;
    const ka = 0.9;
    const cp = (t: number) => oralConcentrationFromModes(modes, ka, F, dose, t);
    const rk4AmountAt = (target: number, steps: number): number => {
      const h = target / steps;
      let a = 0;
      const deriv = (t: number, av: number) => meta.fractionFormed * parent.cl * cp(t) - meta.keM * av;
      for (let i = 0; i < steps; i++) {
        const t = i * h;
        const k1 = deriv(t, a);
        const k2 = deriv(t + h / 2, a + (h / 2) * k1);
        const k3 = deriv(t + h / 2, a + (h / 2) * k2);
        const k4 = deriv(t + h, a + h * k3);
        a += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      }
      return a;
    };
    for (const target of [2, 6, 15, 40]) {
      const analytic = oralMetaboliteConcentrationFromModes(modes, parent.cl, ka, F, meta, dose, target);
      const rk4 = rk4AmountAt(target, 40_000) / meta.vdM;
      expectRelClose(rk4, analytic, 1e-4);
    }
  });

  it('collapses to the IV-bolus metabolite as ka → ∞ (instant absorption, F = 1)', () => {
    const parent: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };
    const modes = twoCompModes(parent, 1);
    const bigKa = 1e6; // absorption effectively instantaneous
    for (const tau of [0.5, 2, 5, 12, 30]) {
      const oral = oralMetaboliteConcentrationFromModes(modes, parent.cl, bigKa, 1, meta, dose, tau);
      const ivBolus = singleDose2cMetaboliteConcentration(parent, meta, dose, tau);
      expectRelClose(oral, ivBolus, 1e-4);
    }
  });

  it('3-comp oral metabolite collapses to the 2-comp oral metabolite as Q3 → 0', () => {
    const F = 0.85;
    const ka = 1.3;
    const twoComp = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    const collapsed: ThreeCompParams = { vc: 10, cl: 5, q2: 10, vp2: 20, q3: 0, vp3: 40 };
    const threeComp = threeCompModes(collapsed, 1);
    for (const tau of [0.5, 2, 5, 12, 30]) {
      expect(
        oralMetaboliteConcentrationFromModes(threeComp, 5, ka, F, meta, dose, tau),
      ).toBeCloseTo(oralMetaboliteConcentrationFromModes(twoComp, 5, ka, F, meta, dose, tau), 9);
    }
  });

  it('2-comp oral metabolite collapses to the 1-comp oral metabolite as Q → 0', () => {
    const F = 0.85;
    const ka = 1.3;
    const vd = 15;
    const ke = 0.4;
    const oneComp = oneCompModes(vd, ke);
    const twoComp = twoCompModes({ vc: vd, cl: ke * vd, q: 0, vp: 25 }, 1);
    for (const tau of [0.5, 2, 5, 12, 30]) {
      expect(
        oralMetaboliteConcentrationFromModes(twoComp, ke * vd, ka, F, meta, dose, tau),
      ).toBeCloseTo(oralMetaboliteConcentrationFromModes(oneComp, ke * vd, ka, F, meta, dose, tau), 9);
    }
  });

  it('superposition: a single-dose schedule reproduces the single-dose curve', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = oralMetaboliteConcentrationCurve(modes, 5, 1.1, 0.9, meta, [{ time: 0, amount: dose }], grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        oralMetaboliteConcentrationFromModes(modes, 5, 1.1, 0.9, meta, dose, grid[i]!),
        12,
      );
    }
  });

  it('an empty schedule yields all zeros', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    expect(oralMetaboliteConcentrationCurve(modes, 5, 1.1, 0.9, meta, [], [0, 1, 2])).toEqual([0, 0, 0]);
  });

  it('refuses when the absorption rate coincides with a disposition eigenvalue (ka ≈ λ)', () => {
    // Set ka exactly to the 1-comp disposition rate ke — the removable double pole.
    const ke = 0.4;
    const modes = oneCompModes(15, ke);
    expect(() => oralMetaboliteConcentrationFromModes(modes, ke * 15, ke, 0.9, meta, dose, 5)).toThrow(
      /coincid|eigenvalue|absorption rate/i,
    );
  });
});

/**
 * IV-INFUSION parent → metabolite (the zero-order-input generalisation). An infused
 * parent's central concentration is a rectangular input window convolved with the
 * disposition; by linearity the metabolite is that same window convolved with the
 * metabolite's unit-bolus Bateman response, so it is a difference of running Bateman
 * areas (one closed form across during and after the infusion). Oracles: `C_m(0) = 0`;
 * total exposure `AUC_m = fm·D/(k_m·Vd_m)` — the SAME as the IV bolus, independent of
 * disposition AND of infusion duration; an independent RK4 integration of the defining
 * ODE `dA_m/dt = fm·CL·C_p(t) − k_m·A_m` (driving C_p from the engine's infusion parent
 * curve, integrated ACROSS the during/after seam) matches the analytic curve — the SIGN
 * check the scalar AUC cannot see; collapse duration→0 reproduces the IV-bolus metabolite
 * and Q→0 reproduces the lower-compartment infusion metabolite; superposition. Engine
 * capability that lights up for a real compound: diazepam→nordiazepam on the IV-infusion
 * route (the 2-comp params below mirror diazepam's shape).
 */
describe('IV-infusion parent → metabolite (zero-order input)', () => {
  /** The one-compartment disposition as a single per-unit-dose mode (g = 1/Vd at ke). */
  const oneCompModes = (vd: number, ke: number): ExpMode[] => [{ coef: 1 / vd, rate: ke }];

  const meta: MetaboliteDisposition = { vdM: 30, keM: 0.15, fractionFormed: 0.5 };
  const dose = 250;
  const duration = 4;

  it('C_m(0) = 0 and nothing before the dose (tau < 0 → 0)', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    expect(infusionMetaboliteConcentrationFromModes(modes, 5, meta, dose, duration, 0)).toBe(0);
    expect(infusionMetaboliteConcentrationFromModes(modes, 5, meta, dose, duration, -1)).toBe(0);
  });

  it('AUC_0→∞ ≈ fm·D/(k_m·Vd_m) for a 1-, 2- and 3-compartment infused parent', () => {
    const expected = (meta.fractionFormed * dose) / (meta.keM * meta.vdM);
    const cases: { label: string; modes: ExpMode[]; cl: number }[] = [
      { label: '1c', modes: oneCompModes(15, 0.4), cl: 0.4 * 15 },
      { label: '2c', modes: twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1), cl: 5 },
      {
        label: '3c',
        modes: threeCompModes({ vc: 10, cl: 5, q2: 10, vp2: 20, q3: 2, vp3: 40 }, 1),
        cl: 5,
      },
    ];
    for (const { modes, cl } of cases) {
      const curve = (tau: number) =>
        infusionMetaboliteConcentrationFromModes(modes, cl, meta, dose, duration, tau);
      const slowestRate = Math.min(meta.keM, ...modes.map((m) => m.rate).filter((r) => r > 0));
      const auc = trapezoid(curve, 40 * (Math.LN2 / slowestRate), 400_000);
      expectRelClose(auc, expected, 1e-3);
    }
  });

  it('AUC is independent of the infusion duration (1 h vs 24 h)', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    const expected = (meta.fractionFormed * dose) / (meta.keM * meta.vdM);
    for (const dur of [1, 24]) {
      const curve = (tau: number) =>
        infusionMetaboliteConcentrationFromModes(modes, 5, meta, dose, dur, tau);
      const auc = trapezoid(curve, 40 * (Math.LN2 / meta.keM), 400_000);
      expectRelClose(auc, expected, 1e-3);
    }
  });

  it('matches an independent RK4 integration of dA_m/dt = fm·CL·C_p(t) − k_m·A_m across the seam', () => {
    // The SIGN / seam check (the AUC pins only a scalar): integrate the defining ODE with
    // C_p driven by the engine's own infusion parent curve — which itself switches form at
    // t = duration — and compare to the analytic metabolite both DURING and AFTER the infusion.
    const parent: TwoCompParams = { vc: 12, cl: 4, q: 8, vp: 30 };
    const modes = twoCompModes(parent, 1);
    const dur = 3;
    const r0 = dose / dur;
    const cp = (t: number) => infusionConcentrationFromModes(modes, r0, dur, t);
    const rk4AmountAt = (target: number, steps: number): number => {
      const h = target / steps;
      let a = 0;
      const deriv = (t: number, av: number) => meta.fractionFormed * parent.cl * cp(t) - meta.keM * av;
      for (let i = 0; i < steps; i++) {
        const t = i * h;
        const k1 = deriv(t, a);
        const k2 = deriv(t + h / 2, a + (h / 2) * k1);
        const k3 = deriv(t + h / 2, a + (h / 2) * k2);
        const k4 = deriv(t + h, a + h * k3);
        a += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      }
      return a;
    };
    for (const target of [1.5, 3, 8, 20, 45]) {
      // 1.5 is during the infusion, 3 is the exact seam, the rest are after.
      const analytic = infusionMetaboliteConcentrationFromModes(modes, parent.cl, meta, dose, dur, target);
      const rk4 = rk4AmountAt(target, 60_000) / meta.vdM;
      expectRelClose(rk4, analytic, 1e-4);
    }
  });

  it('is continuous at the end-of-infusion seam (t = duration)', () => {
    const modes = twoCompModes({ vc: 12, cl: 4, q: 8, vp: 30 }, 1);
    const dur = 3;
    const eps = 1e-6;
    const before = infusionMetaboliteConcentrationFromModes(modes, 4, meta, dose, dur, dur - eps);
    const after = infusionMetaboliteConcentrationFromModes(modes, 4, meta, dose, dur, dur + eps);
    expectRelClose(after, before, 1e-4);
  });

  it('collapses to the IV-bolus metabolite as duration → 0 (instant delivery)', () => {
    const parent: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };
    const modes = twoCompModes(parent, 1);
    const tinyDur = 1e-5; // delivery effectively instantaneous
    for (const tau of [0.5, 2, 5, 12, 30]) {
      const infusion = infusionMetaboliteConcentrationFromModes(modes, parent.cl, meta, dose, tinyDur, tau);
      const ivBolus = singleDose2cMetaboliteConcentration(parent, meta, dose, tau);
      expectRelClose(infusion, ivBolus, 1e-3);
    }
  });

  it('3-comp infusion metabolite collapses to the 2-comp infusion metabolite as Q3 → 0', () => {
    const twoComp = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    const collapsed: ThreeCompParams = { vc: 10, cl: 5, q2: 10, vp2: 20, q3: 0, vp3: 40 };
    const threeComp = threeCompModes(collapsed, 1);
    for (const tau of [0.5, 2, 5, 12, 30]) {
      expect(
        infusionMetaboliteConcentrationFromModes(threeComp, 5, meta, dose, duration, tau),
      ).toBeCloseTo(infusionMetaboliteConcentrationFromModes(twoComp, 5, meta, dose, duration, tau), 9);
    }
  });

  it('2-comp infusion metabolite collapses to the 1-comp infusion metabolite as Q → 0', () => {
    const vd = 15;
    const ke = 0.4;
    const oneComp = oneCompModes(vd, ke);
    const twoComp = twoCompModes({ vc: vd, cl: ke * vd, q: 0, vp: 25 }, 1);
    for (const tau of [0.5, 2, 5, 12, 30]) {
      expect(
        infusionMetaboliteConcentrationFromModes(twoComp, ke * vd, meta, dose, duration, tau),
      ).toBeCloseTo(infusionMetaboliteConcentrationFromModes(oneComp, ke * vd, meta, dose, duration, tau), 9);
    }
  });

  it('superposition: a single-dose schedule reproduces the single-dose curve', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = infusionMetaboliteConcentrationCurve(modes, 5, meta, [{ time: 0, amount: dose }], duration, grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        infusionMetaboliteConcentrationFromModes(modes, 5, meta, dose, duration, grid[i]!),
        12,
      );
    }
  });

  it('an empty schedule yields all zeros', () => {
    const modes = twoCompModes({ vc: 10, cl: 5, q: 10, vp: 20 }, 1);
    expect(infusionMetaboliteConcentrationCurve(modes, 5, meta, [], duration, [0, 1, 2])).toEqual([0, 0, 0]);
  });
});

describe('batemanMode building block', () => {
  it('is zero at tau = 0 and before', () => {
    expect(batemanMode(5, 0.4, 0.1, 0)).toBe(0);
    expect(batemanMode(5, 0.4, 0.1, -1) === 0 || Number.isFinite(batemanMode(5, 0.4, 0.1, -1))).toBe(
      true,
    );
  });

  it('uses the finite equal-rates limit when inputRate ≈ elimRate', () => {
    const k = 0.3;
    const amp = 2.5;
    const limit = (tau: number) => amp * tau * Math.exp(-k * tau);
    const c = batemanMode(amp, k * (1 + FLIP_FLOP_REL_TOL / 10), k, 4);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeCloseTo(limit(4), 6);
  });
});
