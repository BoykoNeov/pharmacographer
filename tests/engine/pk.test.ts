import { describe, expect, it } from 'vitest';
import {
  accumulationRatio,
  cavgSteadyState,
  clearance,
  initialConcentration2c,
  singleDoseAuc,
  singleDoseAuc2c,
  steadyStateIvBolus,
  terminalRate2c,
  timeToPeak,
} from '../../src/engine/pk.ts';
import { concentrationCurve, recurringDoses } from '../../src/engine/dosing.ts';
import { singleDoseConcentration } from '../../src/engine/models.ts';
import { singleDose2cConcentration } from '../../src/engine/models2c.ts';
import type { PkParams, TwoCompParams } from '../../src/engine/types.ts';

/**
 * The closed forms are validated against numeric / simulated oracles, not each
 * other (handoff §10): Tmax against a grid-search of the curve's peak, AUC
 * against a trapezoid integral, and the steady-state Cmax/Cmin/Cavg against a
 * superposition simulation run out to many doses.
 */

/** Composite trapezoidal integral of `f` over [t0, t1] with `steps` panels. */
function trapezoid(f: (t: number) => number, t0: number, t1: number, steps: number): number {
  const dt = (t1 - t0) / steps;
  let sum = 0.5 * (f(t0) + f(t1));
  for (let i = 1; i < steps; i++) {
    sum += f(t0 + i * dt);
  }
  return sum * dt;
}

