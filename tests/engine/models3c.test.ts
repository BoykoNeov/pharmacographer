import { describe, expect, it } from 'vitest';
import {
  concentrationCurve3c,
  oralPeakTime3c,
  singleDose3cConcentration,
  threeCompModes,
  threeCompRates,
} from '../../src/engine/models3c.ts';
import { singleDose2cConcentration } from '../../src/engine/models2c.ts';
import { singleDoseConcentration } from '../../src/engine/models.ts';
import {
  singleDose2cMetaboliteConcentration,
  singleDose3cMetaboliteConcentration,
  singleDoseMetaboliteConcentration,
} from '../../src/engine/metabolite.ts';
import type {
  MetaboliteDisposition,
  PkParams,
  ThreeCompParams,
  TwoCompParams,
} from '../../src/engine/types.ts';

/**
 * Three-compartment correctness is proven against closed-form analytic answers,
 * not golden snapshots (handoff §10, §12). The oracles mirror the 2-comp suite:
 * `C(0) = D/Vc` (central volume, not total Vd); `AUC₀→∞ = D/CL` (independent of
 * distribution); the terminal log-slope `−γ` (the SMALLEST of the three
 * eigenvalues); the coefficient sum `Σ coef = D/Vc`; infusion continuity and the
 * `R0/CL` plateau; and — the load-bearing regressions written FIRST — the
 * `Q3 → 0` COLLAPSE to the exact two-compartment curve (and metabolite) and the
 * `Q2, Q3 → 0` collapse to the exact one-compartment curve, tying the new cubic
 * path back through the oracle-pinned 2-comp and 1-comp paths.
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

// A representative, physically-plausible 3-comp model with well-separated
// eigenvalues. Central k10 = 0.5; a fast shallow peripheral (k12 = 1.0, k21 = 0.5)
// and a slow deep peripheral (k13 = 0.4, k31 = 0.1) ⇒ roots α ≈ 2.2, β ≈ 0.25,
// γ ≈ 0.045 per hour.
const model: ThreeCompParams = { vc: 10, cl: 5, q2: 10, vp2: 20, q3: 4, vp3: 40 };

describe('three-compartment eigenvalue solve', () => {
  it('α > β > γ, all real and positive', () => {
    const { alpha, beta, gamma } = threeCompRates(model);
    expect(alpha).toBeGreaterThan(beta);
    expect(beta).toBeGreaterThan(gamma);
    expect(gamma).toBeGreaterThan(0);
  });

  it('α, β, γ satisfy the Vieta sum/pair/product identities of the cubic', () => {
    const { k10, k12, k21, k13, k31, alpha, beta, gamma } = threeCompRates(model);
    const e1 = k10 + k12 + k13;
    const e2 = k21;
    const e3 = k31;
    const a2 = e1 + e2 + e3;
    const a1 = e1 * e2 + e1 * e3 + e2 * e3 - k12 * k21 - k13 * k31;
    const a0 = e1 * e2 * e3 - e2 * k13 * k31 - e3 * k12 * k21;
    expect(alpha + beta + gamma).toBeCloseTo(a2, 10);
    expect(alpha * beta + alpha * gamma + beta * gamma).toBeCloseTo(a1, 10);
    expect(alpha * beta * gamma).toBeCloseTo(a0, 10);
  });

  it('each eigenvalue is a root of the characteristic cubic', () => {
    const { k10, k12, k21, k13, k31, alpha, beta, gamma } = threeCompRates(model);
    const e1 = k10 + k12 + k13;
    const a2 = e1 + k21 + k31;
    const a1 = e1 * k21 + e1 * k31 + k21 * k31 - k12 * k21 - k13 * k31;
    const a0 = e1 * k21 * k31 - k21 * k13 * k31 - k31 * k12 * k21;
    const p = (x: number): number => ((x - a2) * x + a1) * x - a0;
    for (const root of [alpha, beta, gamma]) {
      expect(Math.abs(p(root))).toBeLessThan(1e-9);
    }
  });

  it('micro-rate constants: k10=CL/Vc, k12=Q2/Vc, k21=Q2/Vp2, k13=Q3/Vc, k31=Q3/Vp3', () => {
    const { k10, k12, k21, k13, k31 } = threeCompRates(model);
    expect(k10).toBeCloseTo(model.cl / model.vc, 12);
    expect(k12).toBeCloseTo(model.q2 / model.vc, 12);
    expect(k21).toBeCloseTo(model.q2 / model.vp2, 12);
    expect(k13).toBeCloseTo(model.q3 / model.vc, 12);
    expect(k31).toBeCloseTo(model.q3 / model.vp3, 12);
  });
});

describe('iv_bolus (three-compartment, tri-exponential)', () => {
  const dose = 100;
  const curve = (tau: number) => singleDose3cConcentration('iv_bolus', model, dose, tau);

  it('C(0) = D / Vc (central volume, NOT total Vd)', () => {
    expect(curve(0)).toBeCloseTo(dose / model.vc, 12);
  });

  it('coefficients sum to D/Vc (the Σg = 1/Vc residue identity)', () => {
    const modes = threeCompModes(model, dose);
    const sum = modes.reduce((s, m) => s + m.coef, 0);
    expect(sum).toBeCloseTo(dose / model.vc, 12);
  });

  it('resolves to three exponential modes for a non-degenerate model', () => {
    expect(threeCompModes(model, dose)).toHaveLength(3);
  });

  it('numeric AUC₀→∞ ≈ D / CL (independent of distribution)', () => {
    const { gamma } = threeCompRates(model);
    const terminalHalfLife = Math.LN2 / gamma;
    const auc = trapezoid(curve, 30 * terminalHalfLife, 600_000);
    expectRelClose(auc, dose / model.cl, 1e-4);
  });

  it('terminal log-slope → −γ (the SMALLEST eigenvalue)', () => {
    const { gamma } = threeCompRates(model);
    const t1 = 180;
    const t2 = 200;
    const slope = (Math.log(curve(t2)) - Math.log(curve(t1))) / (t2 - t1);
    expect(slope).toBeCloseTo(-gamma, 6);
  });

  it('contributes nothing before administration (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });
});

describe('iv_bolus matches a direct RK4 integration of the compartment ODEs', () => {
  // The analytic curve's oracles (C(0)=D/Vc, AUC=D/CL, terminal=−γ) pin the
  // trace a₂ and the product a₀, but NOT the middle cubic coefficient a₁ — the
  // one carrying the three-compartment coupling. Vieta/"root of the cubic" checks
  // are circular (they confirm the solver found roots of the polynomial we wrote,
  // not that the polynomial is the true characteristic one). So we close the loop
  // by integrating the DEFINING three-compartment amount ODEs numerically and
  // matching A1(t)/Vc — a reference-model cross-check (like the numeric-AUC
  // trapezoid) that bypasses the coefficient algebra, residues, and root-finder
  // entirely:
  //
  //   dA1/dt = −(k10+k12+k13)·A1 + k21·A2 + k31·A3   A1(0) = D
  //   dA2/dt =  k12·A1 − k21·A2                        A2(0) = 0
  //   dA3/dt =  k13·A1 − k31·A3                        A3(0) = 0,   C = A1/Vc
  //
  // The micro-rate constants are taken straight from the params (k10 = CL/Vc, …),
  // NOT from any cubic term, so a sign/index error in a₀/a₁/a₂ or the residues
  // would surface here even though every other test stays green.

  /** A1(t)/Vc at each `times` value, by fixed-step RK4 on the amount ODEs. */
  function rk4CentralConcentration(dose: number, times: number[], dt: number): number[] {
    const k10 = model.cl / model.vc;
    const k12 = model.q2 / model.vc;
    const k21 = model.q2 / model.vp2;
    const k13 = model.q3 / model.vc;
    const k31 = model.q3 / model.vp3;
    const deriv = ([a1, a2, a3]: number[]): number[] => [
      -(k10 + k12 + k13) * a1! + k21 * a2! + k31 * a3!,
      k12 * a1! - k21 * a2!,
      k13 * a1! - k31 * a3!,
    ];
    const add = (u: number[], v: number[], s: number): number[] => u.map((x, i) => x + s * v[i]!);

    const targetSteps = times.map((t) => Math.round(t / dt));
    const out: number[] = [];
    let state = [dose, 0, 0];
    let next = 0;
    for (let step = 0; step <= targetSteps[targetSteps.length - 1]!; step++) {
      while (next < targetSteps.length && step === targetSteps[next]) {
        out.push(state[0]! / model.vc);
        next++;
      }
      const k1 = deriv(state);
      const k2 = deriv(add(state, k1, 0.5 * dt));
      const k3 = deriv(add(state, k2, 0.5 * dt));
      const k4 = deriv(add(state, k3, dt));
      state = state.map((x, i) => x + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
    }
    return out;
  }

  it('the analytic tri-exponential agrees with the numerically-integrated ODEs', () => {
    const dose = 100;
    const times = [0.25, 0.5, 1, 2, 4, 8, 12];
    const numeric = rk4CentralConcentration(dose, times, 1e-3);
    for (let i = 0; i < times.length; i++) {
      expectRelClose(
        singleDose3cConcentration('iv_bolus', model, dose, times[i]!),
        numeric[i]!,
        1e-4,
      );
    }
  });
});

