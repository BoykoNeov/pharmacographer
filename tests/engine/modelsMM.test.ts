import { describe, expect, it } from 'vitest';
import {
  apparentHalfLifeMM,
  firstOrderLimitRateMM,
  infusionSteadyStateMM,
  ivBolusAucMM,
  ivBolusElapsedTime,
  michaelisMentenCurve,
} from '../../src/engine/modelsMM.ts';
import { singleDoseConcentration } from '../../src/engine/models.ts';
import type { MichaelisMentenParams } from '../../src/engine/modelsMM.ts';
import type { PkParams } from '../../src/engine/types.ts';

/**
 * Michaelis–Menten correctness is proven against closed-form analytic answers,
 * not golden snapshots (handoff §10, §12) — even though the curve itself is
 * numerical. `C(t)` has no explicit solution, so the oracles come from what IS
 * analytic:
 *
 * - the IV-bolus IMPLICIT solution `Km·ln(C0/C) + (C0−C) = (Vmax/Vd)·t`, exact in
 *   the `t(C)` direction — the primary anchor, and what calibrates the RK4 step;
 * - the IV-bolus AUC `(Vd/Vmax)·(Km·C0 + C0²/2)`;
 * - the infusion steady state `Css = r0·Km/(Vmax − r0)` (algebraic, so exact);
 * - MASS BALANCE `∫ Vmax·C/(Km+C) dt = F·D`, independent of the AUC identity and
 *   valid for every route — the only oracle oral has beyond a limiting case;
 * - the two LIMITING REGIMES: `Km ≫ C` must reproduce the oracle-pinned linear
 *   curves in `models.ts` exactly (with `ke = Vmax/(Vd·Km)`), tying the new path
 *   to the old one the way the 2-comp `Q → 0` collapse does; `Km ≪ C` must decay
 *   in a straight line at `Vmax/Vd`.
 *
 * And one NEGATIVE oracle that no linear model could pass: superposition must
 * FAIL. That is not a bug being tolerated — it is the property that makes this
 * module necessary, so it is asserted directly.
 */

/** Indexed read that fails loudly rather than yielding `undefined` (strict index access). */
function at(values: number[], i: number): number {
  const v = values.at(i);
  if (v === undefined) throw new Error(`no sample at index ${i} (length ${values.length})`);
  return v;
}

/** Composite trapezoidal integral of sampled values `ys` on a uniform grid. */
function trapezoidSamples(ys: number[], dt: number): number {
  let sum = 0.5 * (at(ys, 0) + at(ys, -1));
  for (let i = 1; i < ys.length - 1; i++) sum += at(ys, i);
  return sum * dt;
}

/** Assert `actual` is within a relative tolerance of `expected`. */
function expectRelClose(actual: number, expected: number, relTol: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
}

/** Uniform grid of `steps + 1` points spanning [0, tEnd]. */
function uniformGrid(tEnd: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => (i * tEnd) / steps);
}

// A representative capacity-limited drug: ke at the C→0 limit is
// Vmax/(Vd·Km) = 100/(50·5) = 0.4/h, so its LINEAR half-life would be ~1.73 h.
// A 1000 mg bolus starts at C0 = 20 mg/L = 4·Km — comfortably saturated — so a
// single fixture exercises the saturated start, the transition through C ≈ Km,
// and the first-order tail as one continuous decline.
const model: MichaelisMentenParams = { vd: 50, vmax: 100, km: 5 };

