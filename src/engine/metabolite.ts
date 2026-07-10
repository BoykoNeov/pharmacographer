/**
 * Parent → metabolite kinetics (handoff §12 extension; metabolites spike, then
 * the multi-compartment generalisation).
 *
 * A fraction `fm` of what the parent eliminates forms the metabolite, which then
 * clears with its own one-compartment disposition (`Vd_m`, `k_m`). The parent's
 * central concentration is a sum of exponential MODES (`Σ coef_λ·e^(−λ·t)`) — one
 * mode for a one-compartment parent, two for a two-compartment IV-bolus parent
 * (α, β). The metabolite amount then solves, mode by mode, to a Bateman term:
 *
 *   dA_m/dt = fm·k10·A_central − k_m·A_m,   A_m(0) = 0
 *
 * where the formation flux `fm·k10·A_central = fm·CL·Σ coef_λ·e^(−λ·t)` (because
 * `k10·Vc = CL`). So each parent mode contributes
 *
 *   A_m,λ(t) = batemanMode(fm·CL·coef_λ, λ, k_m, t)
 *   C_m(t)   = (1/Vd_m)·Σ_λ A_m,λ(t)
 *
 * The KEY subtlety of the multi-compartment case: the input AMPLITUDE carries the
 * clearance `CL` (via `k10`), while the exponent and denominator carry the mode
 * rate `λ` (α or β). These coincide only in one compartment (where the parent
 * decays at the same rate `ke` it eliminates), which is why the one-compartment
 * function below is exactly the single-mode specialisation.
 *
 * `batemanMode` shares `models.ts`'s `FLIP_FLOP_REL_TOL` guard for its `λ ≈ k_m`
 * (formation ≈ elimination) 0/0 degeneracy. Because the whole parent+metabolite
 * system is linear, superposition over a dose schedule stays valid (same
 * mechanism as `dosing.ts`).
 *
 * Formation- vs elimination-rate-limited behaviour is NOT special-cased: the
 * terminal slope is `−min(slowest parent rate, k_m)`, which falls out of the
 * Bateman form.
 *
 * ORAL PARENT (the residue-form generalisation): an oral parent's central
 * concentration is not a plain sum of `coef·e^(−λt)` modes — it is a sum of Bateman
 * terms `Σ_λ B_λ·(e^(−ka·t) − e^(−λ·t))` (first-order absorption convolved with the
 * disposition). Collecting the exponentials rewrites it in RESIDUE form as a plain
 * mode sum over `{ka, λ…}`: one mode at rate `ka` with coefficient `Σ_λ B_λ`, and one
 * mode per disposition rate λ with coefficient `−B_λ`, where `B_λ = ka·F·D·g_λ/(λ−ka)`.
 * Those modes then feed the SAME {@link metaboliteConcentrationFromModes} core the IV
 * cases use, so one function serves a 1-, 2- or 3-compartment oral parent. Its total
 * exposure is `AUC_m = fm·F·D/(k_m·Vd_m)` (the CL and the `(λ−ka)` factors all cancel —
 * only the absorbed fraction F reaches the metabolite), the free regression anchor.
 * The `B_λ` denominator has a removable pole at `ka = λ`; the residue split cannot
 * represent that double pole (it would need a `t·e^(−λt)` limit term), so the builder
 * REFUSES a coincident absorption/disposition rate rather than emit a wrong curve —
 * the same refuse-don't-mislead posture as the linearity gate. This does not arise for
 * physically separated absorption and disposition rates.
 *
 * ORAL FIRST-PASS (pre-systemic formation): an oral parent additionally forms
 * metabolite BEFORE reaching systemic circulation, by gut-wall / hepatic first-pass
 * extraction. That fraction of the oral dose (`ffp = meta.firstPassFraction`) never
 * enters the systemic parent — the `F` scalar already excludes it — so it is NOT
 * captured by the systemic-formation term above. It appears instead as an oral-
 * absorption input directly into the metabolite compartment at the PARENT's
 * absorption rate `ka` (hepatic conversion fast relative to absorption — the standard
 * simplification), a single additive Bateman term `batemanMode(ka·ffp·D, ka, k_m,
 * t)/Vd_m`. This term rides ONLY the oral route (IV bypasses first-pass), is purely
 * additive to the systemic-formation term, and contributes `AUC = ffp·D/(k_m·Vd_m)`
 * (independent of `ka`), so the total oral metabolite exposure is `(fm·F + ffp)·D/
 * (k_m·Vd_m)`. With `ffp` absent/0 the term vanishes and the curve is byte-identical
 * to the systemic-formation-only case — the collapse anchor that protects every
 * shipped compound. See {@link presystemicMetaboliteConcentration}.
 *
 * IV-INFUSION PARENT (the zero-order-input generalisation): an infused parent's
 * central concentration is not a plain mode sum either — it is a rectangular window
 * of zero-order input convolved with the disposition. Since the whole parent →
 * metabolite chain is linear and time-invariant, the metabolite of an infusion is
 * the SAME convolution of that rectangular window with the metabolite's unit-bolus
 * impulse response `h(t) = (1/Vd_m)·Σ_λ batemanMode(fm·CL·g_λ, λ, k_m, t)`. So the
 * metabolite of a single infusion (rate `R0 = D/T` over `[0, T]`) is a difference of
 * running Bateman areas — one closed form covering during and after the infusion with
 * no seam bookkeeping:
 *
 *   C_m(t) = (R0/Vd_m)·Σ_λ [ batemanModeIntegral(fm·CL·g_λ, λ, k_m, t)
 *                           − batemanModeIntegral(fm·CL·g_λ, λ, k_m, max(0, t − T)) ]
 *
 * Its total exposure is `AUC_m = fm·D/(k_m·Vd_m)` — the SAME as the IV bolus (route-
 * and duration-independent; `Σ g_λ/λ = 1/CL` cancels the disposition), the free
 * regression anchor — and as `T → 0` it collapses to the IV-bolus metabolite. This
 * serves a 1-, 2- or 3-compartment infused parent off the same disposition modes.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { batemanMode, batemanModeIntegral } from './modes.ts';
import { FLIP_FLOP_REL_TOL } from './models.ts';
import { twoCompModes } from './models2c.ts';
import { threeCompModes } from './models3c.ts';
import type {
  DoseEvent,
  ExpMode,
  MetaboliteDisposition,
  MetaboliteParams,
  ThreeCompParams,
  TwoCompParams,
} from './types.ts';

// `batemanMode` — one first-order compartment driven by an exponentially-decaying
// input from a zero start — now lives in `modes.ts`, the shared mode-driver spine
// (it is also what the oral routes convolve to). Re-exported here because the
// metabolite tests and callers import it from this module by name.
export { batemanMode };

/**
 * Metabolite concentration (mg/L) from a set of parent central-concentration
 * modes (each `coef·e^(−rate·t)`, already scaled for the parent dose) and the
 * parent's clearance `parentCl` (L/h). Each mode drives a Bateman term with
 * amplitude `fm·CL·coef` and input rate `rate`; the terms sum and divide by the
 * metabolite Vd. Nothing has formed before the dose (`tau < 0` → 0) or at the
 * instant of the dose (`C_m(0) = 0`). This is the shared core the one- and
 * two-compartment entry points below both reduce to.
 */
