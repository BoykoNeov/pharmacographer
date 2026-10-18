/**
 * The three-compartment resolver (handoff §12, Stage B): CL, Vc, Q2, Vp2, Q3 and
 * Vp3 from the `disposition3c` block, plus first-order absorption.
 */

import { threeCompRates } from '../../engine/models3c.ts';
import type { ThreeCompParams } from '../../engine/types.ts';
import { REFERENCE_WEIGHT_KG, rateConstant, time } from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { absorptionRouteOf, bioavailabilityLabel, engineRouteOf } from './routes.ts';
import { assertLinearModel, fmt, resolveClearanceParam, resolveVolumeParam } from './shared.ts';
import { kaFromTmax3c } from './tmax.ts';
import type { DeriveOptions, DeriveWarning, DerivedNote } from './types.ts';

/** Resolved three-compartment engine parameters plus the provenance of what was derived. */
export interface DerivedParams3c {
  /** Canonical-unit 3-comp parameters ready for `engine/models3c.ts`. */
  params: ThreeCompParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, per-kg scaling assumption, … */
  warnings: DeriveWarning[];
}

/**
 * Resolve the {@link ThreeCompParams} the engine's `engine/models3c.ts` needs for a
 * `three_compartment_first_order` compound via `route` (handoff §12, Stage B). Reads
 * the clinical `disposition3c` block (CL, Vc, Q2, Vp2, Q3, Vp3), scaling any per-kg
 * volumes/clearances against the reference subject exactly as {@link deriveParams2c}
 * does. Disposition is route-independent; the infusion DURATION is a dosing/UI input
 * injected later.
 *
 * Covers all three routes (IV bolus, IV infusion, oral). ORAL is a four-exponential
 * parent (α, β, γ plus the absorption mode ka); as with {@link deriveParams2c} a
 * reported Tmax is inverted through {@link kaFromTmax3c} (the four-exponential analogue
 * of the two-compartment peak solve). No shipped 3-comp compound currently declares an
 * oral Tmax, so this is engine capability rather than a user-facing route today.
 *
 * Throws if the compound is nonlinear, not three-compartment, missing its
 * `disposition3c` block (schema-guaranteed, but guarded so the engine never sees a
 * partial set), or an oral curve is requested with neither `ka` nor `tmax`.
 */
export function deriveParams3c(
  compound: Compound,
  route: DataRoute,
  options: DeriveOptions = {},
): DerivedParams3c {
  assertLinearModel(compound, 'three_compartment_first_order', 'deriveParams3c');
  const d3 = compound.disposition3c;
  if (!d3) {
    throw new Error(
      `deriveParams3c: "${compound.id}" is three-compartment but has no disposition3c block (CL, Vc, Q2, Vp2, Q3, Vp3).`,
    );
  }

  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  const vc = resolveVolumeParam(d3.centralVd, 'central Vd', 'vc', weightKg, derived);
  const vp2 = resolveVolumeParam(d3.peripheralVd2, 'rapid peripheral Vd', 'vp2', weightKg, derived);
  const vp3 = resolveVolumeParam(d3.peripheralVd3, 'slow peripheral Vd', 'vp3', weightKg, derived);
  const cl = resolveClearanceParam(d3.clearance, 'clearance', 'cl', weightKg, derived);
  const q2 = resolveClearanceParam(
    d3.interCompartmentalClearance2,
    'inter-compartmental clearance (Q2)',
    'q2',
    weightKg,
    derived,
  );
  const q3 = resolveClearanceParam(
    d3.interCompartmentalClearance3,
    'inter-compartmental clearance (Q3)',
    'q3',
    weightKg,
    derived,
  );

  const routeData = compound.routes[route];
  if (!routeData?.available) {
    warnings.push({
      parameter: 'route',
      message: `route "${route}" is not marked available for "${compound.id}"; this curve is inferred, not based on route-specific data`,
    });
  }

  const params: ThreeCompParams = { vc, cl, q2, vp2, q3, vp3 };

  // ── Absorption (oral or IM) — a four-exponential parent (α, β, γ, ka) ──────
  if (engineRouteOf(route) === 'oral') {
    const oral = absorptionRouteOf(compound, route);

    // Bioavailable fraction F.
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

    // Absorption rate constant ka — measured, or inverted from a reported Tmax
    // through the three-compartment peak solve (no closed form).
    if (oral?.ka && oral.ka.value !== null) {
      params.ka = rateConstant.toCanonical(oral.ka.value, oral.ka.unit);
    } else if (oral?.tmax && oral.tmax.value !== null) {
      const tmaxH = time.toCanonical(oral.tmax.value, oral.tmax.unit);
      const ka = kaFromTmax3c(tmaxH, params);
      params.ka = ka;
      derived.push({
        parameter: 'ka',
        note: `ka = ${fmt(ka)} 1/h estimated from Tmax ${fmt(oral.tmax.value)} ${oral.tmax.unit} and the α/β/γ disposition`,
      });
      // Flip-flop: absorption slower than the terminal disposition (ka < γ) — the
      // 3-comp analogue of the 2-comp ka < β check; γ is the smallest eigenvalue,
      // so the oral terminal slope is −min(ka, γ) and ka < γ is exactly when
      // absorption, not elimination, governs the terminal decline.
      const { gamma } = threeCompRates(params);
      if (ka < gamma) {
        warnings.push({
          parameter: 'ka',
          message: `estimated ka (${fmt(ka)}/h) is below the terminal rate γ (${fmt(gamma)}/h) — flip-flop kinetics where absorption, not elimination, is rate-limiting`,
        });
      }
    } else {
      throw new Error(
        `deriveParams3c: ${route} route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}
