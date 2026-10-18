/**
 * The one-compartment linear builder — the v1 model, and the only one with
 * variability bands (2-/3-comp have no single Vd or half-life to vary; MM has no
 * `disposition` block at all).
 */

import { deriveParams, engineRouteOf, resolveTransdermalInput } from '../../data/derive.ts';
import { concentrationCurve } from '../../engine/dosing.ts';
import { metaboliteConcentrationCurve } from '../../engine/metabolite.ts';
import { FLIP_FLOP_REL_TOL } from '../../engine/models.ts';
import type { DoseEvent, PkParams, Route } from '../../engine/types.ts';
import { fmtNum, fmtPercent } from './format.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, sampleGrid } from './grid.ts';
import { curveHorizonLinear } from './linear.ts';
import { deriveMetabolites, metaboliteCurves } from './metabolites.ts';
import { buildSchedule, lastDoseTime, withInfusionWindow } from './schedule.ts';
import type { CurveInput, HalfLifeAxisRegime, OneCompartmentCurveResult } from './types.ts';
import {
  fRangeOral,
  halfLifeRangeH,
  scaleKe,
  vdRangeL,
  type BandPoint,
  type VariabilityBand,
} from './variability.ts';

/**
 * Analytic time-to-peak (h) of a SINGLE oral dose — the Bateman peak, where the
 * absorption and elimination exponentials balance:
 *
 *   Tmax = ln(ka / ke) / (ka − ke)
 *
 * This is the forward of `derive.ts`'s `kaFromTmax`, so for a compound whose ka
 * was inverted from a reported Tmax it round-trips to that Tmax. As `ka → ke`
 * the expression is 0/0; the analytic limit is `1/ke` (same flip-flop guard the
 * engine's oral model uses). Used to sample the exact oral peak instant so the
 * marked Cmax/Tmax lands on the true peak instead of the nearest grid point.
 */
function oralPeakTime(ka: number, ke: number): number {
  if (Math.abs(ka - ke) <= FLIP_FLOP_REL_TOL * Math.max(ka, ke)) return 1 / ke;
  return Math.log(ka / ke) / (ka - ke);
}

/**
 * Times that MUST be sampled exactly, on top of the uniform grid. An IV-bolus
 * concentration JUMPS at each dose instant, so the true peak lives exactly at
 * `t = dose.time`; a uniform grid that misses it renders whatever the nearest
 * sample decayed to, which aliases the peak height and makes the auto axis
 * flicker as the schedule shifts under the grid (the "add 1 h, peak changes"
 * bug). For each dose we sample:
 *   - `dose.time` itself — pins the exact peak;
 *   - a hair before it (`dose.time − ε`) — so the jump draws vertical instead of
 *     as a diagonal ramp up from the previous uniform sample;
 *   - for an infusion, `dose.time + infusionDuration` — the slope break at the
 *     end of the infusion;
 *   - for oral, `dose.time + oralPeakTime(ka, ke)` — the smooth Bateman peak of
 *     that single dose. Its concentration IS continuous, but the uniform grid
 *     can straddle it, so the marked Cmax/Tmax would otherwise land a fraction
 *     of an hour off — visible against the Tmax the provenance panel reports.
 */
function criticalTimes(
  route: Route,
  params: PkParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  // Small enough to look vertical, large enough to stay well clear of the
  // dedupe threshold (so the pre-dose point is never merged into the dose time).
  const jumpEps = horizonH * 1e-5;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    marks.push(dose.time);
    if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
    if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
      const peakT = dose.time + oralPeakTime(params.ka, params.ke);
      if (peakT <= horizonH) marks.push(peakT);
    }
  }
  return marks;
}

/**
 * Build the chart-ready curve for a dosing schedule. Derives the engine
 * parameters from the compound (throwing, via `deriveParams`, if the compound is
 * nonlinear or the oral route lacks absorption data — the caller catches and
 * shows the message), injects the infusion duration for `iv_infusion`, sizes the
 * time grid to cover the last dose plus its decay, and evaluates the
 * superposition engine over the whole schedule.
 */
