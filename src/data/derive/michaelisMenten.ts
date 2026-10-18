/**
 * The Michaelis–Menten resolver (handoff §12; the nonlinear seam): Vd, Vmax and
 * Km from the `dispositionMM` block, plus first-order absorption from a cited ka.
 */

import type { MichaelisMentenParams } from '../../engine/modelsMM.ts';
import {
  REFERENCE_WEIGHT_KG,
  concentration as concentrationConverter,
  concentrationRate,
  massRate,
  rateConstant,
  type ConcentrationRateUnit,
  type ConcentrationUnit,
  type MassRateUnit,
} from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { absorptionRouteOf, bioavailabilityLabel, engineRouteOf } from './routes.ts';
import { fmt, resolveVolumeParam } from './shared.ts';
import type { DeriveOptions, DeriveWarning, DerivedNote } from './types.ts';

/** Resolved Michaelis–Menten engine parameters plus the provenance of what was derived. */
export interface DerivedParamsMM {
  /** Canonical-unit MM parameters ready for `engine/modelsMM.ts`. */
  params: MichaelisMentenParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, per-kg scaling, Vmax derived from a slope, … */
  warnings: DeriveWarning[];
}

/** The `MaxRateUnit` members that express Vmax as a CONCENTRATION slope (Vmax/Vd). */
const CONCENTRATION_RATE_UNITS: ReadonlySet<string> = new Set<ConcentrationRateUnit>([
  'mg/L/h',
  'g/L/h',
  'mg/dL/h',
  'g/dL/h',
]);

/**
 * Resolve Vmax to the engine's canonical absolute mg/h, from either literature
 * form (see the schema's `MaxRateUnit`):
 *
 * - a **mass rate** (`mg/day`, and the per-kg variants that scale against the
 *   reference subject) — how phenytoin's Vmax is usually printed;
 * - a **concentration slope** (`mg/dL/h`) — how ethanol's is universally printed,
 *   because what is actually measured is the straight-line fall of blood alcohol.
 *   That slope IS `Vmax/Vd`, so it becomes a mass rate by multiplying by Vd,
 *   which makes the resolved Vmax depend on the volume — recorded as derived.
 */
function resolveVmax(
  param: { value: number; unit: string },
  vd: number,
  weightKg: number,
  derived: DerivedNote[],
): number {
  const { value, unit } = param;

  if (unit === 'mg/h/kg' || unit === 'mg/day/kg') {
    const perKgPerHour = unit === 'mg/h/kg' ? value : value / 24;
    const absolute = perKgPerHour * weightKg;
    derived.push({
      parameter: 'vmax',
      note: `Vmax ${fmt(value)} ${unit} scaled to ${fmt(absolute)} mg/h using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }

  if (CONCENTRATION_RATE_UNITS.has(unit)) {
    const slope = concentrationRate.toCanonical(value, unit as ConcentrationRateUnit);
    const absolute = slope * vd;
    derived.push({
      parameter: 'vmax',
      note: `Vmax = slope × Vd = ${fmt(slope)} mg/L/h × ${fmt(vd)} L = ${fmt(absolute)} mg/h (the source reports Vmax as the zero-order elimination slope ${fmt(value)} ${unit}, which is Vmax/Vd)`,
    });
    return absolute;
  }

  return massRate.toCanonical(value, unit as MassRateUnit);
}

/**
 * Resolve the {@link MichaelisMentenParams} the engine's `engine/modelsMM.ts`
 * needs for a `one_compartment_michaelis_menten` compound via `route` (handoff
 * §12; the nonlinear seam). Reads the `dispositionMM` block (Vd, Vmax, Km) — there
 * is no half-life to read, and no `ke`: for a saturable drug neither is a constant
 * of the molecule.
 *
 * **Oral requires an explicit `ka`; a reported Tmax cannot be inverted.** Every
 * linear resolver here estimates a missing `ka` from Tmax, because `Tmax =
 * ln(ka/ke)/(ka−ke)` is a closed-form relation between two constants. Under
 * saturation that relation does not exist: there is no `ke`, and Tmax is itself
 * DOSE-DEPENDENT (a bigger dose saturates elimination, so the peak arrives later),
 * which means a reported Tmax is not a property of the compound but of the
 * compound at one dose. Inverting it would silently fabricate that dose. So the
 * curator must supply a cited `ka` or the compound ships without an oral route.
 *
 * Throws if the compound is not Michaelis–Menten, is missing its `dispositionMM`
 * block (schema-guaranteed, but guarded so the engine never sees a partial set),
 * or if an oral curve is requested without `ka`.
 */
export function deriveParamsMM(
  compound: Compound,
  route: DataRoute,
  options: DeriveOptions = {},
): DerivedParamsMM {
  if (compound.model !== 'one_compartment_michaelis_menten') {
    throw new Error(
      `deriveParamsMM: "${compound.id}" uses model "${compound.model}", not one_compartment_michaelis_menten. Use deriveParams / deriveParams2c / deriveParams3c for the linear models.`,
    );
  }
  if (compound.linear) {
    throw new Error(
      `deriveParamsMM: "${compound.id}" is marked linear: true, which contradicts its Michaelis–Menten model — capacity-limited elimination is nonlinear by definition, and its doses do not superpose.`,
    );
  }
  const mm = compound.dispositionMM;
  if (!mm) {
    throw new Error(
      `deriveParamsMM: "${compound.id}" is Michaelis–Menten but has no dispositionMM block (Vd, Vmax, Km)`,
    );
  }

  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  const vd = resolveVolumeParam(mm.vd, 'Vd', 'vd', weightKg, derived);
  const vmax = resolveVmax(mm.vmax, vd, weightKg, derived);
  const km = concentrationConverter.toCanonical(mm.km.value, mm.km.unit as ConcentrationUnit);

  const params: MichaelisMentenParams = { vd, vmax, km };

  // ── Route availability ───────────────────────────────────────────────────
  const routeData = compound.routes[route];
  if (!routeData?.available) {
    warnings.push({
      parameter: 'route',
      message: `route "${route}" is not marked available for "${compound.id}"; this curve is inferred, not based on route-specific data`,
    });
  }

  // ── Absorption (first-order routes: oral and IM) ─────────────────────────
  if (engineRouteOf(route) === 'oral') {
    const oral = absorptionRouteOf(compound, route);

    if (oral?.F && oral.F.value !== null) {
      params.F = oral.F.unit === 'percent' ? oral.F.value / 100 : oral.F.value;
    } else {
      params.F = 1;
      warnings.push({
        parameter: 'F',
        message: `${bioavailabilityLabel(route)} not provided; assuming F = 1, which overestimates exposure for an incompletely absorbed drug`,
      });
      derived.push({ parameter: 'F', note: 'F assumed 1 (no value provided)' });
    }

    if (oral?.ka && oral.ka.value !== null) {
      params.ka = rateConstant.toCanonical(oral.ka.value, oral.ka.unit);
    } else {
      throw new Error(
        `deriveParamsMM: ${route} route for "${compound.id}" needs an explicit ka. A reported Tmax cannot be inverted for a saturable drug — there is no ke to invert against, and Tmax shifts with dose, so it is not a property of the compound alone.`,
      );
    }
  }

  return { params, derived, warnings };
}
