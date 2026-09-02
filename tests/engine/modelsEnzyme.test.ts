import { describe, expect, it } from 'vitest';
import {
  eliminationCeiling,
  enzymeRecoveryTime,
  enzymeSteadyStateFraction,
  enzymeTurnoverCurve,
  enzymeTurnoverSteadyState,
  inactivationRate,
  inductionFactor,
  type EnzymeTurnoverParams,
} from '../../src/engine/modelsEnzyme.ts';
import { infusionSteadyStateMM, michaelisMentenCurve } from '../../src/engine/modelsMM.ts';
import type { MichaelisMentenParams } from '../../src/engine/modelsMM.ts';

/**
 * The enzyme-turnover model is proven the same way the Michaelis–Menten one is:
 * against what is analytic, never against a stored curve (handoff §10). `C(t)`
 * has no closed form here either — less than ever, since the capacity is now a
 * second state — so the oracles are:
 *
 * - the COLLAPSE: with neither enzyme term the model must reproduce
 *   `modelsMM.ts` exactly, which is already pinned against its own closed forms.
 *   This is the same tie the 2-comp `Q → 0` collapse provides for the linear
 *   models, and it is what makes every MM oracle transitively an oracle here;
 * - the drug-free enzyme equation, which IS linear and therefore exactly
 *   solvable: `e(t) = 1 − (1 − e₀)·e^(−k_deg·t)`;
 * - the coupled steady state, solved algebraically (no integrator involved) by
 *   `enzymeTurnoverSteadyState`, and its ceiling;
 * - MASS BALANCE — `∫ Vmax·e·C/(Km+C) dt = F·D` — which holds however the
 *   capacity moves, and is the only oracle that sees the enzyme and the drug at
 *   once;
 * - and the NEGATIVE oracle that justifies the module existing at all:
 *   accumulation across a trough of ZERO, which the data guide's
 *   between-dose-trough screen says no concentration-driven model can produce.
 *   The same schedule is run through `modelsMM.ts` to show it does not.
 */

/** Indexed read that fails loudly rather than yielding `undefined`. */
function at(values: number[], i: number): number {
  const v = values.at(i);
  if (v === undefined) throw new Error(`no sample at index ${i} (length ${values.length})`);
  return v;
}

/** Composite trapezoidal integral of sampled values on a uniform grid. */
function trapezoidSamples(ys: number[], dt: number): number {
  let sum = 0.5 * (at(ys, 0) + at(ys, -1));
  for (let i = 1; i < ys.length - 1; i++) sum += at(ys, i);
  return sum * dt;
}

function expectRelClose(actual: number, expected: number, relTol: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
}

/** Uniform grid of `steps + 1` points spanning [0, tEnd]. */
function uniformGrid(tEnd: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => (i * tEnd) / steps);
}

/** Uniform grid over an arbitrary window. */
function windowGrid(from: number, to: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);
}

// The same capacity-limited drug the MM tests use (Vmax/(Vd·Km) = 0.4/h at the
// first-order limit), given an enzyme with a 48 h turnover half-life. With no
// inactivation and no induction this must BE the MM drug.
const enzymeKinetics = { kdeg: Math.LN2 / 48 };
const base: EnzymeTurnoverParams = { vd: 50, vmax: 100, km: 5, ...enzymeKinetics };
const mmEquivalent: MichaelisMentenParams = { vd: 50, vmax: 100, km: 5 };

describe('the collapse — with no enzyme term this IS the Michaelis–Menten model', () => {
  it('reproduces every MM route curve, and never moves the enzyme', () => {
    const dose = 1000;
    const grid = uniformGrid(48, 480);

    const cases: Array<
      [route: 'iv_bolus' | 'oral' | 'iv_infusion', extra: Partial<EnzymeTurnoverParams>]
    > = [
      ['iv_bolus', {}],
      ['oral', { ka: 0.8, F: 0.6 }],
      ['iv_infusion', { infusionDuration: 6 }],
    ];

    for (const [route, extra] of cases) {
      const params = { ...base, ...extra };
      const mm = { ...mmEquivalent, ...extra };
      const got = enzymeTurnoverCurve(route, params, [{ time: 0, amount: dose }], grid);
      const expected = michaelisMentenCurve(route, mm, [{ time: 0, amount: dose }], grid);

      grid.forEach((_t, i) => {
        const target = at(expected, i);
        if (target < 1e-9) return;
        expectRelClose(at(got.concentration, i), target, 1e-6);
        // e = 1 is an exact fixed point of the drug-free enzyme equation, and
        // with no drug term it stays one at every concentration.
        expect(at(got.enzymeFraction, i)).toBe(1);
      });
    }
  });

  it('and its steady state reduces to the MM closed form', () => {
    for (const r0 of [10, 50, 90]) {
      expectRelClose(
        enzymeTurnoverSteadyState(base, r0),
        infusionSteadyStateMM(mmEquivalent, r0),
        1e-9,
      );
    }
    expect(eliminationCeiling(base)).toBe(base.vmax);
    expect(enzymeTurnoverSteadyState(base, base.vmax)).toBe(Infinity);
  });
});

