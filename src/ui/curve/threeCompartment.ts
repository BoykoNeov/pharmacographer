/**
 * The three-compartment builder (handoff §12, Stage B) — reached via
 * `buildCurve`'s model dispatch. Like the 2-comp builder its disposition is a set
 * of exponential modes (α, β, γ) rather than a single ke, and it needs early-phase
 * grid densification. Covers all three engine input types, though no shipped
 * 3-comp compound declares an oral Tmax yet, so oral is engine capability rather
 * than a live route today.
 */

import { deriveParams3c, engineRouteOf, resolveTransdermalInput } from '../../data/derive.ts';
import { metabolite3cConcentrationCurve } from '../../engine/metabolite.ts';
import {
  concentrationCurve3c,
  oralPeakTime3c,
  threeCompModes,
  threeCompRates,
} from '../../engine/models3c.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, sampleGrid } from './grid.ts';
import { criticalTimesMultiExp, curveHorizonLinear } from './linear.ts';
import { deriveMetabolites, metaboliteCurves } from './metabolites.ts';
import { buildSchedule, lastDoseTime, withInfusionWindow } from './schedule.ts';
import type { CurveInput, ThreeCompartmentCurveResult } from './types.ts';

/**
 * Build the chart-ready curve for a three-compartment compound. The 3-comp
 * analogue of the 2-comp builder: derives the parameters
 * (throwing, via `deriveParams3c`, for an oral route lacking absorption data),
 * injects the input window, sizes the grid on γ and densifies it over α, and
 * evaluates the 3-comp superposition. Metabolites are driven off the α/β/γ modes.
 * Returns all three half-lives for the caption; no band, for the 2-comp reason.
 */
export function buildCurve3c(input: CurveInput): ThreeCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // As in the 1-/2-comp paths: the mode spine makes routes model-independent, so a
  // patch costs nothing here beyond mapping the clinical route to its input type.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams3c(compound, route, { weightKg });
  const disposition = withInfusionWindow(
    base,
    engineRoute,
    patch ? patch.wearDurationH : input.infusionDuration,
  );

  const doses = buildSchedule(schedule);
  const lastDose = lastDoseTime(doses);
  const metaboliteDerivations = deriveMetabolites(compound, route, weightKg);

  const { alpha, beta, gamma } = threeCompRates(disposition);
  const slowestRate = Math.min(gamma, ...metaboliteDerivations.map((d) => d.params.keM));
  // Patch horizon = the wear period exactly; see the 1-comp builder for why no tail.
  const horizonH = patch
    ? lastDose + patch.wearDurationH
    : curveHorizonLinear(engineRoute, disposition, slowestRate, lastDose);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimesMultiExp(
      engineRoute,
      disposition,
      alpha,
      () => oralPeakTime3c(disposition),
      doses,
      horizonH,
    ),
  );

  const concentrations = concentrationCurve3c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites = metaboliteCurves(
    metaboliteDerivations,
    engineRoute,
    {
      unitModes: threeCompModes(disposition, 1),
      cl: disposition.cl,
      ka: disposition.ka,
      F: disposition.F,
      infusionDuration: disposition.infusionDuration,
      ivBolus: (mp, d, t) => metabolite3cConcentrationCurve(disposition, mp, d, t),
    },
    doses,
    times,
  );

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
