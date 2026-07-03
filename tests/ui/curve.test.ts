import { describe, expect, it } from 'vitest';
import { parseCompound } from '../../src/data/loader.ts';
import {
  buildCurve,
  buildCurve2c,
  buildSchedule,
  halfLifeRangeH,
  type DoseSchedule,
} from '../../src/ui/curve.ts';
import { singleDoseAuc2c } from '../../src/engine/pk.ts';
import { baseRawCompound, baseRawTwoCompCompound } from '../data/_fixtures.ts';

/**
 * The UI ↔ engine glue. The superposition MATH is proven in the engine tests
 * (dosing.test.ts); here we pin the seam's own responsibilities: flattening a
 * UI {@link DoseSchedule} to the engine's `DoseEvent[]`, sizing the time grid to
 * cover the whole course (so a recurring schedule isn't clipped mid-decay), and
 * preserving the single-dose analytic oracle C(0) = D/Vd through the pipeline.
 *
 * The IV-bolus fixture has Vd = 0.5 L/kg → 35 L absolute against the 70 kg
 * reference subject, so a 350 mg dose gives a clean C(0) = 350/35 = 10 mg/L.
 */

const compound = parseCompound(baseRawCompound()); // IV bolus, t½ = 4 h, Vd = 35 L
const VD_ABS = 35;

/** The IV-bolus fixture with a reported half-life range 2–8 h (nominal 4 h). */
function rangedCompound() {
  const raw = baseRawCompound();
  (raw.disposition as Record<string, unknown>).halfLife = {
    value: 4,
    range: [2, 8],
    unit: 'h',
    derived: false,
    sourceRef: 'ref',
  };
  return parseCompound(raw);
}

/** rangedCompound with an available oral route (first-order absorption). */
function rangedOralCompound() {
  const raw = baseRawCompound();
  (raw.disposition as Record<string, unknown>).halfLife = {
    value: 4,
    range: [2, 8],
    unit: 'h',
    derived: false,
    sourceRef: 'ref',
  };
  (raw.routes as Record<string, unknown>).oral = {
    available: true,
    F: { value: 80, unit: 'percent', derived: false, sourceRef: 'ref' },
    tmax: { value: 1.5, unit: 'h', derived: false, sourceRef: 'ref' },
  };
  return parseCompound(raw);
}

/** A single-dose schedule of `amount` mg. */
function single(amount: number): DoseSchedule {
  return { amount, count: 1, interval: 6, adHoc: [] };
}

/**
 * `buildCurve` for a ONE-COMPARTMENT fixture, narrowed to the 1-comp result so
 * the tests can read `params.ke` / `halfLifeH` / `halfLifeRange` (which live only
 * on the 1-comp arm of the `CurveResult` union). Every fixture in this file is
 * one-compartment; the 2-comp path is exercised via `buildCurve2c` below.
 */
function build1c(input: Parameters<typeof buildCurve>[0]) {
  const result = buildCurve(input);
  if (result.model !== 'one_compartment_first_order') {
    throw new Error('expected a one-compartment curve result');
  }
  return result;
}

describe('buildSchedule — flattening a DoseSchedule to DoseEvent[]', () => {
  it('single mode (count 1) is one dose at t = 0, ignoring the interval', () => {
    expect(buildSchedule(single(200))).toEqual([{ time: 0, amount: 200 }]);
  });

  it('recurring places count doses spaced by the interval', () => {
    const doses = buildSchedule({ amount: 100, count: 3, interval: 8, adHoc: [] });
    expect(doses).toEqual([
      { time: 0, amount: 100 },
      { time: 8, amount: 100 },
      { time: 16, amount: 100 },
    ]);
  });

  it('appends ad-hoc doses after the regular course', () => {
    const doses = buildSchedule({
      amount: 100,
      count: 2,
      interval: 6,
      adHoc: [{ time: 30, amount: 250 }],
    });
    expect(doses).toEqual([
      { time: 0, amount: 100 },
      { time: 6, amount: 100 },
      { time: 30, amount: 250 },
    ]);
  });

  it('propagates the engine guard: count > 1 with interval ≤ 0 throws', () => {
    expect(() => buildSchedule({ amount: 100, count: 3, interval: 0, adHoc: [] })).toThrow(/interval/);
  });
});