/** Grid-search the time of peak concentration (numeric Tmax oracle). */
function numericPeakTime(f: (t: number) => number, tEnd: number, steps: number): number {
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

describe('timeToPeak (oral Tmax)', () => {
  it('matches the numeric peak time of the Bateman curve', () => {
    const params: PkParams = { vd: 30, ke: 0.17, ka: 1.1, F: 0.8 };
    const curve = (t: number) => singleDoseConcentration('oral', params, 250, t);
    const analytic = timeToPeak(params);
    const numeric = numericPeakTime(curve, 4 * analytic, 200_000);
    expectRelClose(numeric, analytic, 1e-4);
  });

  it('flip-flop limit: ka = ke gives a finite Tmax = 1/ke, matching the limit curve peak', () => {
    const params: PkParams = { vd: 20, ke: 0.25, ka: 0.25, F: 0.9 };
    const tmax = timeToPeak(params);
    expect(Number.isFinite(tmax)).toBe(true);
    expect(tmax).toBeCloseTo(1 / params.ke, 12);
    const curve = (t: number) => singleDoseConcentration('oral', params, 100, t);
    const numeric = numericPeakTime(curve, 4 / params.ke, 200_000);
    expectRelClose(numeric, tmax, 1e-4);
  });

  it('throws when ka is missing', () => {
    expect(() => timeToPeak({ vd: 30, ke: 0.17 })).toThrow(/ka/);
  });
});

describe('singleDoseAuc (AUC₀→∞)', () => {
  it('equals the numeric trapezoid AUC of the oral single-dose curve', () => {
    const params: PkParams = { vd: 30, ke: 0.17, ka: 1.1, F: 0.8 };
    const dose = 250;
    const curve = (t: number) => singleDoseConcentration('oral', params, dose, t);
    const halfLife = Math.LN2 / params.ke;
    const numeric = trapezoid(curve, 0, 30 * halfLife, 300_000);
    expectRelClose(singleDoseAuc(params, dose), numeric, 1e-4);
  });

  it('equals the numeric trapezoid AUC of the IV bolus curve (F = 1)', () => {
    const params: PkParams = { vd: 50, ke: Math.LN2 / 3 };
    const dose = 500;
    const curve = (t: number) => singleDoseConcentration('iv_bolus', params, dose, t);
    const halfLife = Math.LN2 / params.ke;
    const numeric = trapezoid(curve, 0, 25 * halfLife, 300_000);
    expectRelClose(singleDoseAuc(params, dose), numeric, 1e-4);
  });
});

describe('clearance', () => {
  it('CL = ke·Vd', () => {
    const params: PkParams = { vd: 42, ke: 0.3 };
    expect(clearance(params)).toBeCloseTo(0.3 * 42, 12);
  });
});

describe('accumulationRatio', () => {
  it('R = 1 / (1 − e^(−ke·τ))', () => {
    const ke = 0.1;
    const tau = 8;
    expect(accumulationRatio(ke, tau)).toBeCloseTo(1 / (1 - Math.exp(-ke * tau)), 12);
  });

  it('approaches 1 as τ ≫ t½ and grows as τ → 0', () => {
    const ke = Math.LN2 / 4; // t½ = 4 h
    expect(accumulationRatio(ke, 1000)).toBeCloseTo(1, 6);
    expect(accumulationRatio(ke, 0.01)).toBeGreaterThan(50);
  });
});

describe('steadyStateIvBolus — closed forms vs superposition simulation', () => {
  const params: PkParams = { vd: 10, ke: Math.LN2 / 6 }; // t½ = 6 h
  const dose = 100;
  const tau = 8;
  const N = 300; // many doses → residual from "before dose 0" is e^(−ke·Nτ) ≈ 0
  const schedule = recurringDoses({ amount: dose, count: N, interval: tau });
  const lastDoseTime = (N - 1) * tau;
  const closed = steadyStateIvBolus(params, dose, tau);

  it('Cmax,ss (at a dose instant, deep into the course) → (D/Vd)·R', () => {
    const simulated = concentrationCurve('iv_bolus', params, schedule, [lastDoseTime])[0]!;
    expectRelClose(simulated, closed.cmax, 1e-9);
  });

  it('Cmin,ss (one interval after the last dose) → Cmax,ss·e^(−ke·τ)', () => {
    const simulated = concentrationCurve('iv_bolus', params, schedule, [lastDoseTime + tau])[0]!;
    expectRelClose(simulated, closed.cmin, 1e-9);
  });

  it('Cavg,ss (interval-average at steady state) → F·D/(CL·τ)', () => {
    // Trapezoid the simulated curve over one steady-state interval, /τ.
    const curve = (t: number) => concentrationCurve('iv_bolus', params, schedule, [t])[0]!;
    const intervalAuc = trapezoid(curve, lastDoseTime, lastDoseTime + tau, 5000);
    expectRelClose(intervalAuc / tau, closed.cavg, 1e-4);
  });

  it('Cavg,ss equals the single-dose AUC spread over one interval', () => {
    expect(cavgSteadyState(params, dose, tau)).toBeCloseTo(singleDoseAuc(params, dose) / tau, 12);
  });
});

describe('two-compartment closed forms (handoff §12)', () => {
  const model: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };
  const dose = 100;

  it('initialConcentration2c = D/Vc matches C(0) of the bolus curve', () => {
    expect(initialConcentration2c(model, dose)).toBeCloseTo(
      singleDose2cConcentration('iv_bolus', model, dose, 0),
      12,
    );
    expect(initialConcentration2c(model, dose)).toBeCloseTo(dose / model.vc, 12);
  });

  it('singleDoseAuc2c = D/CL equals the numeric trapezoid AUC of the bolus curve', () => {
    const curve = (t: number) => singleDose2cConcentration('iv_bolus', model, dose, t);
    const terminalHalfLife = Math.LN2 / terminalRate2c(model);
    const numeric = trapezoid(curve, 0, 30 * terminalHalfLife, 400_000);
    expectRelClose(singleDoseAuc2c(model, dose), numeric, 1e-4);
    expect(singleDoseAuc2c(model, dose)).toBeCloseTo(dose / model.cl, 12);
  });

  it('terminalRate2c (β) matches the terminal log-slope of the bolus curve', () => {
    const beta = terminalRate2c(model);
    const curve = (t: number) => singleDose2cConcentration('iv_bolus', model, dose, t);
    const slope = (Math.log(curve(45)) - Math.log(curve(40))) / (45 - 40);
    expect(-slope).toBeCloseTo(beta, 6);
    expect(beta).toBeLessThan(model.cl / model.vc); // β < k10 (peripheral return slows terminal)
  });
});
