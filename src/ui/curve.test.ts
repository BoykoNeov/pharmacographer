/**
 * curve.ts oracle tests (handoff §10 posture — analytic answers, not snapshots).
 *
 * The engine has its own oracle suite; this covers the UI↔engine glue, focused
 * on the property that must be exact for the Cmax/Tmax markers to be honest:
 * the reported peak lands on the true peak, not the nearest grid sample.
 *   - IV bolus single dose: peak is {t: 0, c: D/Vd} by closed form.
 *   - Single oral dose: marked Tmax equals the compound's reported Tmax (the ka
 *     was inverted from that Tmax, so the Bateman peak must round-trip to it).
 */

import { describe, expect, it } from 'vitest';
import { buildCurve, halfLifeRangeH, metaboliteTag } from './curve.ts';
import { loadAllCompounds } from '../data/loader.ts';
import { REFERENCE_WEIGHT_KG } from '../engine/units.ts';
import type { Compound } from '../data/schema.ts';

const COMPOUNDS = loadAllCompounds();
const byId = (id: string): Compound => {
  const c = COMPOUNDS.find((x) => x.id === id);
  if (!c) throw new Error(`test fixture missing compound "${id}"`);
  return c;
};

const single = (amount: number) => ({ amount, count: 1, interval: 0, adHoc: [] });

describe('buildCurve peak (Cmax/Tmax)', () => {
  it('IV bolus single dose peaks at t=0 with c = D/Vd', () => {
    const caffeine = byId('caffeine'); // Vd 0.6 L/kg
    const dose = 200;
    const { peak } = buildCurve({ compound: caffeine, route: 'iv_bolus', schedule: single(dose) });

    const vdAbsolute = 0.6 * REFERENCE_WEIGHT_KG; // L, scaled to the reference subject
    expect(peak.t).toBe(0);
    expect(peak.c).toBeCloseTo(dose / vdAbsolute, 6);
  });

  it('single oral dose peaks at the compound’s reported Tmax', () => {
    const caffeine = byId('caffeine'); // oral tmax = 1.0 h, ka inverted from it
    const reportedTmaxH = caffeine.routes.oral?.tmax?.value; // 1.0 h (unit: h)
    if (reportedTmaxH == null) throw new Error('test fixture: caffeine oral Tmax missing');
    const { peak } = buildCurve({ compound: caffeine, route: 'oral', schedule: single(100) });

    // Exact because criticalTimes samples the analytic Bateman peak instant.
    expect(peak.t).toBeCloseTo(reportedTmaxH, 3);
    expect(peak.c).toBeGreaterThan(0);
  });

  it('reports the whole-course peak for a recurring oral schedule (accumulation)', () => {
    const caffeine = byId('caffeine');
    const singlePeak = buildCurve({
      compound: caffeine,
      route: 'oral',
      schedule: single(100),
    }).peak;
    const course = buildCurve({
      compound: caffeine,
      route: 'oral',
      schedule: { amount: 100, count: 4, interval: 4, adHoc: [] },
    }).peak;

    // Accumulation ⇒ the multi-dose peak is higher and occurs later than the first.
    expect(course.c).toBeGreaterThan(singlePeak.c);
    expect(course.t).toBeGreaterThan(singlePeak.t);
  });
});

/**
 * Flip-flop oral horizon: when absorption is slower than elimination (ka < ke) the
 * terminal decline follows the SLOW absorption rate, so the horizon must be sized on
 * ka, not ke, or the tail is clipped mid-decay. No shipped compound is flip-flop (all
 * have Tmax < 1/ke), so we synthesize one — engine-capability-only, like the oral-2c/3c
 * paths. The assertion is a mutation check: the pre-fix horizon (sized on the fast ke)
 * cut the tail at ~9% of Cmax, above the 5% threshold below; the fix decays it to ~0.6%.
 */
describe('buildCurve horizon (flip-flop oral, ka < ke)', () => {
  it('sizes the tail on the slow absorption rate so the curve is not clipped', () => {
    // Force flip-flop: a short elimination half-life (fast ke) with a late Tmax (slow
    // ka) ⇒ Tmax (4 h) ≫ 1/ke (1.44 h), the exact condition derive.ts flags.
    const flipFlop = structuredClone(byId('caffeine'));
    const disposition = flipFlop.disposition;
    if (!disposition) throw new Error('test fixture: caffeine disposition missing');
    disposition.halfLife = { ...disposition.halfLife, value: 1, unit: 'h' };
    const oral = flipFlop.routes.oral;
    if (!oral?.tmax) throw new Error('test fixture: caffeine oral Tmax missing');
    oral.tmax = { ...oral.tmax, value: 4, range: undefined };

    const { points, peak, horizonH } = buildCurve({
      compound: flipFlop,
      route: 'oral',
      schedule: single(100),
    });

    const last = points[points.length - 1]!;
    expect(last.t).toBeCloseTo(horizonH, 6); // the grid does reach the horizon
    // Decayed to well under 5% of Cmax by the horizon ⇒ ~5 slow-rate half-lives shown.
    expect(last.c / peak.c).toBeLessThan(0.05);
  });
});