describe('michaelisMentenCurve — iv_bolus against the exact implicit solution', () => {
  const dose = 1000;
  const c0 = dose / model.vd; // 20 mg/L

  it('C(0) = D/Vd — the whole dose lands in the compartment at once', () => {
    const curve = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: dose }], [0]);
    expectRelClose(at(curve, 0), c0, 1e-12);
  });

  // The primary oracle AND the RK4 step calibration: pick a target concentration,
  // get the exact time it must occur from the implicit solution, and require the
  // integrator to land on it. The targets deliberately straddle every regime —
  // saturated (C ≫ Km), the transition (C ≈ Km, where fixed-step RK4 is weakest
  // because the effective rate is changing fastest), and first-order (C ≪ Km).
  const targets: Array<[label: string, c: number]> = [
    ['saturated, C = 16 mg/L (3.2·Km)', 16],
    ['saturated, C = 10 mg/L (2·Km)', 10],
    ['transition, C = 5 mg/L (= Km)', 5],
    ['transition, C = 2.5 mg/L (Km/2)', 2.5],
    ['first-order tail, C = 0.5 mg/L (Km/10)', 0.5],
    ['deep first-order tail, C = 0.01 mg/L (Km/500)', 0.01],
  ];

  for (const [label, target] of targets) {
    it(`reaches ${label} at the analytic time`, () => {
      const t = ivBolusElapsedTime(model, c0, target);
      const curve = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: dose }], [0, t]);
      expectRelClose(at(curve, 1), target, 1e-6);
    });
  }

  it('AUC₀→∞ = (Vd/Vmax)·(Km·C0 + C0²/2)', () => {
    // Horizon chosen from the implicit solution: the time to fall to 1e-9·C0, so
    // the truncated tail is ~1e-9 of the area and cannot pollute the comparison.
    const tEnd = ivBolusElapsedTime(model, c0, c0 * 1e-9);
    const steps = 20_000;
    const grid = uniformGrid(tEnd, steps);
    const curve = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: dose }], grid);
    const auc = trapezoidSamples(curve, tEnd / steps);
    expectRelClose(auc, ivBolusAucMM(model, dose), 1e-5);
  });

  it('AUC MORE than doubles when the dose doubles — dose-proportionality fails', () => {
    // The signature of saturation, and the reason `linear: false` exists. The
    // closed form makes it exact: the C0²/2 term is superlinear in dose.
    const single = ivBolusAucMM(model, dose);
    const double = ivBolusAucMM(model, 2 * dose);
    expect(double / single).toBeGreaterThan(2);

    // Confirm the integrator agrees with the closed form at the doubled dose,
    // so the superlinearity is a property of the CURVE, not just the algebra.
    const tEnd = ivBolusElapsedTime(model, (2 * dose) / model.vd, 1e-9);
    const steps = 20_000;
    const grid = uniformGrid(tEnd, steps);
    const curve = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: 2 * dose }], grid);
    expectRelClose(trapezoidSamples(curve, tEnd / steps), double, 1e-5);
  });
});

