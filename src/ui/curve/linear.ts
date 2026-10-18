/**
 * What the three LINEAR builders share beyond the generic grid: the time horizon,
 * and the critical-time marks for a multi-exponential disposition.
 *
 * Both were written once per model and differed only in which eigenvalue they
 * read, so they take that eigenvalue as an argument. The nonlinear builder keeps
 * its own: a saturable drug has no terminal rate to size a tail on.
 */

import type { DoseEvent, Route } from '../../engine/types.ts';
import { niceCeil } from './grid.ts';

/** The resolved parameters a linear horizon or mark set reads, whatever the model. */
interface InputTiming {
  /** Absorption rate constant, 1/h — present on the engine `oral` path. */
  ka?: number;
  /** Zero-order input window, h — present on the engine `iv_infusion` path only. */
  infusionDuration?: number;
}

/**
 * Pick a time horizon (h) that shows the whole story: the last dose plus a tail
 * of ~5 TERMINAL half-lives (the curve has decayed to ~3% by then), extended for
 * oral so the absorption phase plays out and for an infusion so it covers the
 * infusion plus its decay. `lastDoseTime` shifts the tail to the end of the
 * course so a recurring schedule isn't clipped mid-decay.
 *
 * `terminalRate` is the slowest disposition rate in view — `ke` (1-comp), β
 * (2-comp) or γ (3-comp), lowered further by any slower metabolite `kₘ` or a band
 * edge — so a long-lived line is never clipped mid-decay.
 *
 * Oral is flip-flop-aware: the terminal decline is governed by the SLOWER of
 * absorption (ka) and `terminalRate` — normally the latter, but in flip-flop
 * kinetics (ka below it) absorption is rate-limiting and the tail decays at ka,
 * a LONGER half-life. So the 5-half-life tail is sized on the slower rate, plus
 * ~3 half-lives of the faster (transient) one for the other phase. That reduces
 * EXACTLY to `5·ln2/terminal + 3·ln2/ka` when ka is the faster, so no ordinary
 * compound's horizon moved when flip-flop support landed.
 */
export function curveHorizonLinear(
  route: Route,
  params: InputTiming,
  terminalRate: number,
  lastDoseTime: number,
): number {
  const terminalHalfLife = Math.LN2 / terminalRate;
  let tail = 5 * terminalHalfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    const slowRate = Math.min(params.ka, terminalRate);
    const fastRate = Math.max(params.ka, terminalRate);
    tail = 5 * (Math.LN2 / slowRate) + 3 * (Math.LN2 / fastRate);
  }
  if (params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + 5 * terminalHalfLife);
  }
  return niceCeil(lastDoseTime + tail);
}

/**
 * Critical sample times for a MULTI-exponential (2- or 3-comp) curve. On top of the
 * one-compartment concerns — the IV-bolus jump at each dose (and a hair before it,
 * so the jump draws vertical), the infusion end, the oral peak — this DENSIFIES the
 * fast early phase. The horizon is sized on the slow terminal rate, so a uniform
 * grid gives the distribution phase — the very feature that motivates a second
 * compartment — only a handful of points and aliases it into a straight line (for a
 * drug like remifentanil, into a vertical drop). So marks are log-spaced over the
 * first few half-lives of the FASTEST early rate after each dose: `alpha`, or the
 * absorption ka when that is faster still.
 *
 * `oralPeakTime` is the model's exact single-dose Bateman peak instant, so the
 * marked Cmax/Tmax lands on the true peak. A thunk, because it is only defined
 * (and only evaluated) on the oral path.
 */
export function criticalTimesMultiExp(
  route: Route,
  params: InputTiming,
  alpha: number,
  oralPeakTime: () => number,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const jumpEps = horizonH * 1e-5;
  const oral = route === 'oral' && params.ka !== undefined && params.ka > 0;
  const fastRate = oral ? Math.max(alpha, params.ka!) : alpha;
  const distEnd = Math.min(horizonH, 6 * (Math.LN2 / fastRate));
  const distStart = distEnd * 1e-3;
  const nDist = 40;
  // Geometric offsets spanning the early phase (dense near t = 0).
  const distOffsets = Array.from(
    { length: nDist + 1 },
    (_, i) => distStart * Math.pow(distEnd / distStart, i / nDist),
  );
  const oralPeakOffset = oral ? oralPeakTime() : undefined;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    marks.push(dose.time);
    for (const off of distOffsets) {
      const t = dose.time + off;
      if (t <= horizonH) marks.push(t);
    }
    if (oralPeakOffset !== undefined) {
      const peakT = dose.time + oralPeakOffset;
      if (peakT <= horizonH) marks.push(peakT);
    }
    if (params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
  }
  return marks;
}
