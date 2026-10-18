import {
  deriveMetaboliteDisposition,
  deriveParams2c,
  engineRouteOf,
  resolveTransdermalInput,
} from '../../data/derive.ts';
import {
  infusionMetaboliteConcentrationCurve,
  metabolite2cConcentrationCurve,
  oralMetaboliteConcentrationCurve,
} from '../../engine/metabolite.ts';
import {
  concentrationCurve2c,
  oralPeakTime2c,
  twoCompModes,
  twoCompRates,
} from '../../engine/models2c.ts';
import type { DoseEvent, Route, TwoCompParams } from '../../engine/types.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, niceCeil, sampleGrid } from './grid.ts';
import { stripFirstPassUnlessOral } from './metabolites.ts';
import { DEFAULT_INFUSION_DURATION_H, buildSchedule } from './schedule.ts';
import type { CurveInput, MetaboliteCurve, TwoCompartmentCurveResult } from './types.ts';

// ── Two-compartment glue (handoff §12) ──────────────────────────────────────
// The parallel build path for `two_compartment_first_order` compounds, reached
// via `buildCurve`'s model dispatch. Kept a separate function (not folded into
// the 1-comp body) because its disposition is α/β modes (plus an oral absorption
// mode), not a single ke, and it needs early-phase grid densification. Returns a
// {@link TwoCompartmentCurveResult} so the UI narrows on `model` for the caption.
// (The metabolite `<Line>` rows remain deferred, as with the metabolites spike.)

/**
 * Pick a 2-comp time horizon (h): the last dose plus ~5 TERMINAL (β) half-lives,
 * extended for an infusion to cover the infusion plus its decay, and for oral so
 * the absorption phase (~3 ka half-lives) plays out. Sized on the `slowestRate`
 * (the smallest of β and any metabolite's kₘ) so a long-lived metabolite isn't
 * clipped mid-decay — the 2-comp analogue of {@link curveHorizon}.
 */
function curveHorizon2c(
  route: Route,
  params: TwoCompParams,
  slowestRate: number,
  lastDoseTime: number,
): number {
  const terminalHalfLife = Math.LN2 / slowestRate;
  let tail = 5 * terminalHalfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    // Flip-flop-aware, as in {@link curveHorizon}: the terminal decline follows the
    // SLOWER of absorption (ka) and the terminal disposition rate (`slowestRate` —
    // already the min of β and any metabolite kₘ). In flip-flop (ka < β) the tail
    // decays at ka, so sizing on β alone would clip it. Reduces EXACTLY to the
    // previous `5·ln2/β + 3·ln2/ka` when ka > slowestRate.
    const terminalRate = Math.min(params.ka, slowestRate);
    const transientRate = Math.max(params.ka, slowestRate);
    tail = 5 * (Math.LN2 / terminalRate) + 3 * (Math.LN2 / transientRate);
  }
  if (params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + 5 * terminalHalfLife);
  }
  return niceCeil(lastDoseTime + tail);
}

/**
 * Critical sample times for a 2-comp curve. On top of the {@link criticalTimes}
 * concerns (the IV-bolus jump at each dose, the infusion end, the oral peak), this
 * DENSIFIES the fast early phase: the horizon is sized on the slow terminal β, so
 * a uniform grid gives the α distribution phase — the very feature that motivates
 * 2-comp — only a handful of points and aliases it into a straight line. We add
 * log-spaced marks over the first few half-lives of the FASTEST early rate after
 * each dose (α, or the absorption ka when it is faster still, for oral) so the
 * knee renders truthfully; for oral we also pin the exact Bateman peak instant so
 * the marked Cmax/Tmax lands on the true peak.
 */
function criticalTimes2c(
  route: Route,
  params: TwoCompParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const { alpha } = twoCompRates(params);
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
  // Geometric offsets spanning the early phase (dense near t = 0).
  const distOffsets = Array.from(
    { length: nDist + 1 },
    (_, i) => distStart * Math.pow(distEnd / distStart, i / nDist),
  );
  const oralPeakOffset =
    route === 'oral' && params.ka !== undefined && params.ka > 0
      ? oralPeakTime2c(params)
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
 * Build the chart-ready curve for a two-compartment compound (handoff §12). The
 * 2-comp analogue of {@link buildCurve}: derives {@link TwoCompParams} (throwing,
 * via `deriveParams2c`, for a nonlinear compound or an oral route lacking
 * absorption data — the caller catches and shows the message), injects the
 * infusion duration and oral absorption (ka/F), sizes and densifies the grid, and
 * evaluates the 2-comp superposition (IV bolus, IV infusion, or oral). Metabolites
 * (IV-bolus, oral, or IV-infusion parent) are driven off the parent's α/β modes.
 * Variability band/slider are intentionally omitted — varying a single half-life
 * is ill-defined across two eigenvalues (a §12 follow-on, like the 1-comp band).
 */
export function buildCurve2c(input: CurveInput): TwoCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // Routes are model-independent (the mode spine), so a patch on a 2-comp parent
  // needs nothing here but the same clinical→input-type mapping as the 1-comp path.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams2c(compound, route, { weightKg });

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
  // front so a long-lived metabolite (keM < β) extends the horizon below.
  const metaboliteDerivations =
    (engineRoute === 'iv_bolus' || engineRoute === 'oral' || engineRoute === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...stripFirstPassUnlessOral(route, deriveMetaboliteDisposition(m, { weightKg })),
        }))
      : [];

  const { beta } = twoCompRates(disposition);
  const slowestRate = Math.min(beta, ...metaboliteDerivations.map((d) => d.params.keM));
  // Patch horizon = the wear period exactly; see buildCurve for why no decay tail.
  const horizonH = patch
    ? lastDoseTime + patch.wearDurationH
    : curveHorizon2c(engineRoute, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes2c(engineRoute, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve2c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites: MetaboliteCurve[] | undefined = metaboliteDerivations.length
    ? metaboliteDerivations.map(({ meta, params: mp, derived: mDerived, warnings: mWarnings }) => {
        const c =
          // ENGINE route: an IM parent forms its metabolite through the same
          // first-order-input convolution as an oral one. What differs is the
          // pre-systemic term, already stripped by `stripFirstPassUnlessOral`.
          engineRoute === 'oral'
            ? oralMetaboliteConcentrationCurve(
                twoCompModes(disposition, 1),
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
                  twoCompModes(disposition, 1),
                  disposition.cl,
                  mp,
                  doses,
                  disposition.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
                  times,
                )
              : metabolite2cConcentrationCurve(disposition, mp, doses, times);
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

  const { alpha } = twoCompRates(disposition);
  return {
    model: 'two_compartment_first_order',
    points,
    peak: findPeak(points),
    metabolites,
    params: disposition,
    derived,
    warnings,
    distributionHalfLifeH: Math.LN2 / alpha,
    terminalHalfLifeH: Math.LN2 / beta,
    horizonH,
  };
}
