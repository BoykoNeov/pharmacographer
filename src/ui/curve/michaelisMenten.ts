/**
 * The Michaelis–Menten (nonlinear) builder — the one path that does not
 * superpose: the whole schedule is integrated at once.
 */

import { deriveParamsMM, engineRouteOf } from '../../data/derive.ts';
import {
  apparentHalfLifeMM,
  firstOrderLimitRateMM,
  ivBolusElapsedTime,
  michaelisMentenCurve,
  type MichaelisMentenParams,
} from '../../engine/modelsMM.ts';
import type { DoseEvent, Route } from '../../engine/types.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, sampleGrid } from './grid.ts';
import { buildSchedule, lastDoseTime, withInfusionWindow } from './schedule.ts';
import type { CurveInput, CurvePoint, MichaelisMentenCurveResult } from './types.ts';

/**
 * Where a nonlinear curve's tail is considered spent: 2% of the peak. The linear
 * horizon uses "5 half-lives" (≈3% remaining) for the same purpose, but a
 * saturable drug HAS no half-life to count, so the threshold has to be stated as
 * a concentration and inverted through the implicit solution instead.
 */
const MM_TAIL_FRACTION = 0.02;

/**
 * Time (h) for a saturable drug to fall from `fromC` to {@link MM_TAIL_FRACTION}
 * of it, exactly, via the IV-bolus implicit solution. Expanding it shows why a
 * nonlinear horizon cannot be a constant:
 *
 *   t = (Vd/Vmax)·(Km·ln(50) + 0.98·fromC)
 *
 * The first term is fixed (the first-order tail, which no drug ever fully
 * escapes) but the second grows LINEARLY with the concentration reached — so
 * doubling the dose of a saturated drug adds a fixed slab of time rather than one
 * half-life. That term is where "twice the drink, twice the wait" comes from.
 */
function decayTimeMM(params: MichaelisMentenParams, fromC: number): number {
  if (!(fromC > 0)) return 0;
  return ivBolusElapsedTime(params, fromC, fromC * MM_TAIL_FRACTION);
}

/**
 * Pick a time horizon (h) for a nonlinear curve: the last dose plus the time to
 * decay from `peakC` to a spent tail, extended for oral so absorption plays out
 * and for an infusion so it covers the infusion itself.
 *
 * The linear {@link curveHorizon} reads its tail straight off `ke`, because a
 * half-life does not care how much drug there is. Here it does — the tail is a
 * function of the concentration actually reached, which is why this takes `peakC`
 * as an argument and why {@link buildCurveMM} has to size the grid in two passes.
 */
function curveHorizonMM(
  route: Route,
  params: MichaelisMentenParams,
  lastDoseTime: number,
  peakC: number,
): number {
  let tail = decayTimeMM(params, peakC);
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    tail += 3 * (Math.LN2 / params.ka);
  }
  if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + decayTimeMM(params, peakC));
  }
  return niceCeilFine(lastDoseTime + tail);
}

/**
 * Round a NONLINEAR horizon up to a readable axis bound, on a finer ladder than
 * {@link niceCeil}'s 1 / 2 / 5 / 10.
 *
 * The coarse ladder is right for a linear curve, whose tail is a heuristic ("5
 * half-lives") and whose exponential keeps decaying visibly however far the axis
 * runs — spare axis there costs nothing and rounds to a friendlier number. A
 * nonlinear decay time is not a heuristic: {@link decayTimeMM} computes it exactly
 * from the implicit solution, so rounding (say) 5.07 h up to 10 h discards
 * precision we actually have and spends half the axis on a tail that is already
 * spent.
 *
 * The SEMI-LOG view is what makes that unacceptable rather than untidy. On the
 * linear axis a spent tail is a flat line hugging zero; on a log axis those same
 * hours are several empty decades, because a saturable drug below its Km reverts
 * to first-order at `Vmax/(Vd·Km)` and free-falls (ethanol's dilute-limit
 * half-life is ~7 minutes). Decades of nothing compress the part that teaches —
 * the flat, saturated plateau and the knee where it ends — into a sliver. The
 * lin/semi-log toggle is pedagogy, not polish (CLAUDE.md), so the horizon owes it
 * a tight bound.
 */
function niceCeilFine(x: number): number {
  if (!(x > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(x)));
  const normalized = x / magnitude;
  const stops = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (stops.find((stop) => normalized <= stop) ?? 10) * magnitude;
}

