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
import { batemanModeDerivative } from '../engine/modes.ts';
import { twoCompModes, twoCompRates } from '../engine/models2c.ts';
import { threeCompModes, threeCompRates } from '../engine/models3c.ts';
import type {
  MetaboliteDisposition,
  MetaboliteParams,
  PkParams,
  Route,
  ThreeCompParams,
  TwoCompParams,
} from '../engine/types.ts';
import type { MichaelisMentenParams } from '../engine/modelsMM.ts';
import {
  REFERENCE_WEIGHT_KG,
  absoluteVdFromPerKg,
  clearance as clearanceConverter,
  concentration as concentrationConverter,
  concentrationRate,
  massRate,
  rateConstant,
  time,
  type ClearanceUnit,
  type ConcentrationRateUnit,
  type ConcentrationUnit,
  type MassRateUnit,
} from '../engine/units.ts';
import { NONLINEAR_MODELS, type Compound, type Metabolite } from './schema.ts';

/**
 * Relative tolerance for the ke cross-check. When a compound supplies BOTH
 * clearance and half-life, `ke = CL/Vd` and `ke = ln2/t½` should agree; a gap
 * beyond this fraction is flagged (it usually means the two numbers came from
 * different studies/conditions, or a unit slip).
 */
export const KE_CROSSCHECK_REL_TOL = 0.15;

/**
 * Plausibility ceiling for a metabolite's mass-basis formation (or first-pass)
 * fraction. The engine's `fractionFormed`/`firstPassFraction` scale parent MASS
 * cleared (dA_m/dt = fm·CL·C_p, no molar-mass term), and by this data set's
 * convention they are MW-adjusted from the molar fraction — so for a metabolite
 * HEAVIER than the parent they legitimately exceed 1: conjugation conserves
 * MOLES, not mass, and a glucuronide (MW ~2.2× the parent) formed from most of a
 * dose gives a mass-fm up to ~2.2 (e.g. acetaminophen glucuronide 119%). The
 * ceiling therefore reflects the largest realistic single-step parent→metabolite
 * mass gain, NOT 1; a value above it is a units/typo error, not chemistry.
 */
export const MAX_PLAUSIBLE_MASS_FRACTION = 3;

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

