import { describe, expect, it } from 'vitest';
import {
  concentrationCurve2c,
  singleDose2cConcentration,
  twoCompModes,
  twoCompRates,
} from '../../src/engine/models2c.ts';
import { singleDoseConcentration } from '../../src/engine/models.ts';
import type { PkParams, TwoCompParams } from '../../src/engine/types.ts';

/**
 * Two-compartment correctness is proven against closed-form analytic answers,
 * not golden snapshots (handoff §10, §12). The oracles: `C(0) = D/Vc` (central
 * volume — not the total Vd); `AUC₀→∞ = D/CL` (independent of distribution — a
 * teaching point); the terminal log-slope `−β` (the smaller eigenvalue); the
 * coefficient sum `Σ coef = D/Vc`; infusion continuity and the `R0/CL` plateau;
 * and — the load-bearing regression — the `Q → 0` COLLAPSE to the exact
 * one-compartment curve, tying the new path to the oracle-pinned old one.
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

/** Assert `actual` is within a relative tolerance of `expected`. */
function expectRelClose(actual: number, expected: number, relTol: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
}

// A representative, physically-plausible 2-comp model with well-separated
// eigenvalues: k10 = 0.5, k12 = 1.0, k21 = 0.5 ⇒ α ≈ 1.866/h, β ≈ 0.134/h.
const model: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };

describe('two-compartment eigenvalue solve', () => {
  it('α, β satisfy the sum/product identities (Vieta)', () => {
    const { k10, k12, k21, alpha, beta } = twoCompRates(model);
    expect(alpha).toBeGreaterThan(beta);
    expect(alpha + beta).toBeCloseTo(k10 + k12 + k21, 12);
    expect(alpha * beta).toBeCloseTo(k10 * k21, 12);
  });

  it('k10 = CL/Vc, k12 = Q/Vc, k21 = Q/Vp', () => {
    const { k10, k12, k21 } = twoCompRates(model);
    expect(k10).toBeCloseTo(model.cl / model.vc, 12);
    expect(k12).toBeCloseTo(model.q / model.vc, 12);
    expect(k21).toBeCloseTo(model.q / model.vp, 12);
  });
});