describe('the enzyme equation on its own', () => {
  const inactivating: EnzymeTurnoverParams = { ...base, kinact: 0.5, ki: 1 };

  it('e_ss(0) = 1, and suppression is set by k_inact RELATIVE to turnover', () => {
    expect(enzymeSteadyStateFraction(inactivating, 0)).toBe(1);

    // At a saturating concentration the sustained level is k_deg/(k_deg + k_inact).
    const saturating = 1e6;
    expectRelClose(
      enzymeSteadyStateFraction(inactivating, saturating),
      inactivating.kdeg / (inactivating.kdeg + 0.5),
      1e-4,
    );

    // Ten times faster turnover ⇒ nearly ten times less suppression, at the same
    // k_inact: `k_deg/(k_deg + k_inact)` scales with `k_deg` exactly while
    // `k_deg ≪ k_inact`, and bends away from it as the two become comparable.
    const fastTurnover = { ...inactivating, kdeg: inactivating.kdeg * 10 };
    const ratio =
      enzymeSteadyStateFraction(fastTurnover, saturating) /
      enzymeSteadyStateFraction(inactivating, saturating);
    expect(ratio).toBeGreaterThan(7);
    expect(ratio).toBeLessThan(10);
  });

  it('recovers exponentially at k_deg once the drug is gone — a drug-free clock', () => {
    // A single dose knocks the enzyme down, and the drug then leaves far faster
    // than the enzyme comes back — the separation of clocks that makes this model
    // different from every other one here. The fixture is deliberately the
    // short-lived drug (first-order limit t½ ≈ 0.17 h) against a 48 h enzyme, so
    // that by 40 h the drug is unmeasurable and recovery must be the exact linear
    // solution, with no drug parameter in it.
    const fast: EnzymeTurnoverParams = {
      vd: 30,
      vmax: 60,
      km: 0.5,
      kdeg: Math.LN2 / 48,
      kinact: 0.35,
      ki: 0.2,
    };
    const grid = [0, 40, 60, 100, 200];
    const { concentration, enzymeFraction } = enzymeTurnoverCurve(
      'iv_bolus',
      fast,
      [{ time: 0, amount: 20 }],
      grid,
    );
    expect(at(concentration, 1)).toBeLessThan(1e-6 * at(concentration, 0));

    const e40 = at(enzymeFraction, 1);
    expect(e40).toBeGreaterThan(0);
    expect(e40).toBeLessThan(0.9);

    for (const i of [2, 3, 4]) {
      const dt = at(grid, i) - 40;
      const exact = 1 - (1 - e40) * Math.exp(-fast.kdeg * dt);
      expectRelClose(at(enzymeFraction, i), exact, 1e-6);
      // …and the closed form the UI would quote agrees with the trajectory.
      expectRelClose(enzymeRecoveryTime(fast, e40, at(enzymeFraction, i)), dt, 1e-4);
    }
  });

  it('stays inside its bounds: inactivation never exceeds 1, induction never falls below it', () => {
    const inducing: EnzymeTurnoverParams = { ...base, indMax: 1.5, ec50: 2 };
    const grid = uniformGrid(200, 400);
    const knocked = enzymeTurnoverCurve(
      'iv_bolus',
      inactivating,
      [{ time: 0, amount: 4000 }],
      grid,
    );
    const induced = enzymeTurnoverCurve('iv_bolus', inducing, [{ time: 0, amount: 4000 }], grid);

    for (const e of knocked.enzymeFraction) {
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThanOrEqual(1);
    }
    for (const e of induced.enzymeFraction) {
      expect(e).toBeGreaterThanOrEqual(1);
      expect(e).toBeLessThanOrEqual(1 + (inducing.indMax ?? 0) + 1e-9);
    }
    // Both drivers are saturable, and bounded by their own maxima.
    expect(inactivationRate(inactivating, 1e9)).toBeLessThanOrEqual(0.5);
    expect(inductionFactor(inducing, 1e9)).toBeLessThanOrEqual(1.5);
  });
});