/**
 * `metaboliteTag` is the single source of truth for the "— (active) metabolite"
 * wording shared by the chart legend and the provenance panel, so the two can
 * never drift. It pins BOTH branches — the inactive branch is now live in the
 * data (morphine's M3G is `active: false`), but the chart legend still renders
 * empty under jsdom's static markup, so this unit remains its primary cover.
 */
describe('metaboliteTag', () => {
  it('labels an active metabolite', () => {
    expect(metaboliteTag(true)).toBe('— active metabolite');
  });

  it('labels an inactive metabolite without the "active" qualifier', () => {
    expect(metaboliteTag(false)).toBe('— metabolite');
    expect(metaboliteTag(false)).not.toContain('active');
  });
});

/**
 * The half-life slider's on-screen note is route- and compound-dependent, and
 * this is what makes it so: under flip-flop kinetics the slider moves the
 * curve's HEIGHT and leaves its terminal SLOPE alone — the exact opposite of
 * the sentence the panel printed for every compound alike before acamprosate
 * shipped. Copy silently inherited by a case where it inverts is this project's
 * recurring defect (the transdermal `PeakNote`), and it is invisible to a test
 * that only checks the copy renders. So the test pins the BEHAVIOUR the copy
 * describes, not the copy: if the tail ever starts responding to this slider,
 * the sentence has become false and this fails.
 */
describe('half-life axis regime (flip-flop)', () => {
  /** Terminal decay rate, 1/h, measured over the last quarter of the curve. */
  const terminalRate = (points: { t: number; c: number }[]) => {
    const tail = points.filter((p) => p.c > 0);
    const a = tail[Math.floor(tail.length * 0.75)]!;
    const b = tail[tail.length - 1]!;
    return Math.log(a.c / b.c) / (b.t - a.t);
  };

  it('flags acamprosate’s oral curve as absorption-limited across its whole range', () => {
    const curve = buildCurve({
      compound: byId('acamprosate'),
      route: 'oral',
      schedule: single(666),
    });
    if (curve.model !== 'one_compartment_first_order') throw new Error('expected 1-comp');

    // ka ≈ 0.081/h sits below ke even at the SLOWEST reported half-life (3.5 h
    // ⇒ ke ≈ 0.198/h), so there is no part of the slider that is not flip-flop.
    expect(curve.halfLifeAxisRegime).toBe('absorption_limited');
  });

  it('leaves the tail slope untouched and moves the peak, across that range', () => {
    const acamprosate = byId('acamprosate');
    const range = halfLifeRangeH(acamprosate);
    if (!range) throw new Error('test fixture: acamprosate half-life range missing');

    const at = (halfLifeH: number) =>
      buildCurve({ compound: acamprosate, route: 'oral', schedule: single(666), halfLifeH });
    const fast = at(range.low); // 2.5 h — the FASTEST elimination offered
    const slow = at(range.high); // 3.5 h — the slowest

    // The tail is ka-limited, so a 40% swing in ke moves it not at all. Tight
    // tolerance on purpose: "barely moves" would pass even if the claim broke.
    expect(terminalRate(slow.points)).toBeCloseTo(terminalRate(fast.points), 3);
    // …while the height genuinely moves, which is what the note tells the reader
    // to watch. Slower elimination ⇒ more accumulates ⇒ a higher peak.
    expect(slow.peak.c).toBeGreaterThan(fast.peak.c * 1.1);
  });

  it('calls an ordinary compound elimination-limited', () => {
    const curve = buildCurve({ compound: byId('caffeine'), route: 'oral', schedule: single(100) });
    if (curve.model !== 'one_compartment_first_order') throw new Error('expected 1-comp');
    expect(curve.halfLifeAxisRegime).toBe('elimination_limited');
  });

  it('calls a non-oral route elimination-limited — there is no ka to be slower', () => {
    const curve = buildCurve({
      compound: byId('acamprosate'),
      route: 'iv_bolus',
      schedule: single(666),
    });
    if (curve.model !== 'one_compartment_first_order') throw new Error('expected 1-comp');
    expect(curve.halfLifeAxisRegime).toBe('elimination_limited');
  });
});
