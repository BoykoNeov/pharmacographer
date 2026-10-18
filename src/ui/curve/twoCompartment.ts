/**
 * The two-compartment builder (handoff §12) — reached via `buildCurve`'s model
 * dispatch. A separate function from the 1-comp one, not folded into it, because
 * its disposition is α/β modes (plus an oral absorption mode) rather than a single
 * ke, and it needs early-phase grid densification. Returns a
 * {@link TwoCompartmentCurveResult} so the UI narrows on `model` for the caption.
 */

import { deriveParams2c, engineRouteOf, resolveTransdermalInput } from '../../data/derive.ts';
import { metabolite2cConcentrationCurve } from '../../engine/metabolite.ts';
import {
  concentrationCurve2c,
  oralPeakTime2c,
  twoCompModes,
  twoCompRates,
} from '../../engine/models2c.ts';
import { DEFAULT_SAMPLES, findPeak, mergeGrid, sampleGrid } from './grid.ts';
import { criticalTimesMultiExp, curveHorizonLinear } from './linear.ts';
import { deriveMetabolites, metaboliteCurves } from './metabolites.ts';
import { buildSchedule, lastDoseTime, withInfusionWindow } from './schedule.ts';
import type { CurveInput, TwoCompartmentCurveResult } from './types.ts';

/**
 * Build the chart-ready curve for a two-compartment compound. The 2-comp analogue
 * of the 1-comp builder: derives the parameters (throwing, via `deriveParams2c`,
 * for an oral route lacking absorption data — the caller catches and shows the
 * message), injects the input window, sizes the grid on β and densifies it over α,
 * and evaluates the 2-comp superposition. Metabolites are driven off the parent's
 * α/β modes. No variability band or slider: varying "the" half-life is ill-defined
 * across two eigenvalues.
 */
export function buildCurve2c(input: CurveInput): TwoCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // Routes are model-independent (the mode spine), so a patch on a 2-comp parent
  // needs nothing here but the same clinical→input-type mapping as the 1-comp path.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams2c(compound, route, { weightKg });
  const disposition = withInfusionWindow(
    base,
    engineRoute,
    patch ? patch.wearDurationH : input.infusionDuration,
  );

  const doses = buildSchedule(schedule);
  const lastDose = lastDoseTime(doses);
  const metaboliteDerivations = deriveMetabolites(compound, route, weightKg);

  const { alpha, beta } = twoCompRates(disposition);
  const slowestRate = Math.min(beta, ...metaboliteDerivations.map((d) => d.params.keM));
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
      () => oralPeakTime2c(disposition),
      doses,
      horizonH,
    ),
  );

  const concentrations = concentrationCurve2c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites = metaboliteCurves(
    metaboliteDerivations,
    engineRoute,
    {
      unitModes: twoCompModes(disposition, 1),
      cl: disposition.cl,
      ka: disposition.ka,
      F: disposition.F,
      infusionDuration: disposition.infusionDuration,
      ivBolus: (mp, d, t) => metabolite2cConcentrationCurve(disposition, mp, d, t),
    },
    doses,
    times,
  );

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
