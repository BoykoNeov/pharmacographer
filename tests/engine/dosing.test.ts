import { describe, expect, it } from 'vitest';
import { concentrationCurve, recurringDoses } from '../../src/engine/dosing.ts';
import { singleDoseConcentration } from '../../src/engine/models.ts';
import type { PkParams, Route } from '../../src/engine/types.ts';

/**
 * Superposition mechanics (handoff §7, §10). The core guarantees: a one-dose
 * schedule reproduces the single-dose curve exactly; a dose at t₀ is the curve
 * shifted by t₀; doses far enough apart don't interfere; and the whole thing is
 * linear in the doses (the property that makes superposition legitimate). The
 * steady-state convergence oracle lives in pk.test.ts, where it pins the closed
 * forms.
 */

const fineGrid = Array.from({ length: 41 }, (_, i) => i * 0.5); // 0..20 h, 0.5 h steps

const ivParams: PkParams = { vd: 50, ke: Math.LN2 / 4 }; // t½ = 4 h
const oralParams: PkParams = { vd: 30, ke: 0.17, ka: 1.1, F: 0.8 };

const cases: { route: Route; params: PkParams }[] = [
  { route: 'iv_bolus', params: ivParams },
  { route: 'oral', params: oralParams },
  { route: 'iv_infusion', params: { vd: 40, ke: 0.2, infusionDuration: 2 } },
];

describe('concentrationCurve — superposition over a schedule', () => {
  for (const { route, params } of cases) {
    it(`a one-dose schedule equals the single-dose curve exactly (${route})`, () => {
      const dose = 500;
      const curve = concentrationCurve(route, params, [{ time: 0, amount: dose }], fineGrid);
      const expected = fineGrid.map((t) => singleDoseConcentration(route, params, dose, t));
      curve.forEach((c, i) => expect(c).toBeCloseTo(expected[i]!, 12));
    });

    it(`a dose given at t₀ is the single-dose curve shifted by t₀ (${route})`, () => {
      const dose = 320;
      const t0 = 3;
      const curve = concentrationCurve(route, params, [{ time: t0, amount: dose }], fineGrid);
      const expected = fineGrid.map((t) => singleDoseConcentration(route, params, dose, t - t0));
      curve.forEach((c, i) => expect(c).toBeCloseTo(expected[i]!, 12));
    });
  }

  it('an empty schedule yields all zeros', () => {
    const curve = concentrationCurve('iv_bolus', ivParams, [], fineGrid);
    expect(curve).toHaveLength(fineGrid.length);
    expect(curve.every((c) => c === 0)).toBe(true);
  });

  it('two identical doses far apart ≈ two non-overlapping single-dose copies', () => {
    // Second dose 100 h after the first (~25 half-lives) — the first has decayed
    // to effectively nothing by then, so near the second dose the total curve is
    // just the second dose's single-dose curve.
    const dose = 400;
    const gap = 100;
    const schedule = [
      { time: 0, amount: dose },
      { time: gap, amount: dose },
    ];
    for (const s of [0, 1, 2, 4, 8]) {
      const total = concentrationCurve('iv_bolus', ivParams, schedule, [gap + s])[0]!;
      const isolatedSecond = singleDoseConcentration('iv_bolus', ivParams, dose, s);
      expect(total).toBeCloseTo(isolatedSecond, 6);
    }
  });

  it('is linear in the doses — scaling every amount scales the curve', () => {
    const k = 2.5;
    const schedule = [
      { time: 0, amount: 100 },
      { time: 6, amount: 250 },
      { time: 12, amount: 100 },
    ];
    const scaled = schedule.map((d) => ({ ...d, amount: d.amount * k }));
    const base = concentrationCurve('oral', oralParams, schedule, fineGrid);
    const big = concentrationCurve('oral', oralParams, scaled, fineGrid);
    base.forEach((c, i) => expect(big[i]!).toBeCloseTo(c * k, 10));
  });
});

describe('recurringDoses — building a regular schedule', () => {
  it('places count doses of amount at start, start+τ, start+2τ, …', () => {
    const doses = recurringDoses({ amount: 200, count: 4, interval: 8, start: 1 });
    expect(doses).toEqual([
      { time: 1, amount: 200 },
      { time: 9, amount: 200 },
      { time: 17, amount: 200 },
      { time: 25, amount: 200 },
    ]);
  });

  it('defaults the first dose to t = 0', () => {
    const doses = recurringDoses({ amount: 50, count: 3, interval: 6 });
    expect(doses.map((d) => d.time)).toEqual([0, 6, 12]);
  });

  it('count = 0 produces an empty schedule', () => {
    expect(recurringDoses({ amount: 100, count: 0, interval: 6 })).toEqual([]);
  });

  it('count = 1 ignores the interval (single dose)', () => {
    expect(recurringDoses({ amount: 100, count: 1, interval: 0 })).toEqual([
      { time: 0, amount: 100 },
    ]);
  });

  it('rejects a non-integer or negative count', () => {
    expect(() => recurringDoses({ amount: 100, count: 2.5, interval: 6 })).toThrow(/count/);
    expect(() => recurringDoses({ amount: 100, count: -1, interval: 6 })).toThrow(/count/);
  });

  it('rejects a non-positive interval when more than one dose', () => {
    expect(() => recurringDoses({ amount: 100, count: 3, interval: 0 })).toThrow(/interval/);
    expect(() => recurringDoses({ amount: 100, count: 3, interval: -4 })).toThrow(/interval/);
  });
});
