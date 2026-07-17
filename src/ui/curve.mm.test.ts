/**
 * MAGNITUDE checks for the two nonlinear compounds, built through `buildCurve`
 * from the shipped JSON (handoff §12; docs/DATA_GUIDE.md).
 *
 * CLAUDE.md names this the project's first standing trap: `npm test` proves
 * structure and derivation, never numeric correctness — a compound whose Vmax is
 * off by 24× still parses, still derives, and still draws a smooth curve. The
 * documented remedy is to build the engine curve and compare it against a
 * concentration a source actually reported. For phenytoin and ethanol that check
 * is written down here rather than performed once by hand, because both are
 * curated from Michaelis–Menten parameters whose SLOPE (Vmax/Vd) and SATURATION
 * (Km) are only meaningful together — a plausible-looking edit to any single one
 * silently moves the teaching point.
 *
 * The anchors are the reported numbers, not the model's own output:
 *   - phenytoin: Css = R0·Km/(Vmax − R0), against the 10–20 mg/L therapeutic
 *     range and the label's "10% dose increase" warning;
 *   - ethanol:   the ~15 mg/dL/h canonical elimination slope, and the peak from
 *     Norberg's own 0.4 g/kg dose.
 */

import { describe, expect, it } from 'vitest';
import { buildCurve } from './curve.ts';
import { loadAllCompounds } from '../data/loader.ts';
import { infusionSteadyStateMM } from '../engine/modelsMM.ts';
import type { Compound } from '../data/schema.ts';

const COMPOUNDS = loadAllCompounds();
const byId = (id: string): Compound => {
  const c = COMPOUNDS.find((x) => x.id === id);
  if (!c) throw new Error(`test fixture missing compound "${id}"`);
  return c;
};

/** Concentration at time `t` from a built curve, by nearest sample. */
function concentrationAt(points: Array<{ t: number; c: number }>, t: number): number {
  let best = points[0];
  if (!best) throw new Error('empty curve');
  for (const p of points) {
    if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  }
  return best.c;
}