describe('buildCurve — single dose preserves the analytic oracle', () => {
  it('IV bolus C(0) = D/Vd through the full pipeline', () => {
    const { points } = build1c({ compound, route: 'iv_bolus', schedule: single(350) });
    expect(points[0]!.t).toBe(0);
    expect(points[0]!.c).toBeCloseTo(350 / VD_ABS, 10); // 10 mg/L
  });

  it('sizes the horizon to ~5 half-lives for a single dose (5 × 4 h → 20 h)', () => {
    const { horizonH } = build1c({ compound, route: 'iv_bolus', schedule: single(350) });
    expect(horizonH).toBe(20);
  });
});

describe('buildCurve — schedule shapes the curve and the horizon', () => {
  it('recurring doses accumulate: peak exceeds a single dose C(0)', () => {
    const dose = 350;
    const { points } = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: dose, count: 3, interval: 4, adHoc: [] },
    });
    const peak = Math.max(...points.map((p) => p.c));
    // Three doses one half-life apart superpose to well above the first C(0).
    expect(peak).toBeGreaterThan(dose / VD_ABS);
  });

  it('extends the horizon past the last regular dose', () => {
    const { horizonH } = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 4, interval: 8, adHoc: [] }, // last dose at 24 h
    });
    expect(horizonH).toBeGreaterThanOrEqual(24);
  });

  it('extends the horizon to cover an ad-hoc dose far in the future', () => {
    const { horizonH } = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 1, interval: 6, adHoc: [{ time: 50, amount: 100 }] },
    });
    expect(horizonH).toBeGreaterThanOrEqual(50);
  });

  it('samples the EXACT peak of each IV bolus dose (no grid aliasing at the dose instant)', () => {
    // An IV-bolus concentration jumps at each dose time, so the true peak lives
    // exactly at t = dose.time. A uniform-only grid misses it and aliases the
    // height (the "add 1 h, second peak changes size" bug). τ is deliberately
    // OFF any uniform-grid node (horizon 50 h / 300 → 0.1667 h spacing; 13.37 is
    // not a multiple) so this fails before the dose instant is injected.
    const dose = 350;
    const tau = 13.37;
    const { points, params } = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: dose, count: 2, interval: tau, adHoc: [] },
    });
    const c0 = dose / VD_ABS;
    // Second peak, closed form: dose 1 has decayed for τ, dose 2 is fresh.
    const expected = c0 * (1 + Math.exp(-params.ke * tau));
    const atPeak = points.find((p) => p.t === tau);
    expect(atPeak).toBeDefined();
    expect(atPeak!.c).toBeCloseTo(expected, 10);
  });

  it('second-dose peak varies MONOTONICALLY as the interval grows (no aliasing flicker)', () => {
    // The reported bug: nudging the interval by 1 h changed the second peak's
    // height (and the auto axis) erratically. With the dose instant sampled, the
    // global peak is the second dose = D/Vd·(1 + e^(−ke·τ)), strictly decreasing
    // in τ. Sweep by 1 h and assert each peak is below the previous — the exact
    // "flicker gone" invariant, not just "some point moved".
    const peakAt = (tau: number) => {
      const { points } = build1c({
        compound,
        route: 'iv_bolus',
        schedule: { amount: 350, count: 2, interval: tau, adHoc: [] },
      });
      return Math.max(...points.map((p) => p.c));
    };
    // Offset off-grid (…+0.37): with horizon 100 h / 300 the uniform nodes are
    // multiples of 0.3333 h, so integer τ would land ON a node and pass even
    // WITHOUT the fix (vacuous). The fractional τ forces the uniform-only grid to
    // alias — this sweep is non-monotonic pre-fix, monotonic post-fix.
    let prev = Infinity;
    for (let k = 30; k <= 40; k++) {
      const peak = peakAt(k + 0.37);
      expect(peak).toBeLessThan(prev);
      prev = peak;
    }
  });

  it('keeps the merged grid strictly ascending and free of duplicate times', () => {
    const { points } = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 3, interval: 7, adHoc: [{ time: 7, amount: 50 }] }, // ad-hoc coincides with a dose
    });
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.t).toBeGreaterThan(points[i - 1]!.t);
    }
  });

  it('single mode does not extend the horizon for an unused interval/count', () => {
    const wide = build1c({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 350, count: 1, interval: 100, adHoc: [] },
    });
    expect(wide.horizonH).toBe(20);
  });
});

