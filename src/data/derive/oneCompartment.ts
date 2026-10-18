/**
 * The one-compartment resolver (the v1 model): Vd and ke from the `disposition`
 * block, plus first-order absorption.
 */

import type { PkParams } from '../../engine/types.ts';
import { REFERENCE_WEIGHT_KG, clearance as clearanceConverter, time } from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { resolveF, resolveKaLinear } from './absorption.ts';
import { absorptionRouteOf, engineRouteOf } from './routes.ts';
import {
  assertLinearModel,
  fmt,
  requireDisposition,
  resolveVolumeParam,
  warnIfInferredRoute,
} from './shared.ts';
import { kaFromTmax } from './tmax.ts';
import type { DeriveOptions, DeriveWarning, DerivedNote } from './types.ts';

/**
 * Relative tolerance for the ke cross-check. When a compound supplies BOTH
 * clearance and half-life, `ke = CL/Vd` and `ke = ln2/t½` should agree; a gap
 * beyond this fraction is flagged (it usually means the two numbers came from
 * different studies/conditions, or a unit slip).
 */
export const KE_CROSSCHECK_REL_TOL = 0.15;

/** Resolved engine parameters plus the provenance of what was derived. */
export interface DerivedParams {
  /** Canonical-unit parameters ready for the engine model functions. */
  params: PkParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, assumed F, ke disagreement, flip-flop, … */
  warnings: DeriveWarning[];
}

/** Resolve ke (1/h): CL/Vd when clearance is present (cross-checked), else ln2/t½. */
function resolveKe(
  compound: Compound,
  vd: number,
  weightKg: number,
  derived: DerivedNote[],
  warnings: DeriveWarning[],
): number {
  const disposition = requireDisposition(compound);
  const hl = disposition.halfLife;
  const halfLifeH = time.toCanonical(hl.value, hl.unit);
  const keFromHalfLife = Math.LN2 / halfLifeH;

  const cl = disposition.clearance;
  if (cl && cl.value !== null) {
    // Convert clearance to absolute L/h (per-kg forms scale by the reference weight).
    const clAbs =
      cl.unit === 'L/h/kg'
        ? cl.value * weightKg
        : clearanceConverter.toCanonical(cl.value, cl.unit);
    const keFromCl = clAbs / vd;
    derived.push({
      parameter: 'ke',
      note: `ke = CL/Vd = ${fmt(keFromCl)} 1/h (clearance ${fmt(cl.value)} ${cl.unit})`,
    });
    const relDiff = Math.abs(keFromCl - keFromHalfLife) / keFromHalfLife;
    if (relDiff > KE_CROSSCHECK_REL_TOL) {
      warnings.push({
        parameter: 'ke',
        message: `ke from clearance (${fmt(keFromCl)}/h) and from half-life (${fmt(keFromHalfLife)}/h) disagree by ${(relDiff * 100).toFixed(0)}% — likely different studies/conditions`,
      });
    }
    return keFromCl;
  }

  derived.push({
    parameter: 'ke',
    note: `ke = ln2 / t½ = ${fmt(keFromHalfLife)} 1/h (half-life ${fmt(hl.value)} ${hl.unit})`,
  });
  return keFromHalfLife;
}

/**
 * Resolve the {@link PkParams} the engine needs for `compound` via `route`,
 * together with the list of derived values and any warnings (handoff §8).
 *
 * Disposition (Vd, ke) is route-independent; absorption (ka, F) is filled only
 * for `oral`. For `iv_infusion` the infusion DURATION is a dosing/UI input, not
 * a compound property, so it is intentionally left unset here. A route the
 * compound does not mark `available` still yields a curve but adds an "inferred,
 * not based on route-specific data" warning (handoff §1, §10).
 *
 * Throws if the compound's model is not one-compartment first-order (the model
 * gate — see {@link assertLinearModel}), or if an oral curve is requested with
 * neither `ka` nor `tmax`.
 */
export function deriveParams(
  compound: Compound,
  route: DataRoute,
  options: DeriveOptions = {},
): DerivedParams {
  assertLinearModel(compound, 'one_compartment_first_order', 'deriveParams');

  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  const vd = resolveVolumeParam(requireDisposition(compound).vd, 'Vd', 'vd', weightKg, derived);
  const ke = resolveKe(compound, vd, weightKg, derived, warnings);

  const params: PkParams = { vd, ke };

  warnIfInferredRoute(compound, route, warnings);

  // ── Absorption (first-order routes: oral, IM, SC, rectal) ────────────────
  if (engineRouteOf(route) === 'oral') {
    const absorption = absorptionRouteOf(compound, route);
    params.F = resolveF(absorption, route, derived, warnings);
    params.ka = resolveKaLinear(
      absorption,
      compound,
      route,
      'deriveParams',
      {
        invert: (tmaxH) => kaFromTmax(tmaxH, ke),
        against: 'ke',
        flipFlop: (_ka, tmaxH) =>
          tmaxH > 1 / ke
            ? `Tmax (${fmt(tmaxH)} h) exceeds 1/ke (${fmt(1 / ke)} h), implying ka < ke — flip-flop kinetics where absorption is slower than elimination`
            : undefined,
      },
      derived,
      warnings,
    );
  }

  return { params, derived, warnings };
}
