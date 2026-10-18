/**
 * The two-compartment resolver (handoff §12): CL, Vc, Q and Vp from the
 * `disposition2c` block, plus first-order absorption.
 */

import { twoCompRates } from '../../engine/models2c.ts';
import type { TwoCompParams } from '../../engine/types.ts';
import { REFERENCE_WEIGHT_KG, rateConstant, time } from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { absorptionRouteOf, bioavailabilityLabel, engineRouteOf } from './routes.ts';
import { assertLinearModel, fmt, resolveClearanceParam, resolveVolumeParam } from './shared.ts';
import { kaFromTmax2c } from './tmax.ts';
import type { DeriveOptions, DeriveWarning, DerivedNote } from './types.ts';

/** Resolved two-compartment engine parameters plus the provenance of what was derived. */
export interface DerivedParams2c {
  /** Canonical-unit 2-comp parameters ready for `engine/models2c.ts`. */
  params: TwoCompParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, per-kg scaling assumption, … */
  warnings: DeriveWarning[];
}

/**
 * Resolve the {@link TwoCompParams} the engine's `engine/models2c.ts` needs for a
 * `two_compartment_first_order` compound via `route` (handoff §12). Reads the
 * clinical `disposition2c` block (CL, Vc, Q, Vp), scaling per-kg volumes and
 * clearances against the reference subject. Disposition is route-independent; as
 * with {@link deriveParams} the infusion DURATION is a dosing/UI input, injected
 * later, and absorption (ka, F) is filled only for `oral` — where a reported Tmax
 * is inverted through {@link kaFromTmax2c} (the tri-exponential analogue of the
 * one-compartment `kaFromTmax`).
 *
 * Throws if the compound is nonlinear, not two-compartment, missing its
 * `disposition2c` block (the last is schema-guaranteed, but guarded here so the
 * engine never sees a partial parameter set), or an oral curve is requested with
 * neither `ka` nor `tmax`.
 */
export function deriveParams2c(
  compound: Compound,
  route: DataRoute,
  options: DeriveOptions = {},
): DerivedParams2c {
  assertLinearModel(compound, 'two_compartment_first_order', 'deriveParams2c');
  const d2 = compound.disposition2c;
  if (!d2) {
    throw new Error(
      `deriveParams2c: "${compound.id}" is two-compartment but has no disposition2c block (CL, Vc, Q, Vp).`,
    );
  }

  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  const vc = resolveVolumeParam(d2.centralVd, 'central Vd', 'vc', weightKg, derived);
  const vp = resolveVolumeParam(d2.peripheralVd, 'peripheral Vd', 'vp', weightKg, derived);
  const cl = resolveClearanceParam(d2.clearance, 'clearance', 'cl', weightKg, derived);
  const q = resolveClearanceParam(
    d2.interCompartmentalClearance,
    'inter-compartmental clearance',
    'q',
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

  const params: TwoCompParams = { vc, cl, q, vp };

  // ── Absorption (oral or IM) — a tri-exponential parent (α, β, ka) ─────────
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
    // through the two-compartment peak solve (no closed form).
    if (oral?.ka && oral.ka.value !== null) {
      params.ka = rateConstant.toCanonical(oral.ka.value, oral.ka.unit);
    } else if (oral?.tmax && oral.tmax.value !== null) {
      const tmaxH = time.toCanonical(oral.tmax.value, oral.tmax.unit);
      const ka = kaFromTmax2c(tmaxH, params);
      params.ka = ka;
      derived.push({
        parameter: 'ka',
        note: `ka = ${fmt(ka)} 1/h estimated from Tmax ${fmt(oral.tmax.value)} ${oral.tmax.unit} and the α/β disposition`,
      });
      // Flip-flop: absorption slower than the terminal disposition (ka < β).
      const { beta } = twoCompRates(params);
      if (ka < beta) {
        warnings.push({
          parameter: 'ka',
          message: `estimated ka (${fmt(ka)}/h) is below the terminal rate β (${fmt(beta)}/h) — flip-flop kinetics where absorption, not elimination, is rate-limiting`,
        });
      }
    } else {
      throw new Error(
        `deriveParams2c: ${route} route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}