describe('halfLifeRangeH — reading the reported range', () => {
  it('returns low/nominal/high in hours when a range is present', () => {
    expect(halfLifeRangeH(rangedCompound())).toEqual({ low: 2, nominal: 4, high: 8 });
  });

  it('returns null when the compound reports no range', () => {
    expect(halfLifeRangeH(compound)).toBeNull();
  });
});

describe('buildCurve — variability band', () => {
  const ranged = rangedCompound();

  it('omits the band when the compound reports no half-life range', () => {
    const { band, halfLifeRange } = build1c({ compound, route: 'iv_bolus', schedule: single(350) });
    expect(band).toBeUndefined();
    expect(halfLifeRange).toBeUndefined();
  });

  it('envelopes the main curve: cLow ≤ c ≤ cHigh at every sample', () => {
    const { points, band } = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350) });
    expect(band).toBeDefined();
    band!.forEach((b, i) => {
      const c = points[i]!.c;
      expect(b.cLow).toBeLessThanOrEqual(c + 1e-9);
      expect(c).toBeLessThanOrEqual(b.cHigh + 1e-9);
    });
  });

  it('the slow (long-t½) edge decays above the fast edge after the peak', () => {
    const { band } = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350) });
    // Pick a mid-curve sample; IV bolus starts at the same C(0), then the longer
    // half-life sits strictly above the shorter one.
    const mid = band![Math.floor(band!.length / 2)]!;
    expect(mid.cHigh).toBeGreaterThan(mid.cLow);
  });

  it('the band is FIXED at the reported extremes, independent of the slider', () => {
    const atLow = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350), halfLifeH: 2 });
    const atHigh = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350), halfLifeH: 8 });
    expect(atLow.band).toEqual(atHigh.band);
  });

  it('envelopes the ORAL curve too (absorption phase included)', () => {
    const oral = rangedOralCompound();
    const { points, band } = build1c({ compound: oral, route: 'oral', schedule: single(350) });
    expect(band).toBeDefined();
    band!.forEach((b, i) => {
      const c = points[i]!.c;
      expect(b.cLow).toBeLessThanOrEqual(c + 1e-9);
      expect(c).toBeLessThanOrEqual(b.cHigh + 1e-9);
    });
  });
});

describe('buildCurve — half-life slider override', () => {
  const ranged = rangedCompound();

  it('selecting the nominal reproduces the compound default ke', () => {
    const dflt = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350) });
    const nominal = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350), halfLifeH: 4 });
    expect(nominal.params.ke).toBeCloseTo(dflt.params.ke, 12);
    expect(nominal.halfLifeH).toBeCloseTo(4, 12);
  });

  it('a longer selected half-life gives a smaller ke and a higher tail', () => {
    const short = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350), halfLifeH: 2 });
    const long = build1c({ compound: ranged, route: 'iv_bolus', schedule: single(350), halfLifeH: 8 });
    expect(long.params.ke).toBeLessThan(short.params.ke);
    expect(long.halfLifeH).toBeCloseTo(8, 12);
    // Compare the tail at a common late time both grids resolve.
    const tailAt = (r: ReturnType<typeof buildCurve>, t: number) =>
      r.points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best)).c;
    expect(tailAt(long, 16)).toBeGreaterThan(tailAt(short, 16));
  });
});