describe('phenytoin — the dose→steady-state cliff', () => {
  const phenytoin = byId('phenytoin');

  it('is curated as a nonlinear compound with no half-life to state', () => {
    expect(phenytoin.model).toBe('one_compartment_michaelis_menten');
    expect(phenytoin.linear).toBe(false);
    expect(phenytoin.disposition).toBeUndefined();
  });

  it('resolves Vmax and Km to the values Frame & Beal reported', () => {
    const curve = buildCurve({
      compound: phenytoin,
      route: 'iv_infusion',
      schedule: { amount: 100, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    if (curve.model !== 'one_compartment_michaelis_menten') throw new Error('expected the MM model');
    // 580 mg/day → mg/h; Vd 0.95 L/kg × 70 kg.
    expect(curve.params.vmax).toBeCloseTo(580 / 24, 6);
    expect(curve.params.km).toBeCloseTo(7.9, 6);
    expect(curve.params.vd).toBeCloseTo(66.5, 6);
  });

  it('300 mg/day lands in range and 400 mg/day more than doubles it — the label warning', () => {
    // The relationship this compound exists to teach, checked against the
    // therapeutic range rather than against the model. Css = R0·Km/(Vmax − R0)
    // is exact and, notably, contains no Vd — so the softest curated input
    // (an albumin-conditional volume) cannot move this result at all.
    if (!phenytoin.dispositionMM) throw new Error('phenytoin must carry dispositionMM');
    const vmaxPerHour = 580 / 24;
    const params = { vd: 66.5, vmax: vmaxPerHour, km: 7.9 };

    const css300 = infusionSteadyStateMM(params, 300 / 24);
    const css400 = infusionSteadyStateMM(params, 400 / 24);
    const css500 = infusionSteadyStateMM(params, 500 / 24);

    // 300 mg/day is the label's standard adult maintenance dose: sub-therapeutic
    // to low-therapeutic. 400 mg/day is inside the 10–20 mg/L window. 500 mg/day
    // is frank toxicity. A 33% dose rise crosses the entire window.
    expect(css300).toBeGreaterThan(7);
    expect(css300).toBeLessThan(10);
    expect(css400).toBeGreaterThan(15);
    expect(css400).toBeLessThan(20);
    expect(css500).toBeGreaterThan(40);
    expect(css400 / css300).toBeGreaterThan(2);

    // Above Vmax no steady state exists at all — input outruns the maximum the
    // body can clear, and concentration climbs without bound.
    expect(infusionSteadyStateMM(params, 600 / 24)).toBe(Infinity);
  });

  it('reproduces the label\'s own 7–42 h half-life range from saturation alone', () => {
    // The Dilantin label reports "22 hours, with a range of 7 to 42 hours" and,
    // one paragraph later, explains why that cannot be a constant. The apparent
    // half-life at the TOP of the therapeutic range should land near the label's
    // upper bound — from concentration dependence, with no between-patient
    // variability invoked.
    const highDose = buildCurve({
      compound: phenytoin,
      route: 'iv_infusion',
      schedule: { amount: 1330, count: 1, interval: 0, adHoc: [] }, // ~20 mg/L peak
      infusionDuration: 0.5,
    });
    if (highDose.model !== 'one_compartment_michaelis_menten') throw new Error('expected MM');
    expect(highDose.peak.c).toBeGreaterThan(18);
    expect(highDose.peak.c).toBeLessThan(21);
    // ~43 h at 20 mg/L vs the label's 42 h upper bound.
    expect(highDose.apparentHalfLifeAtPeakH).toBeGreaterThan(38);
    expect(highDose.apparentHalfLifeAtPeakH).toBeLessThan(46);
    // ~15 h floor — BELOW the label's 22 h average, above its 7 h lower bound.
    // The residue the model cannot reach is the genuine between-patient part.
    expect(highDose.limitHalfLifeH).toBeGreaterThan(13);
    expect(highDose.limitHalfLifeH).toBeLessThan(17);
    // The half-life nearly triples across the range — this is the whole point.
    expect(highDose.apparentHalfLifeAtPeakH / highDose.limitHalfLifeH).toBeGreaterThan(2.5);
  });
});

describe('ethanol — the straight-line decline', () => {
  const ethanol = byId('ethanol');

  it('is curated as a nonlinear compound with no half-life to state', () => {
    expect(ethanol.model).toBe('one_compartment_michaelis_menten');
    expect(ethanol.linear).toBe(false);
    expect(ethanol.disposition).toBeUndefined();
  });

  it('eliminates at the canonical ~15 mg/dL/h — the number that must be right', () => {
    // Vmax and Vd are curated from the SAME study precisely so this ratio is the
    // one Norberg measured. 15.9 mg/dL/h against the ~15 mg/dL/h that clinical
    // and forensic sources report. If an edit ever moves Vmax or Vd
    // independently, this is what catches it.
    const curve = buildCurve({
      compound: ethanol,
      route: 'iv_infusion',
      schedule: { amount: 28_000, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    if (curve.model !== 'one_compartment_michaelis_menten') throw new Error('expected MM');
    const slopeMgPerLPerH = curve.params.vmax / curve.params.vd; // mg/L/h
    const slopeMgPerDlPerH = slopeMgPerLPerH / 10;
    expect(slopeMgPerDlPerH).toBeGreaterThan(14);
    expect(slopeMgPerDlPerH).toBeLessThan(18);
  });

  it('peaks near 0.078 g/dL at Norberg\'s own 0.4 g/kg IV dose', () => {
    // The study's dose in the study's subjects: 0.4 g/kg × 70 kg = 28 g, which
    // reached ~0.7–0.8 g/L in venous blood.
    const curve = buildCurve({
      compound: ethanol,
      route: 'iv_infusion',
      schedule: { amount: 28_000, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    expect(curve.peak.c).toBeGreaterThan(650); // mg/L
    expect(curve.peak.c).toBeLessThan(800);
  });

  it('falls in a STRAIGHT line — the property that is not an exponential', () => {
    // The signature. Sample three points down the decline and require the drop
    // per hour to be near-constant, which no first-order curve can be: an
    // exponential's slope falls in proportion to what is left.
    const curve = buildCurve({
      compound: ethanol,
      route: 'iv_infusion',
      schedule: { amount: 28_000, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    const c1 = concentrationAt(curve.points, 1);
    const c2 = concentrationAt(curve.points, 2);
    const c3 = concentrationAt(curve.points, 3);
    const drop1 = c1 - c2;
    const drop2 = c2 - c3;
    // Consecutive hourly drops within 2% of each other — a straight line. For a
    // first-order drug with this curve's ~2 h apparent half-life, the second
    // hour's drop would be ~30% smaller than the first.
    expect(Math.abs(drop1 - drop2) / drop1).toBeLessThan(0.02);
    // And each hourly drop is the zero-order slope, ~159 mg/L/h.
    expect(drop1).toBeGreaterThan(140);
    expect(drop1).toBeLessThan(175);
  });

  it('oral ships with ka, F assumed 1, and the overestimate flagged', () => {
    const curve = buildCurve({
      compound: ethanol,
      route: 'oral',
      schedule: { amount: 28_000, count: 1, interval: 0, adHoc: [] },
    });
    if (curve.model !== 'one_compartment_michaelis_menten') throw new Error('expected MM');
    expect(curve.params.ka).toBeCloseTo(1.29, 6);
    // No source reports an oral F, so the derivation assumes 1 and must SAY so —
    // the curve is an upper bound, and the honesty panel has to carry that.
    expect(curve.params.F).toBe(1);
    expect(curve.warnings.some((w) => w.parameter === 'F' && /overestimates/.test(w.message))).toBe(
      true,
    );
    // Oral rises then falls: unlike the IV curve it does not peak at t = 0.
    expect(curve.peak.t).toBeGreaterThan(0.5);
    expect(curve.peak.c).toBeLessThan(28_000 / 35.8); // strictly under the F·D/Vd ceiling
  });

  it('doubling the dose MORE than doubles the time to clear', () => {
    // "Twice the drink, twice the wait" — and actually a little worse. A linear
    // drug would need one extra half-life regardless of dose; a saturated one
    // needs a slab of time proportional to the dose itself.
    const one = buildCurve({
      compound: ethanol,
      route: 'iv_infusion',
      schedule: { amount: 28_000, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    const two = buildCurve({
      compound: ethanol,
      route: 'iv_infusion',
      schedule: { amount: 56_000, count: 1, interval: 0, adHoc: [] },
      infusionDuration: 0.5,
    });
    if (one.model !== 'one_compartment_michaelis_menten') throw new Error('expected MM');
    if (two.model !== 'one_compartment_michaelis_menten') throw new Error('expected MM');
    // Twice the dose ⇒ twice the peak (distribution is linear; only ELIMINATION
    // saturates) …
    expect(two.peak.c / one.peak.c).toBeGreaterThan(1.9);
    // … but the apparent half-life at that peak nearly doubles too, which for a
    // linear drug would be impossible — its half-life cannot depend on dose.
    expect(two.apparentHalfLifeAtPeakH / one.apparentHalfLifeAtPeakH).toBeGreaterThan(1.8);
    // And at both doses the enzymes are essentially flat out.
    expect(one.saturationAtPeak).toBeGreaterThan(0.95);
    expect(two.saturationAtPeak).toBeGreaterThan(0.95);
  });
});