describe('THE SIGNATURE — accumulation across a trough of zero', () => {
  /**
   * The data guide's between-dose-trough screen (the omeprazole re-gate) says:
   * if the concentration returns to ≈ zero between doses and exposure still
   * climbs, no concentration-driven model can reproduce it at any parameter
   * values. That is exactly right about `modelsMM.ts` and exactly wrong about
   * this module, and the difference is asserted here rather than described.
   *
   * The drug is deliberately short-lived (first-order limit t½ ≈ 0.17 h) and the
   * enzyme deliberately slow (turnover t½ 48 h): 24 h is >100 drug half-lives and
   * half an enzyme half-life.
   */
  const shortLived = { vd: 30, vmax: 60, km: 0.5, ka: 1.5, F: 1 };
  const inactivator: EnzymeTurnoverParams = {
    ...shortLived,
    kdeg: Math.LN2 / 48,
    kinact: 0.35,
    ki: 0.2,
  };
  const withoutEnzymeState: MichaelisMentenParams = shortLived;

  const dose = 20;
  const tau = 24;
  const days = 5;
  const schedule = Array.from({ length: days }, (_, i) => ({ time: i * tau, amount: dose }));

  /** Sample one dosing interval finely and return its peak, area and closing trough. */
  const interval = (day: number) => {
    const from = (day - 1) * tau;
    const grid = windowGrid(from, from + tau, 2400);
    const { concentration, enzymeFraction } = enzymeTurnoverCurve(
      'oral',
      inactivator,
      schedule,
      grid,
    );
    return {
      cmax: Math.max(...concentration),
      auc: trapezoidSamples(concentration, tau / 2400),
      trough: at(concentration, -1),
      enzymeAtTrough: at(enzymeFraction, -1),
    };
  };

  const day1 = interval(1);
  const day5 = interval(5);

  it('the concentration really does return to zero between doses', () => {
    // Not "small relative to the peak" — indistinguishable from zero at any
    // plotting precision, which is what makes the accumulation unexplainable by
    // leftover drug.
    expect(day1.trough).toBeLessThan(1e-9 * day1.cmax);
    expect(day5.trough).toBeLessThan(1e-9 * day5.cmax);
  });

  it('…and exposure still climbs, because the enzyme is carrying the memory', () => {
    expect(day5.cmax / day1.cmax).toBeGreaterThan(1.2);
    expect(day5.auc / day1.auc).toBeGreaterThan(1.4);
    // The state that did it: enzyme is materially below baseline at a moment
    // when there is no drug in the body at all.
    expect(day5.enzymeAtTrough).toBeLessThan(0.75);
  });

  it('while the same schedule under Michaelis–Menten repeats day 1 exactly', () => {
    // The control, and the reason this module exists: with capacity held
    // constant, every dosing interval is identical however many precede it.
    const first = windowGrid(0, tau, 2400);
    const fifth = windowGrid(4 * tau, 5 * tau, 2400);
    const a = michaelisMentenCurve('oral', withoutEnzymeState, schedule, first);
    const b = michaelisMentenCurve('oral', withoutEnzymeState, schedule, fifth);
    expectRelClose(Math.max(...b), Math.max(...a), 1e-9);
    expectRelClose(trapezoidSamples(b, tau / 2400), trapezoidSamples(a, tau / 2400), 1e-9);
  });

  it('and the apparent half-life depends on HISTORY, not just concentration', () => {
    // Two identical IV probes into the same subject, one naive and one after four
    // days of the schedule above: same drug, same concentration, different decay.
    const probeDose = 6;
    const naive = enzymeTurnoverCurve(
      'iv_bolus',
      inactivator,
      [{ time: 0, amount: probeDose }],
      uniformGrid(6, 600),
    );
    const pretreatedSchedule = [
      ...Array.from({ length: 4 }, (_, i) => ({ time: i * tau, amount: dose })),
      { time: 4 * tau, amount: probeDose },
    ];
    const pretreated = enzymeTurnoverCurve(
      'iv_bolus',
      inactivator,
      pretreatedSchedule,
      windowGrid(4 * tau, 4 * tau + 6, 600),
    );

    const c0 = at(naive.concentration, 0);
    expectRelClose(at(pretreated.concentration, 0), c0, 1e-6);

    const halveTime = (values: number[], grid: number[]): number => {
      const i = values.findIndex((c) => c <= c0 / 2);
      if (i <= 0) throw new Error('probe never halved within the window');
      return at(grid, i);
    };
    const naiveGrid = uniformGrid(6, 600);
    const pretreatedGrid = windowGrid(4 * tau, 4 * tau + 6, 600).map((t) => t - 4 * tau);

    expect(halveTime(pretreated.concentration, pretreatedGrid)).toBeGreaterThan(
      halveTime(naive.concentration, naiveGrid) * 1.2,
    );
  });
});