/**
 * Metabolite path (handoff §12; spike). The metabolite MATH is proven in the
 * engine tests (metabolite.test.ts); here we pin the glue: the metabolite curve
 * appears only for an IV-bolus parent, the horizon stretches so a long-lived
 * metabolite isn't clipped, formation is linear in the parent dose/fraction, and
 * the metabolite's own C_m(0) = 0 oracle survives the pipeline.
 */
describe('buildCurve — metabolites (IV-bolus parent)', () => {
  /** IV-bolus fixture carrying one long-lived (t½ 40 h ≫ parent 4 h) metabolite. */
  function metaboliteCompound(overrides: Record<string, unknown> = {}) {
    const raw = baseRawCompound();
    raw.metabolites = [
      {
        id: 'testmetabolite',
        name: 'Testmetabolite',
        active: true,
        fractionFormed: { value: 0.5, unit: 'fraction', derived: false, sourceRef: 'ref' },
        vd: { value: 1.0, unit: 'L/kg', derived: false, sourceRef: 'ref' },
        halfLife: { value: 40, unit: 'h', derived: false, sourceRef: 'ref' },
        ...overrides,
      },
    ];
    return parseCompound(raw);
  }

  it('produces a metabolite curve for an IV-bolus parent that declares one', () => {
    const { metabolites } = build1c({
      compound: metaboliteCompound(),
      route: 'iv_bolus',
      schedule: single(350),
    });
    expect(metabolites).toBeDefined();
    expect(metabolites).toHaveLength(1);
    expect(metabolites![0]!.name).toBe('Testmetabolite');
    expect(metabolites![0]!.derived.some((d) => d.parameter === 'keM')).toBe(true);
  });

  it('the metabolite starts at zero (C_m(0) = 0) and forms a positive peak later', () => {
    const { metabolites } = build1c({
      compound: metaboliteCompound(),
      route: 'iv_bolus',
      schedule: single(350),
    });
    const m = metabolites![0]!;
    expect(m.points[0]!.t).toBe(0);
    expect(m.points[0]!.c).toBe(0);
    expect(m.peak.c).toBeGreaterThan(0);
    expect(m.peak.t).toBeGreaterThan(0);
  });

  it('stretches the horizon to cover the long-lived metabolite (not just the parent)', () => {
    // Parent-only horizon would be 5 × 4 h = 20 h; the t½ 40 h metabolite pushes
    // it to 5 × 40 h = 200 h so its slow tail isn't clipped mid-decay.
    const { horizonH } = build1c({
      compound: metaboliteCompound(),
      route: 'iv_bolus',
      schedule: single(350),
    });
    expect(horizonH).toBe(200);
  });

  it('metabolite formation is linear in the formation fraction', () => {
    const half = build1c({ compound: metaboliteCompound(), route: 'iv_bolus', schedule: single(350) });
    const full = build1c({
      compound: metaboliteCompound({
        fractionFormed: { value: 1.0, unit: 'fraction', derived: false, sourceRef: 'ref' },
      }),
      route: 'iv_bolus',
      schedule: single(350),
    });
    // Same grid (both driven by the same parent/metabolite ke) → compare pointwise.
    const i = Math.floor(half.metabolites![0]!.points.length / 2);
    const cHalf = half.metabolites![0]!.points[i]!.c;
    const cFull = full.metabolites![0]!.points[i]!.c;
    expect(cFull).toBeCloseTo(2 * cHalf, 10);
  });

  it('does NOT plot a metabolite for a non-IV-bolus route (spike scope)', () => {
    const raw = baseRawCompound();
    (raw.routes as Record<string, unknown>).oral = {
      available: true,
      tmax: { value: 1.5, unit: 'h', derived: false, sourceRef: 'ref' },
    };
    raw.metabolites = [
      {
        id: 'testmetabolite',
        name: 'Testmetabolite',
        active: true,
        fractionFormed: { value: 0.5, unit: 'fraction', derived: false, sourceRef: 'ref' },
        vd: { value: 1.0, unit: 'L/kg', derived: false, sourceRef: 'ref' },
        halfLife: { value: 40, unit: 'h', derived: false, sourceRef: 'ref' },
      },
    ];
    const oralWithMetabolite = parseCompound(raw);
    expect(build1c({ compound: oralWithMetabolite, route: 'oral', schedule: single(350) }).metabolites).toBeUndefined();
    // …but the same compound DOES plot it via IV bolus.
    expect(build1c({ compound: oralWithMetabolite, route: 'iv_bolus', schedule: single(350) }).metabolites).toHaveLength(1);
  });

  it('omits metabolites entirely for a parent-only compound', () => {
    expect(build1c({ compound, route: 'iv_bolus', schedule: single(350) }).metabolites).toBeUndefined();
  });
});