describe('the two limiting regimes', () => {
  it('Km ≫ C collapses onto the exact one-compartment linear curve (all routes)', () => {
    // The tie to the oracle-pinned linear engine, and the MM analogue of the
    // 2-comp `Q → 0` collapse. With Km a million-fold above any concentration
    // reached, `Vmax·C/(Km+C)` linearises to `(Vmax/Km)·C`, i.e. first-order at
    // ke = Vmax/(Vd·Km). Both engines must draw the same curve.
    const ke = 0.2;
    const vd = 50;
    const km = 1e6;
    const linear: PkParams = { vd, ke, ka: 1.0, F: 0.8 };
    const mm: MichaelisMentenParams = { vd, vmax: ke * vd * km, km, ka: 1.0, F: 0.8 };
    expectRelClose(firstOrderLimitRateMM(mm), ke, 1e-12);

    const dose = 100;
    const grid = uniformGrid(24, 240);

    for (const route of ['iv_bolus', 'oral'] as const) {
      const nonlinear = michaelisMentenCurve(route, mm, [{ time: 0, amount: dose }], grid);
      grid.forEach((t, i) => {
        const expected = singleDoseConcentration(route, linear, dose, t);
        // Skip the vanishing tail, where relative comparison is meaningless.
        if (expected < 1e-9) return;
        expectRelClose(at(nonlinear, i), expected, 1e-4);
      });
    }

    // Infusion: the MM path spreads the dose at D/duration, exactly as the linear
    // model's R0 does, so the two must agree there too.
    const duration = 3;
    const infMm = { ...mm, infusionDuration: duration };
    const infLinear = { ...linear, infusionDuration: duration };
    const nonlinear = michaelisMentenCurve('iv_infusion', infMm, [{ time: 0, amount: dose }], grid);
    grid.forEach((t, i) => {
      const expected = singleDoseConcentration('iv_infusion', infLinear, dose, t);
      if (expected < 1e-9) return;
      expectRelClose(at(nonlinear, i), expected, 1e-4);
    });
  });

  it('Km ≪ C decays in a STRAIGHT LINE at Vmax/Vd — zero-order', () => {
    // Ethanol's regime: elimination pinned at Vmax regardless of concentration,
    // so the curve is a ramp, not an exponential. Km is far below the
    // concentrations sampled, so `Vmax·C/(Km+C) → Vmax`.
    const zeroOrder: MichaelisMentenParams = { vd: 50, vmax: 100, km: 1e-4 };
    const dose = 5000; // C0 = 100 mg/L — a million Km
    const slope = zeroOrder.vmax / zeroOrder.vd; // 2 mg/L/h
    const grid = uniformGrid(40, 400);
    const curve = michaelisMentenCurve('iv_bolus', zeroOrder, [{ time: 0, amount: dose }], grid);

    // Straight line C(t) = C0 − (Vmax/Vd)·t while saturation holds.
    grid.forEach((t, i) => {
      const expected = dose / zeroOrder.vd - slope * t;
      if (expected < 1) return; // near extinction the first-order tail takes over
      expectRelClose(at(curve, i), expected, 1e-5);
    });

    // A linear drug's half-life is dose-independent; a zero-order drug's is
    // strictly proportional to dose — the same molecule, twice the half-life.
    const half = apparentHalfLifeMM(zeroOrder, 100);
    const halfAtDouble = apparentHalfLifeMM(zeroOrder, 200);
    expectRelClose(halfAtDouble / half, 2, 1e-3);
  });
});

describe('mass balance — every route eliminates exactly what went in', () => {
  // An oracle wholly independent of the AUC identity: it checks the elimination
  // FLUX rather than the area, and unlike the AUC closed form it holds for oral
  // and infusion too (where no analytic AUC exists — slower input means less
  // saturation, so MM exposure is genuinely route-dependent).
  const dose = 1000;
  const tEnd = 400;
  const steps = 80_000;

  /**
   * `∫₀^tEnd Vmax·C/(Km+C) dt` — the total mass eliminated — by trapezoid on the
   * sampled curve, integrated PIECEWISE between IV-bolus doses.
   *
   * An IV bolus steps the concentration, so the elimination flux is genuinely
   * discontinuous at a dose instant, and a trapezoid panel straddling that jump
   * over-counts by ~½·dt·Δflux however fine the grid is (an O(dt) error, not the
   * O(dt²) the rest of the panels give). That is a quadrature artefact, not an
   * integrator one, so the fix belongs here: split at every dose, and pull each
   * segment's right endpoint infinitesimally back so it samples the PRE-dose flux
   * (`michaelisMentenCurve` reports the post-dose value at a dose instant, which
   * is the correct LEFT endpoint of the next segment). The 1e-9 h slivers this
   * skips carry ~1e-7 mg in total.
   */
  const eliminated = (
    route: Parameters<typeof michaelisMentenCurve>[0],
    params: MichaelisMentenParams,
    schedule: Array<{ time: number; amount: number }>,
  ): number => {
    const cuts = [...new Set(schedule.map((d) => d.time).filter((t) => t > 0 && t < tEnd))].sort(
      (a, b) => a - b,
    );
    const bounds = [0, ...cuts, tEnd];
    let total = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = at(bounds, i);
      const rawTo = at(bounds, i + 1);
      const to = i === bounds.length - 2 ? rawTo : rawTo - 1e-9;
      const n = Math.max(2, Math.round((steps * (to - from)) / tEnd));
      const grid = Array.from({ length: n + 1 }, (_, j) => from + ((to - from) * j) / n);
      const curve = michaelisMentenCurve(route, params, schedule, grid);
      total += trapezoidSamples(
        curve.map((c) => (params.vmax * c) / (params.km + c)),
        (to - from) / n,
      );
    }
    return total;
  };

  it('iv_bolus: ∫ Vmax·C/(Km+C) dt = D', () => {
    expectRelClose(eliminated('iv_bolus', model, [{ time: 0, amount: dose }]), dose, 1e-5);
  });

  it('oral: ∫ Vmax·C/(Km+C) dt = F·D', () => {
    const oral: MichaelisMentenParams = { ...model, ka: 0.8, F: 0.6 };
    expectRelClose(eliminated('oral', oral, [{ time: 0, amount: dose }]), 0.6 * dose, 1e-5);
  });

  it('iv_infusion: ∫ Vmax·C/(Km+C) dt = D', () => {
    const infusion: MichaelisMentenParams = { ...model, infusionDuration: 6 };
    expectRelClose(eliminated('iv_infusion', infusion, [{ time: 0, amount: dose }]), dose, 1e-5);
  });

  it('multi-dose: ∫ Vmax·C/(Km+C) dt = ΣD', () => {
    // Three interacting doses — the case superposition cannot reach, and the one
    // that most needs an independent conservation check.
    const schedule = [
      { time: 0, amount: 400 },
      { time: 10, amount: 400 },
      { time: 25, amount: 400 },
    ];
    expectRelClose(eliminated('iv_bolus', model, schedule), 1200, 1e-5);
  });
});

