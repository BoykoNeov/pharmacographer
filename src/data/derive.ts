/**
 * Derivation layer (handoff §8, docs/DATA_GUIDE.md, §13 Phase 3).
 *
 * Bridges DATA → ENGINE: a raw {@link Compound} reports whatever a source gave
 * (half-life, maybe clearance, Vd in L/kg, a Tmax instead of ka, F as a
 * percent…); the engine needs resolved {@link PkParams} in canonical units
 * (absolute L, 1/h, fraction). This module computes that subset and — crucially
 * — returns a LIST of what it had to derive plus any warnings, so the UI can be
 * honest about which numbers were measured and which were inferred.
 *
 * DATA layer: imports the engine (units, models, types) and the schema; the
 * engine never imports this.
 *
 * LINEARITY GATE (handoff §8, CLAUDE.md carry-forward): superposition — the one
 * mechanism the dosing engine uses — is valid only for linear PK. The engine is
 * deliberately pure and has no `linear` flag, so the gate must live here:
 * `deriveParams` refuses a `linear: false` (or non-one-compartment) compound
 * rather than silently feeding the engine parameters it will misuse.
 */

import { FLIP_FLOP_REL_TOL } from '../engine/models.ts';
import type { PkParams, Route } from '../engine/types.ts';
import {
  REFERENCE_WEIGHT_KG,
  absoluteVdFromPerKg,
  clearance as clearanceConverter,
  rateConstant,
  time,
} from '../engine/units.ts';
import type { Compound } from './schema.ts';

/**
 * Relative tolerance for the ke cross-check. When a compound supplies BOTH
 * clearance and half-life, `ke = CL/Vd` and `ke = ln2/t½` should agree; a gap
 * beyond this fraction is flagged (it usually means the two numbers came from
 * different studies/conditions, or a unit slip).
 */
export const KE_CROSSCHECK_REL_TOL = 0.15;

/** One thing the derivation computed rather than read from a source. */
export interface DerivedNote {
  /** Which resolved parameter this concerns: 'vd' | 'ke' | 'ka' | 'F'. */
  parameter: string;
  /** Human-readable description of what was derived and how. */
  note: string;
}

/** A caution the UI should surface alongside the curve. */
export interface DeriveWarning {
  parameter: string;
  message: string;
}

/** Resolved engine parameters plus the provenance of what was derived. */
export interface DerivedParams {
  /** Canonical-unit parameters ready for the engine model functions. */
  params: PkParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, assumed F, ke disagreement, flip-flop, … */
  warnings: DeriveWarning[];
}

/** Options controlling derivation. */
export interface DeriveOptions {
  /** Illustrative reference subject weight (kg) for scaling per-kg Vd / CL. */
  weightKg?: number;
}

/** Trim a computed number to a readable precision for notes/messages. */
function fmt(x: number): string {
  return Number(x.toPrecision(4)).toString();
}

/**
 * Invert the oral Tmax relationship `Tmax = ln(ka/ke) / (ka − ke)` for `ka`,
 * given `ke` and a measured `Tmax` (both in canonical units, h and 1/h).
 *
 * `Tmax(ka)` is strictly decreasing on (0, ∞): →∞ as ka→0, = 1/ke at ka = ke,
 * →0 as ka→∞, so the root is unique. We bracket on the correct side of ke and
 * bisect. `Tmax > 1/ke` forces `ka < ke` (flip-flop: absorption slower than
 * elimination) — physically unusual; the caller warns on it.
 */
export function kaFromTmax(tmax: number, ke: number): number {
  if (!(tmax > 0)) throw new Error('kaFromTmax: Tmax must be positive');
  if (!(ke > 0)) throw new Error('kaFromTmax: ke must be positive');

  const tmaxAt = (ka: number): number => {
    if (Math.abs(ka - ke) <= FLIP_FLOP_REL_TOL * Math.max(ka, ke)) return 1 / ke;
    return Math.log(ka / ke) / (ka - ke);
  };

  const peakAtKe = 1 / ke;
  if (Math.abs(tmax - peakAtKe) <= FLIP_FLOP_REL_TOL * peakAtKe) return ke;

  // Decreasing function: bracket [lo, hi] so tmaxAt(lo) > tmax > tmaxAt(hi).
  let lo: number;
  let hi: number;
  if (tmax < peakAtKe) {
    // Need ka > ke. lo = ke (Tmax = 1/ke > target); grow hi until Tmax < target.
    lo = ke;
    hi = ke * 2;
    while (tmaxAt(hi) > tmax) {
      hi *= 2;
      if (hi > 1e15) throw new Error('kaFromTmax: failed to bracket (ka too large)');
    }
  } else {
    // Need ka < ke. hi = ke (Tmax = 1/ke < target); shrink lo until Tmax > target.
    hi = ke;
    lo = ke / 2;
    while (tmaxAt(lo) < tmax) {
      lo /= 2;
      if (lo < 1e-15) throw new Error('kaFromTmax: failed to bracket (ka too small)');
    }
  }

  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const value = tmaxAt(mid);
    if (Math.abs(value - tmax) <= 1e-12 * tmax) return mid;
    // Decreasing: value too large ⇒ ka too small ⇒ raise the floor.
    if (value > tmax) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Resolve absolute Vd (L) from the disposition entry, noting any scaling. */
function resolveVd(
  compound: Compound,
  weightKg: number,
  derived: DerivedNote[],
): number {
  const vd = compound.disposition.vd;
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
  const hl = compound.disposition.halfLife;
  const halfLifeH = time.toCanonical(hl.value, hl.unit);
  const keFromHalfLife = Math.LN2 / halfLifeH;

  const cl = compound.disposition.clearance;
  if (cl && cl.value !== null) {
    // Convert clearance to absolute L/h (per-kg forms scale by the reference weight).
    const clAbs = cl.unit === 'L/h/kg' ? cl.value * weightKg : clearanceConverter.toCanonical(cl.value, cl.unit);
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
 * Throws if the compound is nonlinear or not one-compartment (the linearity
 * gate), or if an oral curve is requested with neither `ka` nor `tmax`.
 */
export function deriveParams(
  compound: Compound,
  route: Route,
  options: DeriveOptions = {},
): DerivedParams {
  // ── Linearity / model gate ───────────────────────────────────────────────
  if (!compound.linear) {
    throw new Error(
      `deriveParams: "${compound.id}" is nonlinear (linear: false). Superposition — the only mechanism the v1 engine has — is invalid for nonlinear PK; such compounds are excluded from v1 (handoff §8).`,
    );
  }
  if (compound.model !== 'one_compartment_first_order') {
    throw new Error(
      `deriveParams: "${compound.id}" uses model "${compound.model}", which the v1 engine cannot resolve (only one_compartment_first_order).`,
    );
  }

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

  // ── Absorption (oral only) ───────────────────────────────────────────────
  if (route === 'oral') {
    const oral = compound.routes.oral;

    // Bioavailable fraction F.
    if (oral?.F && oral.F.value !== null) {
      params.F = oral.F.unit === 'percent' ? oral.F.value / 100 : oral.F.value;
    } else {
      params.F = 1;
      warnings.push({
        parameter: 'F',
        message: 'oral bioavailability F not provided; assuming F = 1, which overestimates exposure for an incompletely absorbed drug',
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
        `deriveParams: oral route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}