describe('iv_infusion (three-compartment)', () => {
  const dose = 240; // over 3 h → R0 = 80 mg/h
  const infused: ThreeCompParams = { ...model, infusionDuration: 3 };
  const curve = (tau: number) => singleDose3cConcentration('iv_infusion', infused, dose, tau);

  it('C(0) = 0 (builds up from zero)', () => {
    expect(curve(0)).toBe(0);
  });

  it('is continuous at t = T (during and post branches agree)', () => {
    const T = infused.infusionDuration!;
    expectRelClose(curve(T + 1e-9), curve(T), 1e-6);
  });

  it('numeric AUC₀→∞ ≈ D / CL for the total infused dose', () => {
    const { gamma } = threeCompRates(model);
    const auc = trapezoid(curve, infused.infusionDuration! + 30 * (Math.LN2 / gamma), 600_000);
    expectRelClose(auc, dose / model.cl, 1e-4);
  });

  it('a very long infusion approaches the steady-state plateau R0/CL', () => {
    const r0 = 80;
    const longInfusion: ThreeCompParams = { ...model, infusionDuration: 5000 };
    const cSteady = singleDose3cConcentration('iv_infusion', longInfusion, r0 * 5000, 400);
    expectRelClose(cSteady, r0 / model.cl, 1e-3);
  });

  it('a very short infusion approximates a 3-comp IV bolus of the same dose', () => {
    const short: ThreeCompParams = { ...model, infusionDuration: 0.01 };
    const cShort = singleDose3cConcentration('iv_infusion', short, dose, 5);
    const cBolus = singleDose3cConcentration('iv_bolus', model, dose, 5);
    expectRelClose(cShort, cBolus, 1e-2);
  });

  it('throws when infusionDuration is missing', () => {
    expect(() => singleDose3cConcentration('iv_infusion', model, dose, 1)).toThrow(
      /infusion duration/i,
    );
  });
});