/**
 * The two-compartment glue (handoff §12). The disposition/superposition MATH is
 * proven in the engine tests (models2c.test.ts); here we pin the seam's own
 * responsibilities: sizing the horizon on the terminal β, DENSIFYING the fast
 * distribution phase so the α knee isn't aliased, and driving metabolites off the
 * parent's α/β modes for an IV bolus only. The fixture is CL=5, Vc=10, Q=10,
 * Vp=20 (α≈1.866/h, β≈0.134/h).
 */
describe('buildCurve dispatches on the compound model', () => {
  it('routes a two-compartment compound to the 2-comp path (tagged result)', () => {
    const result = buildCurve({
      compound: parseCompound(baseRawTwoCompCompound()),
      route: 'iv_bolus',
      schedule: single(100),
    });
    expect(result.model).toBe('two_compartment_first_order');
    if (result.model === 'two_compartment_first_order') {
      expect(result.params).toEqual({ vc: 10, cl: 5, q: 10, vp: 20 });
      expect(result.terminalHalfLifeH).toBeGreaterThan(result.distributionHalfLifeH);
    }
  });

  it('keeps a one-compartment compound on the 1-comp path', () => {
    expect(buildCurve({ compound, route: 'iv_bolus', schedule: single(350) }).model).toBe(
      'one_compartment_first_order',
    );
  });
});

describe('buildCurve2c — two-compartment parent', () => {
  const twoComp = parseCompound(baseRawTwoCompCompound());

  /** Trapezoid the sampled curve (its own non-uniform grid) for an AUC check. */
  function trapezoidPoints(points: { t: number; c: number }[]): number {
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      sum += 0.5 * (a.c + b.c) * (b.t - a.t);
    }
    return sum;
  }

  it('IV-bolus peak is C(0) = D/Vc', () => {
    const dose = 100;
    const { peak } = buildCurve2c({ compound: twoComp, route: 'iv_bolus', schedule: single(dose) });
    expect(peak.t).toBe(0);
    expect(peak.c).toBeCloseTo(dose / 10, 9); // Vc = 10 L
  });

  it('sizes the horizon on the terminal β (many terminal half-lives)', () => {
    const { horizonH, terminalHalfLifeH } = buildCurve2c({
      compound: twoComp,
      route: 'iv_bolus',
      schedule: single(100),
    });
    // ~5 terminal half-lives (β ≈ 0.134/h ⇒ t½ ≈ 5.2 h) → tens of hours, rounded up.
    expect(horizonH).toBeGreaterThan(4 * terminalHalfLifeH);
  });

  it('densifies the distribution phase: many samples inside the first α half-life', () => {
    const { points } = buildCurve2c({ compound: twoComp, route: 'iv_bolus', schedule: single(100) });
    const alphaHalfLife = Math.LN2 / 1.8660254; // α ≈ 1.866/h
    const early = points.filter((p) => p.t > 0 && p.t <= alphaHalfLife);
    // A uniform 300-pt grid over a ~30 h horizon would give ~4 points here; the
    // densification must give many more so the α knee renders as a curve.
    expect(early.length).toBeGreaterThan(15);
  });

  it('recovers AUC = D/CL from the sampled curve (grid is dense enough)', () => {
    const dose = 100;
    const { points } = buildCurve2c({ compound: twoComp, route: 'iv_bolus', schedule: single(dose) });
    // The finite horizon truncates a small terminal tail, so allow a modest tol.
    expect(trapezoidPoints(points)).toBeCloseTo(singleDoseAuc2c({ vc: 10, cl: 5, q: 10, vp: 20 }, dose), 0);
  });

  it('the grid stays strictly ascending and free of duplicate times', () => {
    const { points } = buildCurve2c({
      compound: twoComp,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 2, interval: 8, adHoc: [] },
    });
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.t).toBeGreaterThan(points[i - 1]!.t);
    }
  });

  it('throws for oral without absorption data (caller shows the message)', () => {
    // The base fixture declares no oral route ⇒ no ka/tmax to absorb from.
    expect(() => buildCurve2c({ compound: twoComp, route: 'oral', schedule: single(100) })).toThrow(
      /oral|ka|tmax|absorption/i,
    );
  });
});