export function buildCurve1c(input: CurveInput): OneCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // The engine speaks input types, not clinical routes: a patch IS a zero-order
  // input, so it rides the `iv_infusion` path from here down (handoff §12).
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams(compound, route, { weightKg });

  // Disposition + injected input window, shared by the main line and band. A
  // patch's window is its WEAR PERIOD, read from the product data; an IV
  // infusion's is the user's, from the controls.
  const disposition = withInfusionWindow(
    base,
    engineRoute,
    patch ? patch.wearDurationH : input.infusionDuration,
  );

  // Reference half-life for ke scaling: the reported nominal when there is a
  // range (keeps the band centred), else ln2/ke (identity — no scaling).
  const range = halfLifeRangeH(compound);
  const nominalHalfLifeH = range?.nominal ?? Math.LN2 / base.ke;

  // Main line: slider override (if any), scaled around the derived ke.
  const selectedHalfLifeH =
    input.halfLifeH !== undefined && input.halfLifeH > 0 ? input.halfLifeH : nominalHalfLifeH;
  const mainKe = scaleKe(base.ke, nominalHalfLifeH, selectedHalfLifeH);

  // Vd is varied with ke held fixed (see CurveInput.vdL): a pure vertical
  // rescale, because every 1-comp mode coefficient carries 1/Vd. Nothing about
  // TIMING moves, so the horizon, the critical-time marks, and the oral Bateman
  // peak instant below are all untouched by this axis.
  const vdRange = vdRangeL(compound, base.vd);
  const mainVd = input.vdL !== undefined && input.vdL > 0 ? input.vdL : base.vd;

  // F is oral-only (IV is 1 by definition; a patch stores none at all), so the
  // axis is gated on the ENGINE route — which puts `transdermal` on the excluded
  // side along with the IV routes, exactly where it belongs.
  const baseF = base.F ?? 1;
  const fRange = engineRoute === 'oral' ? fRangeOral(compound, baseF, route) : null;
  const mainF = fRange && input.F !== undefined && input.F > 0 ? input.F : baseF;

  // `F` is written back only on the oral path. On an IV/transdermal curve
  // `base.F` may legitimately be absent, and materialising a `F: 1` there would
  // turn "this route has no bioavailability parameter" into "it has one, equal
  // to 1" in every downstream consumer of `params`.
  const params: PkParams = {
    ...disposition,
    ke: mainKe,
    vd: mainVd,
    ...(engineRoute === 'oral' ? { F: mainF } : {}),
  };

  // Band extremes are FIXED at each parameter's reported low/high (not the
  // sliders): longer half-life ⇒ smaller ke ⇒ slower elimination ⇒ higher
  // exposure; larger Vd ⇒ more dilution ⇒ LOWER exposure (the two axes map onto
  // concentration in opposite directions, which is why the edges are labelled).
  const keSlow = range ? scaleKe(base.ke, nominalHalfLifeH, range.high) : mainKe;
  const keFast = range ? scaleKe(base.ke, nominalHalfLifeH, range.low) : mainKe;

  // Which rate the half-life slider is actually able to move — see
  // {@link HalfLifeAxisRegime}. Decided against the ke EXTREMES, not the nominal:
  // the slider's copy has to hold everywhere the slider can go.
  const halfLifeAxisRegime: HalfLifeAxisRegime =
    engineRoute !== 'oral' || disposition.ka === undefined
      ? 'elimination_limited'
      : disposition.ka < keSlow
        ? 'absorption_limited'
        : disposition.ka >= keFast
          ? 'elimination_limited'
          : 'mixed';

  const doses = buildSchedule(schedule);
  const lastDose = lastDoseTime(doses);
  const metaboliteDerivations = deriveMetabolites(compound, route, weightKg);

  // Size the grid on the slowest curve in view (smallest ke) so neither the band's
  // long-half-life tail nor a slow metabolite is clipped mid-decay.
  const slowestKe = Math.min(mainKe, keSlow, ...metaboliteDerivations.map((d) => d.params.keM));
  // A patch's horizon is the wear period EXACTLY — no decay tail, and no rounding
  // up past it. Every other route pads the window with ~5 half-lives so the tail
  // plays out; doing that here would plot the hours AFTER the patch comes off, and
  // that decline is the one part of a patch curve this model gets wrong (drug keeps
  // absorbing from a skin depot, so the real slope is the absorption rate, not ke).
  // Ending the window at patch-off keeps the unfaithful part out of frame rather
  // than drawing it and disclaiming it. See clonidine.json's `displayNote`.
  const horizonH = patch
    ? lastDose + patch.wearDurationH
    : curveHorizonLinear(engineRoute, disposition, slowestKe, lastDose);
  // Uniform grid for the overall shape, plus the exact dose/infusion instants so
  // discontinuous IV peaks aren't aliased (and the axis doesn't flicker).
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes(engineRoute, params, doses, horizonH),
  );

  const concentrations = concentrationCurve(engineRoute, params, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  // Each band varies ITS OWN axis across the reported range while every other
  // parameter stays where the main line has it. Anchoring to the plotted curve
  // (rather than to the compound's nominals) is what keeps a band an envelope OF
  // the line on screen: a Vd band pinned to the nominal half-life would simply
  // detach from the curve as soon as the half-life slider moved, which reads as a
  // rendering bug and answers a question nobody asked. The cost is that dragging
  // a slider to its own extreme and then reading the other axis's band puts one
  // reported extreme on top of a user-chosen one — but that is a state the reader
  // deliberately steered into, not a combined envelope the app draws unprompted,
  // and at the default (every slider nominal) no edge is doubly extreme.
  const bands: VariabilityBand[] = [];
  const bandPoints = (lowParams: PkParams, highParams: PkParams): BandPoint[] => {
    const low = concentrationCurve(engineRoute, lowParams, doses, times);
    const high = concentrationCurve(engineRoute, highParams, doses, times);
    return times.map((t, i) => ({ t, cLow: low[i] ?? 0, cHigh: high[i] ?? 0 }));
  };
  if (range) {
    bands.push({
      axis: 'half_life',
      lowLabel: `Short t½ ${fmtNum(range.low)} h (fast elim.)`,
      highLabel: `Long t½ ${fmtNum(range.high)} h (slow elim.)`,
      points: bandPoints({ ...params, ke: keFast }, { ...params, ke: keSlow }),
    });
  }
  if (vdRange) {
    // Note the inversion: the LARGE volume gives the LOW concentration.
    bands.push({
      axis: 'vd',
      lowLabel: `Large Vd ${fmtNum(vdRange.high)} L (more dilution)`,
      highLabel: `Small Vd ${fmtNum(vdRange.low)} L (less dilution)`,
      points: bandPoints({ ...params, vd: vdRange.high }, { ...params, vd: vdRange.low }),
    });
  }
  if (fRange) {
    // F maps onto concentration the same way the half-life does (more in ⇒
    // higher), and the OPPOSITE way to Vd — a third reason the edges are
    // labelled by meaning rather than by low/high.
    bands.push({
      axis: 'f',
      lowLabel: `Low F ${fmtPercent(fRange.low)} (less absorbed)`,
      highLabel: `High F ${fmtPercent(fRange.high)} (more absorbed)`,
      points: bandPoints({ ...params, F: fRange.low }, { ...params, F: fRange.high }),
    });
  }

  // The parent as the reader SEES it: a single 1/Vd mode at the plotted mainKe, so
  // moving the half-life, Vd or F slider moves every metabolite line consistently.
  // (The Vd slider's move cancels exactly — see VariabilityAxis.)
  const metabolites = metaboliteCurves(
    metaboliteDerivations,
    engineRoute,
    {
      unitModes: [{ coef: 1 / params.vd, rate: mainKe }],
      cl: mainKe * params.vd,
      ka: params.ka,
      F: params.F,
      infusionDuration: disposition.infusionDuration,
      ivBolus: (mp, d, t) => metaboliteConcentrationCurve({ ...mp, keParent: mainKe }, d, t),
    },
    doses,
    times,
  );

  const halfLifeH = Math.LN2 / mainKe;
  return {
    model: 'one_compartment_first_order',
    points,
    peak: findPeak(points),
    bands: bands.length > 0 ? bands : undefined,
    halfLifeAxisRegime,
    halfLifeRange: range ?? undefined,
    vdRange: vdRange ?? undefined,
    fRange: fRange ?? undefined,
    metabolites,
    params,
    derived,
    warnings,
    halfLifeH,
    horizonH,
  };
}