describe('induction — the same state, driven the other way', () => {
  // The shape phenytoin's own source fits (Frame & Beal preferred a
  // Michaelis–Menten model with delayed induction) and which `modelsMM.ts`
  // cannot express: exposure FALLING over repeated dosing as the drug builds the
  // enzyme that clears it. No compound ships against this; it is here because it
  // is the same equation with the sign flipped, and refusing to implement half a
  // symmetric model would have been an arbitrary boundary.
  const inducer: EnzymeTurnoverParams = {
    vd: 30,
    vmax: 60,
    km: 0.5,
    ka: 1.5,
    F: 1,
    kdeg: Math.LN2 / 24,
    indMax: 4,
    ec50: 0.05,
  };
  const tau = 12;
  const schedule = Array.from({ length: 5 }, (_, i) => ({ time: i * tau, amount: 20 }));

  it('exposure falls over a course, and the enzyme is above baseline at the trough', () => {
    const first = enzymeTurnoverCurve('oral', inducer, schedule, windowGrid(0, tau, 2400));
    const fifth = enzymeTurnoverCurve(
      'oral',
      inducer,
      schedule,
      windowGrid(4 * tau, 5 * tau, 2400),
    );
    const aucFirst = trapezoidSamples(first.concentration, tau / 2400);
    const aucFifth = trapezoidSamples(fifth.concentration, tau / 2400);
    expect(aucFifth).toBeLessThan(aucFirst * 0.9);
    expect(at(fifth.enzymeFraction, -1)).toBeGreaterThan(1.05);
  });

  it('raises the ceiling that inactivation lowers', () => {
    const plain: EnzymeTurnoverParams = { vd: 30, vmax: 60, km: 0.5, kdeg: Math.LN2 / 48 };
    const knocked: EnzymeTurnoverParams = { ...plain, kinact: 0.35, ki: 0.2 };
    expect(eliminationCeiling(plain)).toBe(60);
    expect(eliminationCeiling(knocked)).toBeLessThan(60 * 0.1);
    expect(eliminationCeiling(inducer)).toBeGreaterThan(60 * 4.9);
  });
});

describe('the coupled steady state', () => {
  const inactivating: EnzymeTurnoverParams = {
    vd: 50,
    vmax: 100,
    km: 5,
    kdeg: Math.LN2 / 12,
    kinact: 0.1,
    ki: 4,
  };

  it('a long infusion converges on the algebraically-solved Css, enzyme included', () => {
    const r0 = 20; // mg/h — comfortably under the depleted ceiling
    const duration = 2000;
    const params = { ...inactivating, infusionDuration: duration };
    const { concentration, enzymeFraction } = enzymeTurnoverCurve(
      'iv_infusion',
      params,
      [{ time: 0, amount: r0 * duration }],
      [0, 1500],
    );
    const css = enzymeTurnoverSteadyState(inactivating, r0);
    expectRelClose(at(concentration, 1), css, 1e-4);
    expectRelClose(at(enzymeFraction, 1), enzymeSteadyStateFraction(inactivating, css), 1e-4);
  });

  it('sits ABOVE the Michaelis–Menten steady state at the same dose rate', () => {
    // Less capacity for the same input has to mean more drug. The gap is the
    // clinical content of the whole model.
    const r0 = 20;
    const mm = infusionSteadyStateMM({ vd: 50, vmax: 100, km: 5 }, r0);
    expect(enzymeTurnoverSteadyState(inactivating, r0)).toBeGreaterThan(mm * 1.5);
  });

  it('has no steady state above the depleted ceiling', () => {
    const ceiling = eliminationCeiling(inactivating);
    expect(ceiling).toBeLessThan(100);
    expect(enzymeTurnoverSteadyState(inactivating, ceiling)).toBe(Infinity);
    expect(enzymeTurnoverSteadyState(inactivating, ceiling * 1.01)).toBe(Infinity);
    expect(Number.isFinite(enzymeTurnoverSteadyState(inactivating, ceiling * 0.95))).toBe(true);
  });
});

