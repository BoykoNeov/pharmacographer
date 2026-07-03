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
import { buildCurve, metaboliteTag } from './curve.ts';
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
    const singlePeak = buildCurve({ compound: caffeine, route: 'oral', schedule: single(100) }).peak;
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
 * `metaboliteTag` is the single source of truth for the "— (active) metabolite"
 * wording shared by the chart legend and the provenance panel, so the two can
 * never drift. It pins BOTH branches — the inactive branch in particular is not
 * reachable by any render test (no inactive metabolite ships, and the chart
 * legend renders empty under jsdom's static markup), so this is its only cover.
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