describe('buildCurve2c — two-compartment oral (tri-exponential)', () => {
  /** The 2-comp fixture with an available oral route (F = 0.9, Tmax = 1.5 h). */
  function oral2cCompound() {
    const raw = baseRawTwoCompCompound();
    (raw.routes as Record<string, unknown>).oral = {
      available: true,
      F: { value: 0.9, unit: 'fraction', derived: false, sourceRef: 'definition' },
      tmax: { value: 1.5, unit: 'h', derived: false, sourceRef: 'ref' },
    };
    return parseCompound(raw);
  }

  it('starts at C(0) = 0 and peaks near the reported Tmax', () => {
    const { points, peak } = buildCurve2c({
      compound: oral2cCompound(),
      route: 'oral',
      schedule: single(100),
    });
    expect(points[0]!.t).toBe(0);
    expect(points[0]!.c).toBe(0);
    // The exact Bateman peak instant is pinned into the grid, so the marked Tmax
    // lands on the reported 1.5 h (round-tripped through kaFromTmax2c).
    expect(peak.t).toBeCloseTo(1.5, 3);
    expect(peak.c).toBeGreaterThan(0);
  });

  it('the grid stays strictly ascending and free of duplicate times', () => {
    const { points } = buildCurve2c({
      compound: oral2cCompound(),
      route: 'oral',
      schedule: single(100),
    });
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.t).toBeGreaterThan(points[i - 1]!.t);
    }
  });
});

describe('buildCurve2c — two-compartment metabolite (IV bolus only)', () => {
  /** The 2-comp fixture with one metabolite (fm = 0.4, its own Vd + t½). */
  function withMetabolite() {
    const raw = baseRawTwoCompCompound();
    raw.metabolites = [
      {
        id: 'testmeta2c',
        name: 'Testmeta2C',
        active: true,
        fractionFormed: { value: 0.4, unit: 'fraction', derived: false, sourceRef: 'ref' },
        vd: { value: 25, unit: 'L', derived: false, sourceRef: 'ref' },
        halfLife: { value: 12, unit: 'h', derived: false, sourceRef: 'ref' },
      },
    ];
    return parseCompound(raw);
  }

  it('plots one metabolite line via IV bolus, starting at C_m(0) = 0', () => {
    const { metabolites } = buildCurve2c({
      compound: withMetabolite(),
      route: 'iv_bolus',
      schedule: single(100),
    });
    expect(metabolites).toHaveLength(1);
    expect(metabolites![0]!.points[0]!.c).toBe(0);
    expect(metabolites![0]!.peak.c).toBeGreaterThan(0);
  });

  it('a long-lived metabolite extends the horizon beyond the parent terminal', () => {
    const parentOnly = buildCurve2c({
      compound: parseCompound(baseRawTwoCompCompound()),
      route: 'iv_bolus',
      schedule: single(100),
    });
    // Metabolite t½ = 12 h ≫ parent terminal t½ ≈ 5.2 h ⇒ a wider horizon.
    const withMeta = buildCurve2c({
      compound: withMetabolite(),
      route: 'iv_bolus',
      schedule: single(100),
    });
    expect(withMeta.horizonH).toBeGreaterThan(parentOnly.horizonH);
  });
});