describe('SUPERPOSITION FAILS — the property that makes this module necessary', () => {
  // `dosing.ts` sums time-shifted single-dose curves. For a saturable drug that
  // is not an approximation, it is wrong in a specific direction, and these
  // assertions are what justify a whole separate integrator rather than a new
  // branch in the linear path.
  const dose = 1000;
  const grid = uniformGrid(48, 480);

  it('two doses exceed the sum of two single-dose curves', () => {
    const together = michaelisMentenCurve(
      'iv_bolus',
      model,
      [
        { time: 0, amount: dose },
        { time: 12, amount: dose },
      ],
      grid,
    );
    const alone = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: dose }], grid);
    const shifted = michaelisMentenCurve('iv_bolus', model, [{ time: 12, amount: dose }], grid);

    // Before the second dose the two agree (nothing to interact with yet).
    grid.forEach((tGrid, i) => {
      if (tGrid >= 12) return;
      expectRelClose(at(together, i), at(alone, i) + at(shifted, i), 1e-9);
    });

    // After it, the real curve runs HIGHER than superposition predicts: the two
    // doses together push C further up the saturation curve, so each is
    // eliminated more slowly than it would be alone.
    grid.forEach((t, i) => {
      if (t <= 14) return;
      expect(at(together, i)).toBeGreaterThan(at(alone, i) + at(shifted, i));
    });

    // And the discrepancy is large, not a rounding artefact — a linear engine
    // would be materially wrong here, not slightly wrong.
    const i24 = grid.indexOf(24);
    expect(at(together, i24) / (at(alone, i24) + at(shifted, i24))).toBeGreaterThan(1.1);
  });

  it('...but superposition holds in the Km ≫ C limit, where the drug IS linear', () => {
    // The complement: the failure above is caused by saturation specifically, not
    // by the integrator. Push the same schedule far below Km and additivity returns.
    const km = 1e6;
    const vd = 50;
    const linearish: MichaelisMentenParams = { vd, vmax: 0.2 * vd * km, km };
    const together = michaelisMentenCurve(
      'iv_bolus',
      linearish,
      [
        { time: 0, amount: dose },
        { time: 12, amount: dose },
      ],
      grid,
    );
    const alone = michaelisMentenCurve('iv_bolus', linearish, [{ time: 0, amount: dose }], grid);
    const shifted = michaelisMentenCurve('iv_bolus', linearish, [{ time: 12, amount: dose }], grid);
    grid.forEach((_t, i) => {
      const expected = at(alone, i) + at(shifted, i);
      if (expected < 1e-9) return;
      expectRelClose(at(together, i), expected, 1e-4);
    });
  });
});