describe('mass balance — the enzyme moves, the mass still adds up', () => {
  // Independent of every other oracle here: it integrates the elimination FLUX,
  // which now carries the enzyme state, and requires it to equal what went in.
  const params: EnzymeTurnoverParams = {
    vd: 50,
    vmax: 100,
    km: 5,
    kdeg: Math.LN2 / 24,
    kinact: 0.2,
    ki: 2,
  };
  const tEnd = 600;
  const steps = 120_000;

  const eliminated = (
    route: 'iv_bolus' | 'oral' | 'iv_infusion',
    p: EnzymeTurnoverParams,
    schedule: Array<{ time: number; amount: number }>,
  ): number => {
    // Split at dose instants: an IV bolus steps the concentration, so a trapezoid
    // panel straddling the jump would over-count at O(dt) (the MM test's note).
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
      const grid = windowGrid(from, to, n);
      const { concentration, enzymeFraction } = enzymeTurnoverCurve(route, p, schedule, grid);
      const flux = concentration.map((c, j) => (p.vmax * at(enzymeFraction, j) * c) / (p.km + c));
      total += trapezoidSamples(flux, (to - from) / n);
    }
    return total;
  };

  it('iv_bolus: ∫ Vmax·e·C/(Km+C) dt = D', () => {
    expectRelClose(eliminated('iv_bolus', params, [{ time: 0, amount: 1000 }]), 1000, 1e-4);
  });

  it('oral: ∫ Vmax·e·C/(Km+C) dt = F·D', () => {
    const oral = { ...params, ka: 0.8, F: 0.6 };
    expectRelClose(eliminated('oral', oral, [{ time: 0, amount: 1000 }]), 600, 1e-4);
  });

  it('multi-dose: ∫ Vmax·e·C/(Km+C) dt = ΣD', () => {
    const schedule = [
      { time: 0, amount: 400 },
      { time: 30, amount: 400 },
      { time: 80, amount: 400 },
    ];
    expectRelClose(eliminated('iv_bolus', params, schedule), 1200, 1e-4);
  });
});

describe('contracts', () => {
  it('requires a turnover rate, and refuses half-supplied pairs', () => {
    expect(() =>
      enzymeTurnoverCurve('iv_bolus', { vd: 1, vmax: 1, km: 1, kdeg: 0 }, [], [0]),
    ).toThrow(/kdeg/);
    expect(() => enzymeTurnoverCurve('iv_bolus', { ...base, kinact: 0.1 }, [], [0])).toThrow(
      /kinact and ki/,
    );
    expect(() => enzymeTurnoverCurve('iv_bolus', { ...base, ec50: 1 }, [], [0])).toThrow(
      /indMax and ec50/,
    );
  });

  it('requires ka for a first-order route and a duration for an infusion', () => {
    expect(() => enzymeTurnoverCurve('oral', base, [], [0])).toThrow(/ka/);
    expect(() => enzymeTurnoverCurve('iv_infusion', base, [], [0])).toThrow(/duration/);
  });

  it('refuses a recovery that is not a recovery', () => {
    expect(() => enzymeRecoveryTime(base, 0.5, 0.4)).toThrow(/closer to 1/);
    expect(() => enzymeRecoveryTime(base, 0.5, 1.2)).toThrow(/same side/);
  });

  it('an empty schedule leaves an intact enzyme; an empty grid is empty', () => {
    const idle = enzymeTurnoverCurve('iv_bolus', base, [], [0, 10, 100]);
    expect(idle.concentration).toEqual([0, 0, 0]);
    expect(idle.enzymeFraction).toEqual([1, 1, 1]);
    const empty = enzymeTurnoverCurve('iv_bolus', base, [{ time: 0, amount: 10 }], []);
    expect(empty.concentration).toEqual([]);
    expect(empty.enzymeFraction).toEqual([]);
  });

  it('honours a dose given before the grid opens', () => {
    const inactivating: EnzymeTurnoverParams = { ...base, kinact: 0.5, ki: 1 };
    const { concentration, enzymeFraction } = enzymeTurnoverCurve(
      'iv_bolus',
      inactivating,
      [{ time: -20, amount: 1000 }],
      [0],
    );
    expect(at(concentration, 0)).toBeGreaterThan(0);
    expect(at(concentration, 0)).toBeLessThan(1000 / base.vd);
    expect(at(enzymeFraction, 0)).toBeLessThan(1);
  });
});