export function metaboliteConcentrationFromModes(
  modes: ExpMode[],
  parentCl: number,
  meta: MetaboliteDisposition,
  tau: number,
): number {
  if (tau < 0) return 0;
  const { vdM, keM, fractionFormed } = meta;
  let amount = 0;
  for (const { coef, rate } of modes) {
    amount += batemanMode(fractionFormed * parentCl * coef, rate, keM, tau);
  }
  return amount / vdM;
}

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE one-compartment
 * IV-bolus parent dose of `dose` mg, `tau` hours after that dose. The
 * one-compartment (single-mode) specialisation of
 * {@link metaboliteConcentrationFromModes}: the parent is one mode
 * `coef = D/Vd_p`, `rate = keParent`, with `CL = keParent·Vd_p`, so the amplitude
 * `fm·CL·coef = fm·keParent·D` (the parent Vd cancels — the function needs no
 * parent volume). Retained as the original spike API and as a regression anchor
 * for the generalised core.
 */
export function singleDoseMetaboliteConcentration(
  params: MetaboliteParams,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  const { vdM, keM, keParent, fractionFormed } = params;
  return batemanMode(fractionFormed * keParent * dose, keParent, keM, tau) / vdM;
}

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE two-compartment
 * IV-bolus parent dose of `dose` mg, `tau` hours after that dose. Builds the
 * parent's α/β modes from {@link twoCompModes} and drives the metabolite with
 * them via {@link metaboliteConcentrationFromModes} (amplitude carries the
 * parent clearance `parent.cl`). The result is a 3-exponential curve (α, β, k_m);
 * its terminal slope is `−min(β, k_m)` and its total exposure is still
 * `fm·D/(k_m·Vd_m)`, independent of the parent's distribution.
 */