/**
 * {@link criticalTimes} for a nonlinear curve: the dose instants (and the hair
 * before each, so an IV-bolus jump draws vertical) plus each infusion's end.
 *
 * There is deliberately no oral-peak mark. The linear version pins the Bateman
 * peak exactly because `Tmax = ln(ka/ke)/(ka − ke)` is a closed form; under
 * saturation no such expression exists — there is no `ke`, and the peak moves
 * with dose — so an oral MM Cmax/Tmax is the grid's best sample, exactly as it
 * already is for a multi-dose oral schedule in the linear path.
 */
function criticalTimesMM(
  route: Route,
  params: MichaelisMentenParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const jumpEps = horizonH * 1e-5;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (route === 'iv_bolus') {
      if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    }
    marks.push(dose.time);
    if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
  }
  return marks;
}

/**
 * Build the chart-ready curve for a Michaelis–Menten compound (handoff §12).
 *
 * Structurally simpler than the linear builders in one way and harder in another.
 * Simpler: there is no variability band and no `ke` scaling, because there is no
 * half-life to vary — {@link halfLifeRangeH} returns null for these compounds, and
 * the slider has nothing to move. Harder: the whole schedule must be integrated at
 * once (`michaelisMentenCurve`, not `concentrationCurve`), since the doses
 * interact, and the horizon depends on the peak the curve reaches — which is only
 * known after building it.
 *
 * Hence TWO passes. The first bounds the tail using the largest single dose's
 * ceiling `F·D/Vd`, which is what that dose would reach with nothing else on
 * board. That underestimates a course whose doses accumulate — precisely the case
 * these compounds exist to show — so the curve is rebuilt on a horizon sized from
 * the concentration the probe actually reaches after the last dose. The cost is one
 * extra integration; the alternative is a phenytoin schedule clipped mid-decline.
 */
export function buildCurveMM(input: CurveInput): MichaelisMentenCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // No shipped MM compound offers a patch, but the vocabularies still have to
  // meet here: the integrator, like every engine path, speaks input types.
  const engineRoute = engineRouteOf(route);
  const { params: base, derived, warnings } = deriveParamsMM(compound, route, { weightKg });

  const params = withInfusionWindow(base, engineRoute, input.infusionDuration);

  const doses = buildSchedule(schedule);
  const lastDose = lastDoseTime(doses);

  const build = (horizonH: number): CurvePoint[] => {
    const times = mergeGrid(
      sampleGrid(horizonH, samples),
      criticalTimesMM(engineRoute, params, doses, horizonH),
    );
    const values = michaelisMentenCurve(engineRoute, params, doses, times);
    return times.map((t, i) => ({ t, c: values[i] ?? 0 }));
  };

  // Pass 1 — a provisional horizon from the largest single dose's ceiling.
  const bioavailable = engineRoute === 'oral' ? (params.F ?? 1) : 1;
  const largestDose = doses.reduce((most, dose) => Math.max(most, dose.amount), 0);
  const provisionalPeak = (bioavailable * largestDose) / params.vd;
  const probe = build(curveHorizonMM(engineRoute, params, lastDose, provisionalPeak));

  // Pass 2 — re-size from what the course actually leaves behind. The tail has to
  // clear the highest concentration reached AT OR AFTER the last dose; anything
  // earlier has already decayed and does not govern the right edge.
  //
  // This deliberately TRUSTS the measured peak rather than taking `max(measured,
  // provisional)`. The provisional ceiling `F·D/Vd` is what a dose would reach with
  // nothing eliminated during input — real for an IV bolus, but an overestimate for
  // an oral dose (ethanol absorbs over hours and is being cleared throughout, so it
  // peaks at ~455 mg/L against a 782 mg/L ceiling) and for an infusion. Keeping the
  // max would size every horizon off a concentration the curve never reaches, which
  // is exactly the second pass being cancelled out. Fall back only if the probe
  // found nothing at all (an empty schedule).
  const tailPeak = probe.reduce((most, p) => (p.t >= lastDose && p.c > most ? p.c : most), 0);
  const horizonH = curveHorizonMM(
    engineRoute,
    params,
    lastDose,
    tailPeak > 0 ? tailPeak : provisionalPeak,
  );
  const points = build(horizonH);
  const peak = findPeak(points);

  return {
    model: 'one_compartment_michaelis_menten',
    params,
    points,
    peak,
    derived,
    warnings,
    horizonH,
    apparentHalfLifeAtPeakH: apparentHalfLifeMM(params, peak.c),
    limitHalfLifeH: Math.LN2 / firstOrderLimitRateMM(params),
    saturationAtPeak: peak.c / (params.km + peak.c),
  };
}