describe('apparentHalfLifeMM — the honest replacement for a stored half-life', () => {
  it('matches the integrator: a bolus at c halves in exactly t½(c)', () => {
    // Ties the closed form the UI renders to the curve the UI draws.
    for (const c0 of [20, 5, 1, 0.05]) {
      const dose = c0 * model.vd;
      const t = apparentHalfLifeMM(model, c0);
      const curve = michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: dose }], [0, t]);
      expectRelClose(at(curve, 1), c0 / 2, 1e-6);
    }
  });

  it('rises with concentration — the same drug reports different half-lives', () => {
    const low = apparentHalfLifeMM(model, 0.01);
    const mid = apparentHalfLifeMM(model, 5);
    const high = apparentHalfLifeMM(model, 40);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    // Not a subtle effect: across this range it more than quadruples.
    expect(high / low).toBeGreaterThan(4);
  });

  it('recovers the ordinary linear half-life as C → 0', () => {
    expectRelClose(apparentHalfLifeMM(model, 0), Math.LN2 / firstOrderLimitRateMM(model), 1e-12);
  });
});

describe('infusionSteadyStateMM — Css = r0·Km/(Vmax − r0)', () => {
  it('a long infusion converges on the algebraic steady state', () => {
    const r0 = 50; // mg/h — half of Vmax
    const duration = 400;
    const infusion: MichaelisMentenParams = { ...model, infusionDuration: duration };
    const curve = michaelisMentenCurve(
      'iv_infusion',
      infusion,
      [{ time: 0, amount: r0 * duration }],
      [0, 300],
    );
    expectRelClose(at(curve, 1), infusionSteadyStateMM(model, r0), 1e-4);
  });

  it('Css is grossly superlinear in dose rate, and diverges at r0 = Vmax', () => {
    // The clinical signature: 1.8× the dose rate for 9× the concentration.
    expectRelClose(infusionSteadyStateMM(model, 50), 5, 1e-12);
    expectRelClose(infusionSteadyStateMM(model, 90), 45, 1e-12);
    expect(infusionSteadyStateMM(model, model.vmax)).toBe(Infinity);
    expect(infusionSteadyStateMM(model, model.vmax * 1.5)).toBe(Infinity);
  });
});

describe('route contracts', () => {
  it('oral starts at zero and requires ka', () => {
    const oral: MichaelisMentenParams = { ...model, ka: 1, F: 1 };
    const curve = michaelisMentenCurve('oral', oral, [{ time: 0, amount: 1000 }], [0]);
    expect(at(curve, 0)).toBe(0);
    expect(() => michaelisMentenCurve('oral', model, [], [0])).toThrow(/ka/);
  });

  it('iv_infusion requires a duration', () => {
    expect(() => michaelisMentenCurve('iv_infusion', model, [], [0])).toThrow(/duration/);
  });

  it('an empty schedule is all zeros; an empty grid is empty', () => {
    expect(michaelisMentenCurve('iv_bolus', model, [], [0, 5, 10])).toEqual([0, 0, 0]);
    expect(michaelisMentenCurve('iv_bolus', model, [{ time: 0, amount: 100 }], [])).toEqual([]);
  });

  it('honours a dose given before the grid opens', () => {
    // The walk starts at the earliest mark of either kind, so a curve can open
    // mid-course with drug already on board.
    const curve = michaelisMentenCurve('iv_bolus', model, [{ time: -5, amount: 1000 }], [0]);
    const c = at(curve, 0);
    const c0 = 20; // C0 = 20 mg/L at t = −5 …
    expect(c).toBeLessThan(c0);
    expect(c).toBeGreaterThan(0);
    // … and 5 h of decline is exactly what the implicit solution says it is.
    expectRelClose(ivBolusElapsedTime(model, c0, c), 5, 1e-5);
  });
});