export function singleDose2cMetaboliteConcentration(
  parent: TwoCompParams,
  meta: MetaboliteDisposition,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  return metaboliteConcentrationFromModes(twoCompModes(parent, dose), parent.cl, meta, tau);
}

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE three-compartment
 * IV-bolus parent dose of `dose` mg, `tau` hours after that dose. Builds the
 * parent's α/β/γ modes from {@link threeCompModes} and drives the metabolite with
 * them via {@link metaboliteConcentrationFromModes} (amplitude carries the parent
 * clearance `parent.cl`). The result is a four-exponential curve (α, β, γ, k_m);
 * as with the two-compartment case its total exposure is still `fm·D/(k_m·Vd_m)`,
 * independent of the parent's distribution. Collapses exactly to
 * {@link singleDose2cMetaboliteConcentration} as the parent's Q3 → 0.
 */
export function singleDose3cMetaboliteConcentration(
  parent: ThreeCompParams,
  meta: MetaboliteDisposition,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  return metaboliteConcentrationFromModes(threeCompModes(parent, dose), parent.cl, meta, tau);
}

/**
 * Total metabolite concentration (mg/L) at each grid time, as the linear
 * superposition of the metabolite contribution of every scheduled parent dose
 * (one-compartment parent). Mirrors `dosing.ts`'s `concentrationCurve`: each
 * parent dose `d` contributes `singleDoseMetaboliteConcentration(params, d.amount,
 * t − d.time)`, 0 until the dose is given. An empty schedule yields all zeros.
 */
export function metaboliteConcentrationCurve(
  params: MetaboliteParams,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) =>
        total + singleDoseMetaboliteConcentration(params, dose.amount, t - dose.time),
      0,
    ),
  );
}

/**
 * Total metabolite concentration (mg/L) at each grid time for a two-compartment
 * IV-bolus parent — the {@link concentrationCurve2c} analogue for metabolites.
 * Superposes {@link singleDose2cMetaboliteConcentration} over the schedule.
 */
export function metabolite2cConcentrationCurve(
  parent: TwoCompParams,
  meta: MetaboliteDisposition,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) =>
        total + singleDose2cMetaboliteConcentration(parent, meta, dose.amount, t - dose.time),
      0,
    ),
  );
}

/**
 * Total metabolite concentration (mg/L) at each grid time for a three-compartment
 * IV-bolus parent — the {@link concentrationCurve3c} analogue for metabolites.
 * Superposes {@link singleDose3cMetaboliteConcentration} over the schedule.
 */
export function metabolite3cConcentrationCurve(
  parent: ThreeCompParams,
  meta: MetaboliteDisposition,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) =>
        total + singleDose3cMetaboliteConcentration(parent, meta, dose.amount, t - dose.time),
      0,
    ),
  );
}

/**
 * Residue-form exponential modes of an ORAL parent's central concentration for a
 * single dose `dose` mg — the mode set that {@link metaboliteConcentrationFromModes}
 * consumes. Given the disposition's per-unit-dose modes `dispositionUnitModes`
 * (`g_λ` at rate λ), the absorption constant `ka` and bioavailable fraction `F`, the
 * oral parent central concentration is `Σ_λ B_λ·(e^(−ka·t) − e^(−λ·t))` with
 * `B_λ = ka·F·D·g_λ/(λ−ka)`. Collecting exponentials gives one mode per disposition λ
 * (coefficient `−B_λ`, rate λ) plus a single absorption mode (coefficient `Σ_λ B_λ`,
 * rate `ka`). This reconstructs exactly the oral parent curve `oralConcentrationFromModes`
 * evaluates, but as plain `coef·e^(−rate·t)` modes so the metabolite core can drive it.
 *
 * REFUSAL at `ka ≈ λ`: `B_λ` has a removable pole there (the true term stays finite —
 * the bracket `e^(−ka·t) − e^(−λ·t) → 0` as `B_λ → ∞`), but the residue SPLIT into two
 * separate large canceling coefficients cannot represent that double pole without a
 * `t·e^(−λt)` limit term this model does not implement. Rather than emit a numerically
 * wrong curve we throw — matching the linearity gate's refuse-don't-mislead posture, and
 * `threeCompModes`'s stance that a genuine repeated root "does not arise for physical
 * parameters". Physically separated absorption and disposition rates never trip it.
 */