describe('iv_bolus (two-compartment, bi-exponential)', () => {
  const dose = 100;
  const curve = (tau: number) => singleDose2cConcentration('iv_bolus', model, dose, tau);

  it('C(0) = D / Vc (central volume, NOT total Vd)', () => {
    expect(curve(0)).toBeCloseTo(dose / model.vc, 12);
  });

  it('coefficients sum to D/Vc', () => {
    const modes = twoCompModes(model, dose);
    const sum = modes.reduce((s, m) => s + m.coef, 0);
    expect(sum).toBeCloseTo(dose / model.vc, 12);
  });

  it('numeric AUC₀→∞ ≈ D / CL (independent of distribution)', () => {
    const { beta } = twoCompRates(model);
    const terminalHalfLife = Math.LN2 / beta;
    const auc = trapezoid(curve, 30 * terminalHalfLife, 400_000);
    expectRelClose(auc, dose / model.cl, 1e-4);
  });

  it('terminal log-slope → −β (the smaller eigenvalue)', () => {
    const { beta } = twoCompRates(model);
    const t1 = 40;
    const t2 = 45;
    const slope = (Math.log(curve(t2)) - Math.log(curve(t1))) / (t2 - t1);
    expect(slope).toBeCloseTo(-beta, 6);
  });

  it('contributes nothing before administration (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });
});

describe('iv_infusion (two-compartment)', () => {
  const dose = 240; // over 3 h → R0 = 80 mg/h
  const infused: TwoCompParams = { ...model, infusionDuration: 3 };
  const curve = (tau: number) => singleDose2cConcentration('iv_infusion', infused, dose, tau);

  it('C(0) = 0 (builds up from zero)', () => {
    expect(curve(0)).toBe(0);
  });

  it('is continuous at t = T (during and post branches agree)', () => {
    const T = infused.infusionDuration!;
    expectRelClose(curve(T + 1e-9), curve(T), 1e-6);
  });

  it('numeric AUC₀→∞ ≈ D / CL for the total infused dose', () => {
    const { beta } = twoCompRates(model);
    const auc = trapezoid(curve, infused.infusionDuration! + 30 * (Math.LN2 / beta), 400_000);
    expectRelClose(auc, dose / model.cl, 1e-4);
  });

  it('a very long infusion approaches the steady-state plateau R0/CL', () => {
    const r0 = 80;
    const longInfusion: TwoCompParams = { ...model, infusionDuration: 5000 };
    // Sampled deep inside the infusion, well past ~5 terminal half-lives.
    const cSteady = singleDose2cConcentration('iv_infusion', longInfusion, r0 * 5000, 200);
    expectRelClose(cSteady, r0 / model.cl, 1e-3);
  });

  it('a very short infusion approximates a 2-comp IV bolus of the same dose', () => {
    const short: TwoCompParams = { ...model, infusionDuration: 0.01 };
    const cShort = singleDose2cConcentration('iv_infusion', short, dose, 5);
    const cBolus = singleDose2cConcentration('iv_bolus', model, dose, 5);
    expectRelClose(cShort, cBolus, 1e-2);
  });

  it('throws when infusionDuration is missing', () => {
    expect(() => singleDose2cConcentration('iv_infusion', model, dose, 1)).toThrow(
      /infusion duration/i,
    );
  });
});

describe('oral is deferred for the two-compartment model', () => {
  it('throws a clear "deferred" error', () => {
    expect(() => singleDose2cConcentration('oral', model, 100, 1)).toThrow(/oral|deferred/i);
  });
});

describe('collapse to one compartment (Q → 0)', () => {
  // With no inter-compartmental transfer the 2-comp model IS one compartment:
  // Vc plays Vd, k10 = CL/Vc plays ke. The 2-comp path must reproduce the exact
  // one-compartment curve for every route — the regression that ties new to old.
  const vd = 12;
  const ke = 0.25;
  const collapsed: TwoCompParams = { vc: vd, cl: ke * vd, q: 0, vp: 30 };
  const oneComp: PkParams = { vd, ke };
  const dose = 300;
  const grid = [0, 0.25, 1, 2, 4, 8, 16, 32];

  it('β → 0 with a zero-coefficient terminal mode', () => {
    const { alpha, beta } = twoCompRates(collapsed);
    expect(alpha).toBeCloseTo(ke, 12);
    expect(beta).toBeCloseTo(0, 12);
    const modes = twoCompModes(collapsed, dose);
    const terminal = modes.find((m) => m.rate < ke / 2);
    // Either a single mode is returned, or the terminal mode carries no weight.
    expect(terminal === undefined || Math.abs(terminal.coef) < 1e-9).toBe(true);
  });

  it('iv_bolus matches the one-compartment bolus exactly', () => {
    for (const tau of grid) {
      expect(singleDose2cConcentration('iv_bolus', collapsed, dose, tau)).toBeCloseTo(
        singleDoseConcentration('iv_bolus', oneComp, dose, tau),
        12,
      );
    }
  });

  it('iv_infusion matches the one-compartment infusion exactly', () => {
    const T = 2;
    const twoC: TwoCompParams = { ...collapsed, infusionDuration: T };
    const oneC: PkParams = { ...oneComp, infusionDuration: T };
    for (const tau of grid) {
      expect(singleDose2cConcentration('iv_infusion', twoC, dose, tau)).toBeCloseTo(
        singleDoseConcentration('iv_infusion', oneC, dose, tau),
        12,
      );
    }
  });
});

describe('superposition over a dose schedule', () => {
  it('a single-dose schedule reproduces the single-dose curve', () => {
    const dose = 100;
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = concentrationCurve2c('iv_bolus', model, [{ time: 0, amount: dose }], grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        singleDose2cConcentration('iv_bolus', model, dose, grid[i]!),
        12,
      );
    }
  });

  it('two doses superpose linearly', () => {
    const grid = [0, 2, 4, 8, 12, 24];
    const doses = [
      { time: 0, amount: 200 },
      { time: 6, amount: 100 },
    ];
    const total = concentrationCurve2c('iv_bolus', model, doses, grid);
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i]!;
      const expected =
        singleDose2cConcentration('iv_bolus', model, 200, t) +
        singleDose2cConcentration('iv_bolus', model, 100, t - 6);
      expect(total[i]).toBeCloseTo(expected, 12);
    }
  });

  it('an empty schedule yields all zeros', () => {
    expect(concentrationCurve2c('iv_bolus', model, [], [0, 1, 2])).toEqual([0, 0, 0]);
  });
});
