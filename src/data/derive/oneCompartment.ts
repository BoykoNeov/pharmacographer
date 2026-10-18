/**
 * The one-compartment resolver (the v1 model): Vd and ke from the `disposition`
 * block, plus first-order absorption.
 */

import type { PkParams } from '../../engine/types.ts';
import {
  REFERENCE_WEIGHT_KG,
  absoluteVdFromPerKg,
  clearance as clearanceConverter,
  rateConstant,
  time,
} from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { absorptionRouteOf, bioavailabilityLabel, engineRouteOf } from './routes.ts';
import { assertLinearModel, fmt, requireDisposition } from './shared.ts';
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

/** Resolve absolute Vd (L) from the disposition entry, noting any scaling. */
function resolveVd(compound: Compound, weightKg: number, derived: DerivedNote[]): number {
  const vd = requireDisposition(compound).vd;
  if (vd.unit === 'L/kg') {
    const absolute = absoluteVdFromPerKg(vd.value, weightKg);
    derived.push({
      parameter: 'vd',
      note: `Vd ${fmt(vd.value)} L/kg scaled to ${fmt(absolute)} L using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }
  return vd.value; // already absolute litres
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

  const vd = resolveVd(compound, weightKg, derived);
  const ke = resolveKe(compound, vd, weightKg, derived, warnings);

  const params: PkParams = { vd, ke };

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

    // Absorption rate constant ka — measured, or inverted from a reported Tmax.
    if (oral?.ka && oral.ka.value !== null) {
      params.ka = rateConstant.toCanonical(oral.ka.value, oral.ka.unit);
    } else if (oral?.tmax && oral.tmax.value !== null) {
      const tmaxH = time.toCanonical(oral.tmax.value, oral.tmax.unit);
      const ka = kaFromTmax(tmaxH, ke);
      params.ka = ka;
      derived.push({
        parameter: 'ka',
        note: `ka = ${fmt(ka)} 1/h estimated from Tmax ${fmt(oral.tmax.value)} ${oral.tmax.unit} and ke`,
      });
      if (tmaxH > 1 / ke) {
        warnings.push({
          parameter: 'ka',
          message: `Tmax (${fmt(tmaxH)} h) exceeds 1/ke (${fmt(1 / ke)} h), implying ka < ke — flip-flop kinetics where absorption is slower than elimination`,
        });
      }
    } else {
      throw new Error(
        `deriveParams: ${route} route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}