function oralParentResidueModes(
  dispositionUnitModes: ExpMode[],
  ka: number,
  F: number,
  dose: number,
): ExpMode[] {
  let absorptionCoef = 0;
  const modes: ExpMode[] = [];
  for (const { coef: g, rate: lambda } of dispositionUnitModes) {
    if (Math.abs(lambda - ka) <= FLIP_FLOP_REL_TOL * Math.max(lambda, ka)) {
      throw new Error(
        `oral-parent metabolite: absorption rate ka (${ka} 1/h) coincides with a disposition eigenvalue (${lambda} 1/h). The residue form has a removable double pole there that this model does not implement (it would need a t·e^(−λt) limit term); refusing rather than emit a wrong curve. This does not arise for physically separated absorption and disposition rates.`,
      );
    }
    const b = (ka * F * dose * g) / (lambda - ka);
    absorptionCoef += b;
    modes.push({ coef: -b, rate: lambda });
  }
  modes.push({ coef: absorptionCoef, rate: ka });
  return modes;
}

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE ORAL parent dose of `dose`
 * mg, `tau` hours after that dose, for a parent of ANY compartment count. Builds the
 * parent's {@link oralParentResidueModes} from the disposition's per-unit-dose modes
 * (`g_λ` — a single `1/Vd` mode for one compartment, α/β for two, α/β/γ for three) and
 * drives the metabolite with them through {@link metaboliteConcentrationFromModes}
 * (amplitude carries the parent clearance `parentCl`, as in the IV cases). The result
 * adds the absorption exponential to the parent's disposition exponentials plus the
 * metabolite's own `k_m`; `C_m(0) = 0` and `AUC_m = fm·F·D/(k_m·Vd_m)`.
 */
export function oralMetaboliteConcentrationFromModes(
  dispositionUnitModes: ExpMode[],
  parentCl: number,
  ka: number,
  F: number,
  meta: MetaboliteDisposition,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  return (
    metaboliteConcentrationFromModes(
      oralParentResidueModes(dispositionUnitModes, ka, F, dose),
      parentCl,
      meta,
      tau,
    ) + presystemicMetaboliteConcentration(meta, ka, dose, tau)
  );
}

/**
 * Pre-systemic (first-pass) metabolite concentration (mg/L) from a SINGLE oral
 * parent dose of `dose` mg, `tau` h after that dose. The fraction of the oral
 * dose extracted by gut-wall / hepatic metabolism before reaching systemic
 * circulation (`meta.firstPassFraction`, `ffp`) never enters the systemic parent
 * — instead it appears directly in the metabolite compartment as an oral-
 * absorption input at the PARENT's absorption rate `ka` (hepatic conversion is
 * fast relative to absorption; the standard simplification). So it is an oral
 * "dose" of the metabolite of `ffp·dose` mg absorbed at rate `ka` and eliminated
 * at `k_m`, a single Bateman term:
 *
 *   C_m,fp(tau) = batemanMode(ka·ffp·dose, ka, k_m, tau) / Vd_m
 *
 * Its exposure is `AUC = ffp·dose/(k_m·Vd_m)`, independent of `ka` — additive to
 * (and independent of) the systemic-formation term. `ffp` absent/0 ⇒ this term is
 * 0, reproducing the systemic-formation-only curve exactly (the collapse anchor).
 * IV routes bypass first-pass, so only the oral path calls this. The `ka ≈ k_m`
 * degeneracy is handled by `batemanMode`'s existing flip-flop limit, so — unlike
 * the residue split — this term never needs the `ka ≈ λ` refusal.
 */
function presystemicMetaboliteConcentration(
  meta: MetaboliteDisposition,
  ka: number,
  dose: number,
  tau: number,
): number {
  const ffp = meta.firstPassFraction ?? 0;
  if (tau < 0 || ffp === 0) return 0;
  return batemanMode(ka * ffp * dose, ka, meta.keM, tau) / meta.vdM;
}

