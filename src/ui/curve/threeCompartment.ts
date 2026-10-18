import {
  deriveMetaboliteDisposition,
  deriveParams3c,
  engineRouteOf,
  resolveTransdermalInput,
} from '../../data/derive.ts';
import {
  infusionMetaboliteConcentrationCurve,
  metabolite3cConcentrationCurve,
  oralMetaboliteConcentrationCurve,
} from '../../engine/metabolite.ts';
import {
  concentrationCurve3c,
  oralPeakTime3c,
  threeCompModes,
  threeCompRates,
} from '../../engine/models3c.ts';
import type { DoseEvent, Route, ThreeCompParams } from '../../engine/types.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, niceCeil, sampleGrid } from './grid.ts';
import { stripFirstPassUnlessOral } from './metabolites.ts';
import { DEFAULT_INFUSION_DURATION_H, buildSchedule } from './schedule.ts';
import type { CurveInput, MetaboliteCurve, ThreeCompartmentCurveResult } from './types.ts';

// ── Three-compartment glue (handoff §12, Stage B) ───────────────────────────
// The parallel build path for `three_compartment_first_order` compounds, reached
// via `buildCurve`'s model dispatch. Like the 2-comp path its disposition is a set
// of exponential modes (α, β, γ) rather than a single ke, and it needs early-phase
// grid densification. Covers all three routes (IV bolus, IV infusion, and oral — a
// four-exponential parent whose ka comes from `deriveParams3c`/`kaFromTmax3c`), though
// no shipped 3-comp compound declares an oral Tmax yet, so oral is engine capability
// rather than a live route today. Returns a {@link ThreeCompartmentCurveResult} so the
// UI narrows on `model` for the caption. Metabolites (IV-bolus, oral, or IV-infusion
// parent) are driven off the parent's α/β/γ modes, as in the 2-comp path; the band is
// intentionally omitted (varying one half-life across three eigenvalues is ill-defined).

/**
 * Pick a 3-comp time horizon (h): the last dose plus ~5 TERMINAL (γ) half-lives,
 * extended for an infusion to cover the infusion plus its decay, and for oral so the
 * absorption phase (~3 ka half-lives) plays out. The 3-comp analogue of
 * {@link curveHorizon2c}; sized on the slow terminal γ so the long tail isn't clipped.
 */
