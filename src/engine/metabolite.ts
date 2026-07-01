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
 * Bateman form. SPIKE/EXTENSION SCOPE: IV-bolus (bi-exponential) parent. An oral
 * parent (an extra absorption mode) and pre-systemic/first-pass formation are
 * deferred.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import { twoCompModes } from './models2c.ts';
import type {
  DoseEvent,
  ExpMode,
  MetaboliteDisposition,
  MetaboliteParams,
  TwoCompParams,
} from './types.ts';

/**
 * One parent mode's contribution to the metabolite AMOUNT at elapsed time `tau`:
 * a first-order compartment (rate `elimRate`) driven by an exponentially-decaying
 * input `amplitude·e^(−inputRate·tau)` from a zero start. The closed form is a
 * Bateman function
 *
 *   amplitude / (elimRate − inputRate) · ( e^(−inputRate·tau) − e^(−elimRate·tau) )
 *
 * which is 0 at `tau = 0` and 0/0 when `inputRate ≈ elimRate`; the analytic limit
 * `amplitude·tau·e^(−elimRate·tau)` is used there (same relative tolerance as the
 * oral Bateman flip-flop branch in `models.ts`). `amplitude` is a formation flux
 * amplitude (mg/h) — divide the summed amount by the metabolite Vd for a
 * concentration.
 */
export function batemanMode(
  amplitude: number,
  inputRate: number,
  elimRate: number,
  tau: number,
): number {
  if (Math.abs(inputRate - elimRate) <= FLIP_FLOP_REL_TOL * Math.max(inputRate, elimRate)) {
    // Equal-rates limit — avoids the 0/0 singularity of the Bateman function.
    return amplitude * tau * Math.exp(-elimRate * tau);
  }
  const diff = Math.exp(-inputRate * tau) - Math.exp(-elimRate * tau);
  // At tau = 0 the difference is exactly 0; return +0 (not the −0 a negative
  // prefactor would produce) so callers can `=== 0` the dose instant cleanly.
  if (diff === 0) return 0;
  return (amplitude / (elimRate - inputRate)) * diff;
}

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
      (total, dose) => total + singleDoseMetaboliteConcentration(params, dose.amount, t - dose.time),
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