/** Resolved metabolite engine parameters plus the provenance of what was derived. */
export interface DerivedMetaboliteParams {
  /** Canonical-unit metabolite parameters ready for `engine/metabolite.ts`. */
  params: MetaboliteParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: Vd scaling assumption, implausible formation fraction, … */
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

/**
 * Invert the oral Tmax relationship for the TWO-COMPARTMENT model — find the
 * absorption constant `ka` whose tri-exponential oral curve peaks at `tmax`
 * (canonical h), given the disposition `params` (CL/Vc/Q/Vp fix α, β and the
 * per-unit-dose modes `g_λ`, all independent of `ka`).
 *
 * There is no closed form (unlike the one-compartment `kaFromTmax`), but the peak
 * condition `C′(tmax; ka) = 0` is a SINGLE equation in `ka` — no nested inner
 * peak-search. `C′(tmax; ka)` is the sum over the disposition modes of
 * {@link batemanModeDerivative} (with amplitude `ka·g_λ`; the `F·D` scale drops
 * out of the root) and is strictly decreasing in `ka`: a larger `ka` peaks earlier,
 * so at the fixed instant `tmax` the curve is already past its peak (slope < 0),
 * while a smaller `ka` peaks later (slope > 0 at `tmax`). We bracket that sign
 * change and bisect. This is the exact inverse of `models2c.ts`'s
 * {@link oralPeakTime2c}, so a `ka` recovered here round-trips back to `tmax`.
 */
export function kaFromTmax2c(tmax: number, params: TwoCompParams): number {
  if (!(tmax > 0)) throw new Error('kaFromTmax2c: Tmax must be positive');
  const unitModes = twoCompModes(params, 1); // g_λ — independent of ka
  // Slope of the oral curve at `tmax` for a candidate `ka` (up to the positive
  // F·D scale, which cannot move the root); monotone decreasing in `ka`.
  const slopeAtTmax = (ka: number): number =>
    unitModes.reduce((s, { coef: g, rate }) => s + batemanModeDerivative(ka * g, ka, rate, tmax), 0);

  // Bracket [lo, hi] so slopeAtTmax(lo) > 0 (ka too small) and slopeAtTmax(hi) < 0
  // (ka too large). Expand outward from a unit seed until both signs hold.
  let lo = 1;
  while (slopeAtTmax(lo) <= 0) {
    lo /= 2;
    if (lo < 1e-12) throw new Error('kaFromTmax2c: failed to bracket (ka too small)');
  }
  let hi = lo;
  while (slopeAtTmax(hi) >= 0) {
    hi *= 2;
    if (hi > 1e12) throw new Error('kaFromTmax2c: failed to bracket (ka too large)');
  }

  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    // Decreasing: slope still positive ⇒ ka too small ⇒ raise the floor.
    if (slopeAtTmax(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * hi) break;
  }
  return 0.5 * (lo + hi);
}

/**
 * Invert the oral Tmax relationship for the THREE-COMPARTMENT model — find the
 * absorption constant `ka` whose four-exponential oral curve peaks at `tmax`
 * (canonical h), given the disposition `params` (CL/Vc/Q2/Vp2/Q3/Vp3 fix α, β, γ
 * and the per-unit-dose modes `g_λ`, all independent of `ka`). The three-compartment
 * analogue of {@link kaFromTmax2c} — structurally identical, only the mode set grows
 * from two to three: the peak condition `C′(tmax; ka) = 0` is a SINGLE equation in
 * `ka`, `C′(tmax; ka)` is the sum over the disposition modes of
 * {@link batemanModeDerivative} (amplitude `ka·g_λ`; the `F·D` scale drops out), and
 * it is strictly decreasing in `ka` (a larger `ka` peaks earlier, so at the fixed
 * instant `tmax` the slope is already negative). We bracket that sign change and
 * bisect. This is the exact inverse of `models3c.ts`'s {@link oralPeakTime3c}, so a
 * `ka` recovered here round-trips back to `tmax`.
 */
export function kaFromTmax3c(tmax: number, params: ThreeCompParams): number {
  if (!(tmax > 0)) throw new Error('kaFromTmax3c: Tmax must be positive');
  const unitModes = threeCompModes(params, 1); // g_λ — independent of ka
  // Slope of the oral curve at `tmax` for a candidate `ka` (up to the positive
  // F·D scale, which cannot move the root); monotone decreasing in `ka`.
  const slopeAtTmax = (ka: number): number =>
    unitModes.reduce((s, { coef: g, rate }) => s + batemanModeDerivative(ka * g, ka, rate, tmax), 0);

  // Bracket [lo, hi] so slopeAtTmax(lo) > 0 (ka too small) and slopeAtTmax(hi) < 0
  // (ka too large). Expand outward from a unit seed until both signs hold.
  let lo = 1;
  while (slopeAtTmax(lo) <= 0) {
    lo /= 2;
    if (lo < 1e-12) throw new Error('kaFromTmax3c: failed to bracket (ka too small)');
  }
  let hi = lo;
  while (slopeAtTmax(hi) >= 0) {
    hi *= 2;
    if (hi > 1e12) throw new Error('kaFromTmax3c: failed to bracket (ka too large)');
  }

  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    // Decreasing: slope still positive ⇒ ka too small ⇒ raise the floor.
    if (slopeAtTmax(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * hi) break;
  }
  return 0.5 * (lo + hi);
}

/**
 * The compound's linear `disposition` block, or a thrown error.
 *
 * `disposition` is schema-optional ONLY because a Michaelis–Menten compound has
 * no half-life to state and carries `dispositionMM` instead; every linear model
 * requires it, and the schema enforces that. So a linear resolver arriving here
 * without one means the object skipped validation — a programming error worth a
 * clear message rather than a `TypeError` deep in a converter.
 */
function requireDisposition(compound: Compound): NonNullable<Compound['disposition']> {
  const disposition = compound.disposition;
  if (!disposition) {
    throw new Error(
      `"${compound.id}" (model "${compound.model}") has no disposition block; only a Michaelis–Menten compound may omit one, and it is resolved by deriveParamsMM`,
    );
  }
  return disposition;
}

/**
 * Guard the model↔linearity contract at the derivation boundary, for a resolver
 * that can only handle LINEAR kinetics.
 *
 * The reject is on the MODEL, not on `linear`: `linear: false` no longer means
 * "excluded" (Michaelis–Menten compounds are nonlinear and ship — see
 * {@link NONLINEAR_MODELS}), it means "superposition is invalid", which is
 * decided by the model. So the model check comes first and names the resolver
 * that CAN handle the compound; the `linear` check that follows catches only the
 * contradictory case — a linear model whose file claims superposition is invalid
 * — which the schema also rejects, but which a hand-built object could reach.
 */
function assertLinearModel(compound: Compound, expected: Compound['model'], resolver: string): void {
  if (compound.model !== expected) {
    const handler = NONLINEAR_MODELS.has(compound.model)
      ? 'deriveParamsMM'
      : 'deriveParams / deriveParams2c / deriveParams3c';
    throw new Error(
      `${resolver}: "${compound.id}" uses model "${compound.model}"; this resolver handles only ${expected}. Use ${handler} (handoff §12).`,
    );
  }
  if (!compound.linear) {
    throw new Error(
      `${resolver}: "${compound.id}" is marked linear: false, which contradicts its model "${expected}" — linear kinetics are a property of that model. Superposition is the only mechanism the linear engine has, so a genuinely nonlinear compound must declare a nonlinear model and be resolved by deriveParamsMM (handoff §8, §12).`,
    );
  }
}

/** Resolve absolute Vd (L) from the disposition entry, noting any scaling. */
function resolveVd(
  compound: Compound,
  weightKg: number,
  derived: DerivedNote[],
): number {
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
 * Throws if the compound's model is not one-compartment first-order (the model
 * gate — see {@link assertLinearModel}), or if an oral curve is requested with
 * neither `ka` nor `tmax`.
 */
export function deriveParams(
  compound: Compound,
  route: Route,
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

/** Resolved two-compartment engine parameters plus the provenance of what was derived. */
export interface DerivedParams2c {
  /** Canonical-unit 2-comp parameters ready for `engine/models2c.ts`. */
  params: TwoCompParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: inferred route, per-kg scaling assumption, … */
  warnings: DeriveWarning[];
}

/** Resolve a volume parameter to absolute litres, noting any per-kg scaling. */
function resolveVolumeParam(
  param: { value: number; unit: string },
  label: string,
  key: string,
  weightKg: number,
  derived: DerivedNote[],
): number {
  if (param.unit === 'L/kg') {
    const absolute = absoluteVdFromPerKg(param.value, weightKg);
    derived.push({
      parameter: key,
      note: `${label} ${fmt(param.value)} L/kg scaled to ${fmt(absolute)} L using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }
  return param.value; // already absolute litres
}

/** Resolve a clearance parameter to absolute L/h, noting any per-kg scaling. */
function resolveClearanceParam(
  param: { value: number; unit: string },
  label: string,
  key: string,
  weightKg: number,
  derived: DerivedNote[],
): number {
  if (param.unit === 'L/h/kg') {
    const absolute = param.value * weightKg;
    derived.push({
      parameter: key,
      note: `${label} ${fmt(param.value)} L/h/kg scaled to ${fmt(absolute)} L/h using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }
  // Every non-per-kg schema clearance unit is an engine ClearanceUnit.
  return clearanceConverter.toCanonical(param.value, param.unit as ClearanceUnit);
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
  route: Route,
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

  // ── Absorption (oral only) — a tri-exponential parent (α, β, ka) ───────────
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
        `deriveParams2c: oral route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}

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
  route: Route,
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

  // ── Absorption (oral only) — a four-exponential parent (α, β, γ, ka) ────────
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
        `deriveParams3c: oral route for "${compound.id}" needs either ka or tmax to determine absorption`,
      );
    }
  }

  return { params, derived, warnings };
}

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
  route: Route,
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

  // ── Absorption (oral only) ───────────────────────────────────────────────
  if (route === 'oral') {
    const oral = compound.routes.oral;

    if (oral?.F && oral.F.value !== null) {
      params.F = oral.F.unit === 'percent' ? oral.F.value / 100 : oral.F.value;
    } else {
      params.F = 1;
      warnings.push({
        parameter: 'F',
        message:
          'oral bioavailability F not provided; assuming F = 1, which overestimates exposure for an incompletely absorbed drug',
      });
      derived.push({ parameter: 'F', note: 'F assumed 1 (no value provided)' });
    }

    if (oral?.ka && oral.ka.value !== null) {
      params.ka = rateConstant.toCanonical(oral.ka.value, oral.ka.unit);
    } else {
      throw new Error(
        `deriveParamsMM: oral route for "${compound.id}" needs an explicit ka. A reported Tmax cannot be inverted for a saturable drug — there is no ke to invert against, and Tmax shifts with dose, so it is not a property of the compound alone.`,
      );
    }
  }

  return { params, derived, warnings };
}

/** Resolved metabolite disposition (model-agnostic) plus the provenance of what was derived. */
export interface DerivedMetaboliteDisposition {
  params: MetaboliteDisposition;
  derived: DerivedNote[];
  warnings: DeriveWarning[];
}

/**
 * Resolve the metabolite's OWN disposition — `vdM` (scaled from L/kg against the
 * reference subject, like the parent's), `keM = ln2 / t½_m` (metabolites report
 * no clearance, so `ke` always comes from the half-life), and `fractionFormed`
 * (normalised from percent when needed). This is independent of how the parent
 * delivers the metabolite, so it is shared by both the one- and two-compartment
 * parent paths (the one-compartment {@link deriveMetaboliteParams} adds the
 * single `keParent` input rate; the two-compartment path pairs it with the
 * parent's modes at plot time).
 */
export function deriveMetaboliteDisposition(
  metabolite: Metabolite,
  options: DeriveOptions = {},
): DerivedMetaboliteDisposition {
  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  // Metabolite Vd — absolute litres (scale per-kg against the reference subject).
  let vdM = metabolite.vd.value;
  if (metabolite.vd.unit === 'L/kg') {
    vdM = absoluteVdFromPerKg(metabolite.vd.value, weightKg);
    derived.push({
      parameter: 'vdM',
      note: `metabolite Vd ${fmt(metabolite.vd.value)} L/kg scaled to ${fmt(vdM)} L using the ${weightKg} kg illustrative reference subject`,
    });
  }

  // Metabolite ke — always from its half-life (no clearance is stored for metabolites).
  const halfLifeMH = time.toCanonical(metabolite.halfLife.value, metabolite.halfLife.unit);
  const keM = Math.LN2 / halfLifeMH;
  derived.push({
    parameter: 'keM',
    note: `metabolite ke = ln2 / t½ = ${fmt(keM)} 1/h (half-life ${fmt(metabolite.halfLife.value)} ${metabolite.halfLife.unit})`,
  });

  // Formation fraction — normalise percent to a [0, 1] fraction; flag implausible values.
  const fractionFormed =
    metabolite.fractionFormed.unit === 'percent'
      ? metabolite.fractionFormed.value / 100
      : metabolite.fractionFormed.value;
  if (metabolite.fractionFormed.unit === 'percent') {
    derived.push({
      parameter: 'fractionFormed',
      note: `formation fraction ${fmt(metabolite.fractionFormed.value)}% expressed as ${fmt(fractionFormed)}`,
    });
  }

  // Pre-systemic (first-pass) fraction — optional; the oral-only additive term. Normalise
  // percent to a fraction like fractionFormed; absent ⇒ undefined (no first-pass term).
  let firstPassFraction: number | undefined;
  if (metabolite.firstPassFraction) {
    firstPassFraction =
      metabolite.firstPassFraction.unit === 'percent'
        ? metabolite.firstPassFraction.value / 100
        : metabolite.firstPassFraction.value;
    if (metabolite.firstPassFraction.unit === 'percent') {
      derived.push({
        parameter: 'firstPassFraction',
        note: `first-pass fraction ${fmt(metabolite.firstPassFraction.value)}% expressed as ${fmt(firstPassFraction)}`,
      });
    }
    if (firstPassFraction < 0 || firstPassFraction > MAX_PLAUSIBLE_MASS_FRACTION) {
      warnings.push({
        parameter: 'firstPassFraction',
        message: `metabolite first-pass fraction ${fmt(firstPassFraction)} is implausible (mass-fm may exceed 1 for a heavier-than-parent metabolite, but not by this much) — check the source and units`,
      });
    }
  }

  // Formation must have at least one active pathway. `fractionFormed` may now be 0 —
  // a purely pre-systemic metabolite (all first-pass) is legitimate — but only when a
  // first-pass fraction carries it; the total (fm + ffp) must be positive.
  if (fractionFormed < 0 || fractionFormed > MAX_PLAUSIBLE_MASS_FRACTION) {
    warnings.push({
      parameter: 'fractionFormed',
      message: `metabolite formation fraction ${fmt(fractionFormed)} is implausible (mass-fm may exceed 1 for a heavier-than-parent metabolite, but not by this much) — check the source and units`,
    });
  } else if (fractionFormed + (firstPassFraction ?? 0) <= 0) {
    warnings.push({
      parameter: 'fractionFormed',
      message: `metabolite has no formation pathway (fractionFormed and firstPassFraction both 0) — check the source and units`,
    });
  }

  return { params: { vdM, keM, fractionFormed, firstPassFraction }, derived, warnings };
}

/**
 * Resolve the {@link MetaboliteParams} the engine's `engine/metabolite.ts` needs
 * for one metabolite formed from a ONE-COMPARTMENT parent, given the parent's
 * already-derived elimination rate (`parentKe`, 1/h — the metabolite's
 * formation/input rate). Thin wrapper over {@link deriveMetaboliteDisposition}
 * that attaches `keParent`. Does NOT re-check linearity — the caller only reaches
 * this after {@link deriveParams} has passed the linearity gate for the parent.
 */
export function deriveMetaboliteParams(
  metabolite: Metabolite,
  parentKe: number,
  options: DeriveOptions = {},
): DerivedMetaboliteParams {
  if (!(parentKe > 0)) {
    throw new Error('deriveMetaboliteParams: parentKe must be a positive rate constant');
  }
  const { params, derived, warnings } = deriveMetaboliteDisposition(metabolite, options);
  return { params: { ...params, keParent: parentKe }, derived, warnings };
}