function curveHorizon3c(
  route: Route,
  params: ThreeCompParams,
  terminalRate: number,
  lastDoseTime: number,
): number {
  const terminalHalfLife = Math.LN2 / terminalRate;
  let tail = 5 * terminalHalfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    // Flip-flop-aware, as in {@link curveHorizon}: the terminal decline follows the
    // SLOWER of absorption (ka) and the terminal disposition rate (`terminalRate` —
    // already the min of γ and any metabolite kₘ). In flip-flop (ka < γ) the tail
    // decays at ka, so sizing on γ alone would clip it. Reduces EXACTLY to the
    // previous `5·ln2/γ + 3·ln2/ka` when ka > terminalRate.
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
 * Critical sample times for a 3-comp curve. Like {@link criticalTimes2c} it pins the
 * IV-bolus jump at each dose, the infusion end, and (for oral) the exact Bateman peak,
 * and DENSIFIES the fast early phase — the horizon is sized on the slow terminal γ, so
 * without densification the α distribution and β intermediate phases (which span only
 * the first few minutes for a drug like remifentanil) alias into a straight vertical
 * drop. We log-space marks over the first few half-lives of the FASTEST early rate after
 * each dose (α, or the absorption ka when it is faster still, for oral) so both early
 * knees render truthfully; for oral we also pin the exact {@link oralPeakTime3c} instant
 * so the marked Cmax/Tmax lands on the true peak.
 */
function criticalTimes3c(
  route: Route,
  params: ThreeCompParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const { alpha } = threeCompRates(params);
  const jumpEps = horizonH * 1e-5;
  // Densify over the fastest early phase — α, or a faster absorption ka (oral).
  const fastRate =
    route === 'oral' && params.ka !== undefined && params.ka > 0
      ? Math.max(alpha, params.ka)
      : alpha;
  const fastHalfLife = Math.LN2 / fastRate;
  const distEnd = Math.min(horizonH, 6 * fastHalfLife);
  const distStart = distEnd * 1e-3;
  const nDist = 40;
  const distOffsets = Array.from(
    { length: nDist + 1 },
    (_, i) => distStart * Math.pow(distEnd / distStart, i / nDist),
  );
  const oralPeakOffset =
    route === 'oral' && params.ka !== undefined && params.ka > 0
      ? oralPeakTime3c(params)
      : undefined;
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

/**
 * Build the chart-ready curve for a three-compartment compound (handoff §12,
 * Stage B). The 3-comp analogue of {@link buildCurve2c}: derives {@link ThreeCompParams}
 * (throwing, via `deriveParams3c`, for a nonlinear compound or an oral route lacking
 * absorption data — the caller catches and shows the message), injects the infusion
 * duration and oral absorption (ka/F), sizes and densifies the grid on the α/γ
 * eigenvalues, and evaluates the 3-comp superposition (IV bolus, IV infusion, or oral).
 * Metabolites (IV-bolus, oral, or IV-infusion parent) are driven off the α/β/γ modes.
 * Returns α/β/γ half-lives for the caption.
 */
export function buildCurve3c(input: CurveInput): ThreeCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // As in the 1-/2-comp paths: the mode spine makes routes model-independent, so a
  // patch costs nothing here beyond mapping the clinical route to its input type.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams3c(compound, route, { weightKg });

  let disposition = base;
  if (engineRoute === 'iv_infusion') {
    const requested = patch ? patch.wearDurationH : input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < γ) extends the horizon below.
  const metaboliteDerivations =
    (engineRoute === 'iv_bolus' || engineRoute === 'oral' || engineRoute === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...stripFirstPassUnlessOral(route, deriveMetaboliteDisposition(m, { weightKg })),
        }))
      : [];

  const { alpha, beta, gamma } = threeCompRates(disposition);
  const slowestRate = Math.min(gamma, ...metaboliteDerivations.map((d) => d.params.keM));
  // Patch horizon = the wear period exactly; see buildCurve for why no decay tail.
  const horizonH = patch
    ? lastDoseTime + patch.wearDurationH
    : curveHorizon3c(engineRoute, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes3c(engineRoute, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve3c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites: MetaboliteCurve[] | undefined = metaboliteDerivations.length
    ? metaboliteDerivations.map(({ meta, params: mp, derived: mDerived, warnings: mWarnings }) => {
        const c =
          // ENGINE route: an IM parent forms its metabolite through the same
          // first-order-input convolution as an oral one. What differs is the
          // pre-systemic term, already stripped by `stripFirstPassUnlessOral`.
          engineRoute === 'oral'
            ? oralMetaboliteConcentrationCurve(
                threeCompModes(disposition, 1),
                disposition.cl,
                disposition.ka ?? 0,
                disposition.F ?? 1,
                mp,
                doses,
                times,
              )
            : // ENGINE route, not the clinical one. This read `route === 'iv_infusion'`,
              // while the gate admitting a compound to this branch at all (above) asks
              // `engineRoute`. A patch passes that gate — `engineRouteOf('transdermal')`
              // IS `iv_infusion` — and then failed this test, so a transdermal parent
              // declaring a metabolite would have had its metabolite drawn with the
              // IV-BOLUS formation model: the whole wear-period dose arriving at t = 0.
              // Latent rather than live (clonidine declares no metabolites), and found
              // by grepping route ternaries while consolidating the peak copy. Same
              // lesson as `fRangeOral` reading `routes.oral` under an engine-route gate.
              engineRoute === 'iv_infusion'
              ? infusionMetaboliteConcentrationCurve(
                  threeCompModes(disposition, 1),
                  disposition.cl,
                  mp,
                  doses,
                  disposition.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
                  times,
                )
              : metabolite3cConcentrationCurve(disposition, mp, doses, times);
        const mPoints = times.map((t, i) => ({ t, c: c[i] ?? 0 }));
        return {
          id: meta.id,
          name: meta.name,
          active: meta.active,
          points: mPoints,
          peak: findPeak(mPoints),
          derived: mDerived,
          warnings: mWarnings,
        };
      })
    : undefined;

  return {
    model: 'three_compartment_first_order',
    points,
    peak: findPeak(points),
    metabolites,
    params: disposition,
    derived,
    warnings,
    distributionHalfLifeH: Math.LN2 / alpha,
    intermediateHalfLifeH: Math.LN2 / beta,
    terminalHalfLifeH: Math.LN2 / gamma,
    horizonH,
  };
}
