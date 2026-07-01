/**
 * Parent → metabolite kinetics (handoff §12 extension; metabolites spike).
 *
 * One-compartment parent, one-compartment metabolite, linear throughout. A
 * fraction `fm` of what the parent eliminates forms the metabolite, which then
 * clears with its own rate. For an IV-BOLUS parent the parent amount is a single
 * exponential `A_p(t) = D·e^(−k_p·t)`, and the metabolite ODE
 *
 *   dA_m/dt = fm·k_p·A_p − k_m·A_m,   A_m(0) = 0
 *
 * solves in closed form to a Bateman function:
 *
 *   A_m(t) = fm·k_p·D / (k_m − k_p) · ( e^(−k_p·t) − e^(−k_m·t) )
 *   C_m(t) = A_m(t) / Vd_m
 *
 * This is STRUCTURALLY the oral Bateman model with the parent rate `k_p` playing
 * the role of the absorption constant `ka` and the metabolite rate `k_m` playing
 * the role of elimination `ke` — so it shares the same `k_p ≈ k_m` degeneracy and
 * the same analytic limit. Because the whole parent+metabolite system is linear,
 * superposition over a dose schedule stays valid (same mechanism as `dosing.ts`).
 *
 * Formation- vs elimination-rate-limited behaviour is NOT special-cased: the
 * terminal slope is simply `−min(k_p, k_m)`, which falls out of the Bateman form.
 * When `k_m > k_p` the metabolite's apparent half-life tracks the PARENT
 * (formation-rate-limited); when `k_m < k_p` it reflects the metabolite's own
 * elimination (elimination-rate-limited).
 *
 * SPIKE SCOPE: IV-bolus parent only. An oral parent (bi-exponential input → a
 * 3-exponential metabolite) and pre-systemic/first-pass formation are deferred.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import type { DoseEvent, MetaboliteParams } from './types.ts';

/**
 * Metabolite concentration (mg/L) contributed by a SINGLE IV-bolus parent dose
 * of `dose` mg, `tau` hours after that dose. Nothing has formed before the dose
 * (`tau < 0` → 0) and nothing has formed at the instant of the dose (`C_m(0) = 0`,
 * which the Bateman form gives exactly).
 *
 * When the parent and metabolite rates converge (`k_p ≈ k_m`) the Bateman
 * expression is 0/0; the analytic limit is used instead, mirroring the oral
 * model's flip-flop guard:
 *
 *   C_m(t) = (fm·k·D / Vd_m) · t · e^(−k·t)     where k = k_m ≈ k_p
 */
export function singleDoseMetaboliteConcentration(
  params: MetaboliteParams,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  const { vdM, keM, keParent, fractionFormed } = params;
  const amount = fractionFormed * dose;
  if (Math.abs(keParent - keM) <= FLIP_FLOP_REL_TOL * Math.max(keParent, keM)) {
    // Equal-rates limit — avoids the 0/0 singularity of the Bateman function.
    return ((amount * keM) / vdM) * tau * Math.exp(-keM * tau);
  }
  return (
    ((amount * keParent) / (vdM * (keParent - keM))) *
    (Math.exp(-keM * tau) - Math.exp(-keParent * tau))
  );
}

/**
 * Total metabolite concentration (mg/L) at each grid time, as the linear
 * superposition of the metabolite contribution of every scheduled parent dose.
 * Mirrors `dosing.ts`'s `concentrationCurve` (same linearity invariant): each
 * parent dose `d` contributes `singleDoseMetaboliteConcentration(params, d.amount,
 * t − d.time)`, which is 0 until the dose is given. An empty schedule yields all
 * zeros.
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