describe('oral (three-compartment, four-exponential)', () => {
  const dose = 100;
  // ka between γ and α, clear of all three disposition rates.
  const oralModel: ThreeCompParams = { ...model, ka: 1.5, F: 1 };
  const curve = (tau: number) => singleDose3cConcentration('oral', oralModel, dose, tau);

  it('C(0) = 0 (nothing absorbed yet)', () => {
    expect(curve(0)).toBe(0);
  });

  it('numeric AUC₀→∞ ≈ F·D / CL (absorption reshapes, not the area)', () => {
    const { gamma } = threeCompRates(oralModel);
    const auc = trapezoid(curve, 40 * (Math.LN2 / gamma), 800_000);
    expectRelClose(auc, (oralModel.F! * dose) / oralModel.cl, 1e-3);
  });

  it('terminal log-slope → −min(ka, γ) = −γ (elimination-rate-limited here)', () => {
    const { gamma } = threeCompRates(oralModel);
    const t1 = 180;
    const t2 = 200;
    const slope = (Math.log(curve(t2)) - Math.log(curve(t1))) / (t2 - t1);
    expect(slope).toBeCloseTo(-gamma, 6);
  });

  it('bioavailability F scales the whole curve linearly', () => {
    const half: ThreeCompParams = { ...oralModel, F: 0.5 };
    for (const tau of [0.5, 1, 2, 5, 12]) {
      expect(singleDose3cConcentration('oral', half, dose, tau)).toBeCloseTo(0.5 * curve(tau), 12);
    }
  });

  it('oralPeakTime3c locates the curve maximum (dC/dt = 0)', () => {
    const tmax = oralPeakTime3c(oralModel);
    expect(tmax).toBeGreaterThan(0);
    const cPeak = curve(tmax);
    const eps = 1e-3;
    expect(cPeak).toBeGreaterThanOrEqual(curve(tmax - eps));
    expect(cPeak).toBeGreaterThanOrEqual(curve(tmax + eps));
  });

  it('throws a clear error when ka is missing', () => {
    expect(() => singleDose3cConcentration('oral', model, dose, 1)).toThrow(
      /oral.*absorption rate constant|ka/i,
    );
    expect(() => oralPeakTime3c(model)).toThrow(/ka/i);
  });

  it('contributes nothing before administration (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });
});

describe('collapse to two compartments (Q3 → 0)', () => {
  // With no transfer to the second peripheral the 3-comp model IS the 2-comp
  // model on {Vc, CL, Q2, Vp2}. The cubic path must reproduce the exact bi-
  // exponential 2-comp curve for every route — the primary safety net for the
  // residue/degeneracy math the AUC/C0/terminal oracles cannot see.
  const collapsed: ThreeCompParams = { vc: 10, cl: 5, q2: 10, vp2: 20, q3: 0, vp3: 40 };
  const twoComp: TwoCompParams = { vc: 10, cl: 5, q: 10, vp: 20 };
  const dose = 100;
  const grid = [0, 0.25, 1, 2, 4, 8, 16, 32, 64];

  it('the γ (third) eigenvalue → 0 with a zero-coefficient mode', () => {
    const { gamma } = threeCompRates(collapsed);
    expect(gamma).toBeCloseTo(0, 12);
    const modes = threeCompModes(collapsed, dose);
    const terminal = modes.find((m) => m.rate < 1e-6);
    expect(terminal === undefined || Math.abs(terminal.coef) < 1e-9).toBe(true);
  });

  it('iv_bolus matches the two-compartment bolus exactly', () => {
    for (const tau of grid) {
      expect(singleDose3cConcentration('iv_bolus', collapsed, dose, tau)).toBeCloseTo(
        singleDose2cConcentration('iv_bolus', twoComp, dose, tau),
        12,
      );
    }
  });

  it('iv_infusion matches the two-compartment infusion exactly', () => {
    const T = 2;
    const c3: ThreeCompParams = { ...collapsed, infusionDuration: T };
    const c2: TwoCompParams = { ...twoComp, infusionDuration: T };
    for (const tau of grid) {
      expect(singleDose3cConcentration('iv_infusion', c3, dose, tau)).toBeCloseTo(
        singleDose2cConcentration('iv_infusion', c2, dose, tau),
        12,
      );
    }
  });

  it('oral matches the two-compartment oral curve exactly', () => {
    const ka = 0.9;
    const F = 0.8;
    const c3: ThreeCompParams = { ...collapsed, ka, F };
    const c2: TwoCompParams = { ...twoComp, ka, F };
    for (const tau of grid) {
      expect(singleDose3cConcentration('oral', c3, dose, tau)).toBeCloseTo(
        singleDose2cConcentration('oral', c2, dose, tau),
        12,
      );
    }
  });

  it('the metabolite matches the two-compartment metabolite exactly', () => {
    const meta: MetaboliteDisposition = { vdM: 30, keM: 0.08, fractionFormed: 0.5 };
    for (const tau of grid) {
      expect(singleDose3cMetaboliteConcentration(collapsed, meta, dose, tau)).toBeCloseTo(
        singleDose2cMetaboliteConcentration(twoComp, meta, dose, tau),
        12,
      );
    }
  });
});

describe('collapse to one compartment (Q2, Q3 → 0)', () => {
  // With no peripheral transfer at all the 3-comp model IS one compartment: Vc
  // plays Vd, k10 = CL/Vc plays ke. The cubic degenerates to a double root at 0
  // (two zero-weight modes) plus the single elimination mode — the degeneracy
  // guard must drop the coinciding modes cleanly.
  const vd = 12;
  const ke = 0.25;
  const collapsed: ThreeCompParams = { vc: vd, cl: ke * vd, q2: 0, vp2: 30, q3: 0, vp3: 50 };
  const oneComp: PkParams = { vd, ke };
  const dose = 300;
  const grid = [0, 0.25, 1, 2, 4, 8, 16, 32];

  it('two eigenvalues → 0, leaving a single elimination mode at ke', () => {
    const { alpha, beta, gamma } = threeCompRates(collapsed);
    expect(alpha).toBeCloseTo(ke, 10);
    expect(beta).toBeCloseTo(0, 10);
    expect(gamma).toBeCloseTo(0, 10);
    const modes = threeCompModes(collapsed, dose);
    expect(modes).toHaveLength(1);
    expect(modes[0]!.coef).toBeCloseTo(dose / vd, 12);
    expect(modes[0]!.rate).toBeCloseTo(ke, 10);
  });

  it('iv_bolus matches the one-compartment bolus exactly', () => {
    for (const tau of grid) {
      expect(singleDose3cConcentration('iv_bolus', collapsed, dose, tau)).toBeCloseTo(
        singleDoseConcentration('iv_bolus', oneComp, dose, tau),
        12,
      );
    }
  });

  it('iv_infusion matches the one-compartment infusion exactly', () => {
    const T = 2;
    const c3: ThreeCompParams = { ...collapsed, infusionDuration: T };
    const oneC: PkParams = { ...oneComp, infusionDuration: T };
    for (const tau of grid) {
      expect(singleDose3cConcentration('iv_infusion', c3, dose, tau)).toBeCloseTo(
        singleDoseConcentration('iv_infusion', oneC, dose, tau),
        12,
      );
    }
  });

  it('oral matches the one-compartment oral Bateman exactly', () => {
    const ka = 0.9;
    const F = 0.8;
    const c3: ThreeCompParams = { ...collapsed, ka, F };
    const oneC: PkParams = { ...oneComp, ka, F };
    for (const tau of grid) {
      expect(singleDose3cConcentration('oral', c3, dose, tau)).toBeCloseTo(
        singleDoseConcentration('oral', oneC, dose, tau),
        12,
      );
    }
  });

  it('the metabolite matches the one-compartment metabolite exactly', () => {
    const meta: MetaboliteDisposition = { vdM: 20, keM: 0.1, fractionFormed: 0.4 };
    for (const tau of grid) {
      const oneCompMeta = singleDoseMetaboliteConcentration(
        { vdM: meta.vdM, keM: meta.keM, keParent: ke, fractionFormed: meta.fractionFormed },
        dose,
        tau,
      );
      expect(singleDose3cMetaboliteConcentration(collapsed, meta, dose, tau)).toBeCloseTo(
        oneCompMeta,
        12,
      );
    }
  });
});

describe('metabolite (three-compartment parent) exposure', () => {
  const meta: MetaboliteDisposition = { vdM: 30, keM: 0.08, fractionFormed: 0.5 };
  const dose = 100;
  const curve = (tau: number) => singleDose3cMetaboliteConcentration(model, meta, dose, tau);

  it('C_m(0) = 0 (nothing formed yet)', () => {
    expect(curve(0)).toBe(0);
  });

  it('numeric AUC_m ≈ fm·D / (k_m·Vd_m), independent of the parent distribution', () => {
    const auc = trapezoid(curve, 30 * (Math.LN2 / meta.keM), 800_000);
    expectRelClose(auc, (meta.fractionFormed * dose) / (meta.keM * meta.vdM), 1e-3);
  });

  it('contributes nothing before the parent dose (tau < 0 → 0)', () => {
    expect(curve(-1)).toBe(0);
  });
});

describe('superposition over a dose schedule', () => {
  it('a single-dose schedule reproduces the single-dose curve', () => {
    const dose = 100;
    const grid = [0, 1, 2, 4, 8, 16, 32];
    const viaCurve = concentrationCurve3c('iv_bolus', model, [{ time: 0, amount: dose }], grid);
    for (let i = 0; i < grid.length; i++) {
      expect(viaCurve[i]).toBeCloseTo(
        singleDose3cConcentration('iv_bolus', model, dose, grid[i]!),
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
    const total = concentrationCurve3c('iv_bolus', model, doses, grid);
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i]!;
      const expected =
        singleDose3cConcentration('iv_bolus', model, 200, t) +
        singleDose3cConcentration('iv_bolus', model, 100, t - 6);
      expect(total[i]).toBeCloseTo(expected, 12);
    }
  });

  it('an empty schedule yields all zeros', () => {
    expect(concentrationCurve3c('iv_bolus', model, [], [0, 1, 2])).toEqual([0, 0, 0]);
  });
});