/**
 * Total metabolite concentration (mg/L) at each grid time for an ORAL parent (any
 * compartment count) — the oral analogue of {@link metaboliteConcentrationCurve} /
 * {@link metabolite2cConcentrationCurve} / {@link metabolite3cConcentrationCurve}.
 * Superposes {@link oralMetaboliteConcentrationFromModes} over the schedule; the
 * per-unit-dose disposition modes (`g_λ`), parent clearance, `ka` and `F` are the same
 * for every dose, so the caller computes the disposition modes once and passes them in.
 */
export function oralMetaboliteConcentrationCurve(
  dispositionUnitModes: ExpMode[],
  parentCl: number,
  ka: number,
  F: number,
  meta: MetaboliteDisposition,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) =>
        total +
        oralMetaboliteConcentrationFromModes(
          dispositionUnitModes,
          parentCl,
          ka,
          F,
          meta,
          dose.amount,
          t - dose.time,
        ),
      0,
    ),
  );
}

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE IV-INFUSION parent dose of
 * `dose` mg delivered at constant rate over `duration` h, `tau` hours after the
 * infusion STARTED, for a parent of ANY compartment count. The zero-order-input
 * generalisation: an infusion is a rectangular window of boluses, so by linearity the
 * metabolite is the convolution of that window with the metabolite's unit-bolus Bateman
 * response — a difference of running Bateman areas ({@link batemanModeIntegral}), one
 * closed form spanning DURING (`tau ≤ duration`) and AFTER (`tau > duration`) with no
 * seam bookkeeping (the `max(0, tau − duration)` lower limit is `0` during the infusion):
 *
 *   C_m(tau) = (R0/Vd_m)·Σ_λ [ I_λ(tau) − I_λ(max(0, tau − duration)) ],   R0 = dose/duration
 *
 * where `I_λ(u) = batemanModeIntegral(fm·CL·g_λ, λ, k_m, u)`. `C_m(0) = 0`, the terminal
 * slope is `−min(slowest parent rate, k_m)` as in the bolus case, and its total exposure
 * is `AUC_m = fm·dose/(k_m·Vd_m)` — identical to the IV bolus (duration-independent). A
 * zero-rate collapse mode (`λ = 0`, `g = 0`) contributes nothing and is skipped so it
 * can't divide by 0, mirroring {@link infusionConcentrationFromModes}. As `duration → 0`
 * this collapses to {@link metaboliteConcentrationFromModes} (the IV-bolus metabolite).
 */
export function infusionMetaboliteConcentrationFromModes(
  dispositionUnitModes: ExpMode[],
  parentCl: number,
  meta: MetaboliteDisposition,
  dose: number,
  duration: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  const { vdM, keM, fractionFormed } = meta;
  const r0 = dose / duration;
  const tPost = Math.max(0, tau - duration);
  let amount = 0;
  for (const { coef: g, rate: lambda } of dispositionUnitModes) {
    if (lambda === 0 || g === 0) continue;
    const amplitude = fractionFormed * parentCl * g;
    amount +=
      batemanModeIntegral(amplitude, lambda, keM, tau) -
      batemanModeIntegral(amplitude, lambda, keM, tPost);
  }
  return (r0 * amount) / vdM;
}

/**
 * Total metabolite concentration (mg/L) at each grid time for an IV-INFUSION parent
 * (any compartment count) — the infusion analogue of {@link metaboliteConcentrationCurve}
 * / {@link oralMetaboliteConcentrationCurve}. Every scheduled dose is infused over the
 * same `duration` h (as the parent infusion curves apply one duration to all doses);
 * superposes {@link infusionMetaboliteConcentrationFromModes} over the schedule with the
 * per-unit-dose disposition modes (`g_λ`) and parent clearance computed once by the caller.
 */
export function infusionMetaboliteConcentrationCurve(
  dispositionUnitModes: ExpMode[],
  parentCl: number,
  meta: MetaboliteDisposition,
  schedule: DoseEvent[],
  duration: number,
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) =>
        total +
        infusionMetaboliteConcentrationFromModes(
          dispositionUnitModes,
          parentCl,
          meta,
          dose.amount,
          duration,
          t - dose.time,
        ),
      0,
    ),
  );
}
