import { describe, expect, it } from 'vitest';
import { FLIP_FLOP_REL_TOL, singleDoseConcentration } from '../../src/engine/models.ts';
import type { PkParams } from '../../src/engine/types.ts';

/**
 * Engine correctness is proven against closed-form analytic answers, not golden
 * snapshots (handoff §10). Total exposure (AUC_0→∞) has no elementary partial
 * sum, so it is checked numerically: a composite-trapezoid integral on a fine
 * grid run out to many half-lives (truncation residual ≪ tolerance) must match
 * the analytic `F·D / (Vd·ke)`.
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

describe('iv_bolus single dose', () => {
  const params: PkParams = { vd: 50, ke: Math.LN2 / 3 }; // t½ = 3 h
  const dose = 500;
  const curve = (tau: number) => singleDoseConcentration('iv_bolus', params, dose, tau);

  it('C(0) = D / Vd (whole dose in the central compartment instantly)', () => {
    expect(curve(0)).toBeCloseTo(dose / params.vd, 12);
  });

  it('C(t½) = C(0) / 2', () => {
    const halfLife = Math.LN2 / params.ke;
    expect(curve(halfLife)).toBeCloseTo(curve(0) / 2, 12);
  });

  it('numeric AUC_0→∞ ≈ D / (Vd·ke)', () => {
    const halfLife = Math.LN2 / params.ke;
    const auc = trapezoid(curve, 25 * halfLife, 200_000);
    expectRelClose(auc, dose / (params.vd * params.ke), 1e-4);
  });

  it('contributes nothing before administration (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });
});

describe('oral single dose (Bateman function)', () => {
  const params: PkParams = { vd: 30, ke: 0.17, ka: 1.1, F: 0.8 };
  const dose = 250;
  const curve = (tau: number) => singleDoseConcentration('oral', params, dose, tau);

  it('C(0) = 0 (nothing absorbed yet)', () => {
    expect(curve(0)).toBe(0);
  });

  it('numeric peak time ≈ ln(ka/ke) / (ka − ke)', () => {
    const ka = params.ka!;
    const analyticTmax = Math.log(ka / params.ke) / (ka - params.ke);
    const tmax = numericTmax(curve, 4 * analyticTmax, 120_000);
    expect(tmax).toBeCloseTo(analyticTmax, 3);
  });

  it('numeric AUC_0→∞ ≈ F·D / (Vd·ke)', () => {
    const halfLife = Math.LN2 / params.ke;
    const auc = trapezoid(curve, 30 * halfLife, 300_000);
    expectRelClose(auc, (params.F! * dose) / (params.vd * params.ke), 1e-4);
  });

  it('contributes nothing before administration (tau < 0 → 0)', () => {
    expect(curve(-0.5)).toBe(0);
  });

  it('throws when ka is missing', () => {
    expect(() => singleDoseConcentration('oral', { vd: 30, ke: 0.17 }, dose, 1)).toThrow(/ka/);
  });
});

describe('oral flip-flop / equal-rates limit (ka ≈ ke)', () => {
  const base = { vd: 20, ke: 0.25, F: 0.9 };
  const dose = 100;

  /** The analytic limit C(t) = (F·D·ke/Vd)·t·e^(−ke·t). */
  const limit = (tau: number) =>
    ((base.F * dose * base.ke) / base.vd) * tau * Math.exp(-base.ke * tau);

  it('ka exactly equal to ke returns finite values matching the limit form', () => {
    const params: PkParams = { ...base, ka: base.ke };
    for (const tau of [0, 0.5, 2, 5, 10, 25]) {
      const c = singleDoseConcentration('oral', params, dose, tau);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeCloseTo(limit(tau), 12);
    }
  });

  it('triggers the limit branch within FLIP_FLOP_REL_TOL', () => {
    const params: PkParams = { ...base, ka: base.ke * (1 + FLIP_FLOP_REL_TOL / 10) };
    const c = singleDoseConcentration('oral', params, dose, 3);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeCloseTo(limit(3), 6);
  });

  it('Bateman just outside the tolerance is continuous with the limit', () => {
    // ka 0.01% above ke uses the full Bateman formula; it must stay close to
    // the limit value (no discontinuity at the branch boundary).
    const params: PkParams = { ...base, ka: base.ke * 1.0001 };
    const c = singleDoseConcentration('oral', params, dose, 3);
    expectRelClose(c, limit(3), 1e-3);
  });
});

describe('iv_infusion single dose (zero-order in, first-order out)', () => {
  const params: PkParams = { vd: 40, ke: 0.2, infusionDuration: 2 };
  const dose = 400; // total amount infused over 2 h → R0 = 200 mg/h
  const curve = (tau: number) => singleDoseConcentration('iv_infusion', params, dose, tau);

  it('C(0) = 0 (concentration builds up from zero)', () => {
    expect(curve(0)).toBe(0);
  });

  it('end-of-infusion C(T) = (R0/(Vd·ke))·(1 − e^(−ke·T))', () => {
    const r0 = dose / params.infusionDuration!;
    const plateau = r0 / (params.vd * params.ke);
    const expected = plateau * (1 - Math.exp(-params.ke * params.infusionDuration!));
    expect(curve(params.infusionDuration!)).toBeCloseTo(expected, 12);
  });

  it('is continuous at t = T (during and post branches agree)', () => {
    const T = params.infusionDuration!;
    expectRelClose(curve(T + 1e-9), curve(T), 1e-6);
  });

  it('numeric AUC_0→∞ ≈ D / (Vd·ke) for total infused dose D', () => {
    const halfLife = Math.LN2 / params.ke;
    const auc = trapezoid(curve, params.infusionDuration! + 25 * halfLife, 300_000);
    expectRelClose(auc, dose / (params.vd * params.ke), 1e-4);
  });

  it('a very short infusion approximates an IV bolus of the same total dose', () => {
    const shortParams: PkParams = { vd: 40, ke: 0.2, infusionDuration: 0.02 };
    const short = singleDoseConcentration('iv_infusion', shortParams, dose, 5);
    const bolus = singleDoseConcentration('iv_bolus', { vd: 40, ke: 0.2 }, dose, 5);
    expectRelClose(short, bolus, 1e-2);
  });

  it('throws when infusionDuration is missing', () => {
    expect(() => singleDoseConcentration('iv_infusion', { vd: 40, ke: 0.2 }, dose, 1)).toThrow(
      /infusion duration/i,
    );
  });
});
