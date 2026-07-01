import { describe, expect, it } from 'vitest';
import { parseCompound } from '../../src/data/loader.ts';
import { buildCurve, buildSchedule, type DoseSchedule } from '../../src/ui/curve.ts';
import { baseRawCompound } from '../data/_fixtures.ts';

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

/** A single-dose schedule of `amount` mg. */
function single(amount: number): DoseSchedule {
  return { amount, count: 1, interval: 6, adHoc: [] };
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
    const { points } = buildCurve({ compound, route: 'iv_bolus', schedule: single(350) });
    expect(points[0]!.t).toBe(0);
    expect(points[0]!.c).toBeCloseTo(350 / VD_ABS, 10); // 10 mg/L
  });

  it('sizes the horizon to ~5 half-lives for a single dose (5 × 4 h → 20 h)', () => {
    const { horizonH } = buildCurve({ compound, route: 'iv_bolus', schedule: single(350) });
    expect(horizonH).toBe(20);
  });
});

describe('buildCurve — schedule shapes the curve and the horizon', () => {
  it('recurring doses accumulate: peak exceeds a single dose C(0)', () => {
    const dose = 350;
    const { points } = buildCurve({
      compound,
      route: 'iv_bolus',
      schedule: { amount: dose, count: 3, interval: 4, adHoc: [] },
    });
    const peak = Math.max(...points.map((p) => p.c));
    // Three doses one half-life apart superpose to well above the first C(0).
    expect(peak).toBeGreaterThan(dose / VD_ABS);
  });

  it('extends the horizon past the last regular dose', () => {
    const { horizonH } = buildCurve({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 4, interval: 8, adHoc: [] }, // last dose at 24 h
    });
    expect(horizonH).toBeGreaterThanOrEqual(24);
  });

  it('extends the horizon to cover an ad-hoc dose far in the future', () => {
    const { horizonH } = buildCurve({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 100, count: 1, interval: 6, adHoc: [{ time: 50, amount: 100 }] },
    });
    expect(horizonH).toBeGreaterThanOrEqual(50);
  });

  it('single mode does not extend the horizon for an unused interval/count', () => {
    const wide = buildCurve({
      compound,
      route: 'iv_bolus',
      schedule: { amount: 350, count: 1, interval: 100, adHoc: [] },
    });
    expect(wide.horizonH).toBe(20);
  });
});
