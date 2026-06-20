/**
 * Single-dose PK models (handoff §7).
 *
 * Pure one-compartment concentration math. Given parameters already resolved to
 * canonical units (mg, L, h, 1/h) and the time elapsed since ONE dose, return
 * the concentration that dose contributes. This is the building block the
 * dosing layer (Phase 2) sums over via superposition to handle multiple and
 * recurring schedules — keeping that one mechanism is why the engine stays
 * linear and testable.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import type { PkParams, Route } from './types.ts';

/**
 * Relative tolerance for treating `ka` and `ke` as equal in the oral model.
 *
 * The Bateman function divides by `(ka − ke)`, so it degenerates to 0/0 as the
 * two rates converge (the "flip-flop" / equal-rates case). Below this threshold
 * we switch to the analytic limit. The test is RELATIVE — `|ka − ke|` compared
 * to the larger rate — so it behaves identically whether the rates are ~0.01/h
 * or ~10/h, rather than depending on their absolute magnitude (handoff §7).
 */
export const FLIP_FLOP_REL_TOL = 1e-6;

/**
 * IV bolus, single dose `D`: the whole dose enters the central compartment
 * instantly, then eliminates first-order.
 *
 *   C(t) = (D / Vd) · e^(−ke·t)
 */
function ivBolusConcentration(params: PkParams, dose: number, tau: number): number {
  const { vd, ke } = params;
  return (dose / vd) * Math.exp(-ke * tau);
}

/**
 * Oral, single dose `D` — first-order absorption into, first-order elimination
 * out of, one compartment (the Bateman function):
 *
 *   C(t) = (F·D·ka) / (Vd·(ka − ke)) · ( e^(−ke·t) − e^(−ka·t) )
 *
 * When `ka ≈ ke` the expression is 0/0; the analytic limit is used instead:
 *
 *   C(t) = (F·D·ke / Vd) · t · e^(−ke·t)
 *
 * `F` (bioavailable fraction) defaults to 1 when unspecified.
 */
function oralConcentration(params: PkParams, dose: number, tau: number): number {
  const { vd, ke, ka, F = 1 } = params;
  if (ka === undefined) {
    throw new Error('oral model requires an absorption rate constant (ka)');
  }
  if (Math.abs(ka - ke) <= FLIP_FLOP_REL_TOL * Math.max(ka, ke)) {
    // Equal-rates limit — avoids the 0/0 singularity of the Bateman function.
    return ((F * dose * ke) / vd) * tau * Math.exp(-ke * tau);
  }
  return ((F * dose * ka) / (vd * (ka - ke))) * (Math.exp(-ke * tau) - Math.exp(-ka * tau));
}

/**
 * IV infusion, total dose `D` delivered at a constant rate over
 * `infusionDuration` (zero-order in, first-order out). The constant input rate
 * is `R0 = D / infusionDuration`.
 *
 *   during (0 ≤ t ≤ T):  C(t) = (R0 / (Vd·ke)) · (1 − e^(−ke·t))
 *   after  (t > T):       C(t) = (R0 / (Vd·ke)) · (1 − e^(−ke·T)) · e^(−ke·(t−T))
 *
 * The two branches agree at `t = T`, so the curve is continuous.
 */
function ivInfusionConcentration(params: PkParams, dose: number, tau: number): number {
  const { vd, ke, infusionDuration } = params;
  if (infusionDuration === undefined) {
    throw new Error('iv_infusion model requires an infusion duration');
  }
  const r0 = dose / infusionDuration; // mg/h
  const plateau = r0 / (vd * ke); // R0 / (Vd·ke) — the steady-state ceiling if infused forever
  if (tau <= infusionDuration) {
    return plateau * (1 - Math.exp(-ke * tau));
  }
  return (
    plateau * (1 - Math.exp(-ke * infusionDuration)) * Math.exp(-ke * (tau - infusionDuration))
  );
}

/**
 * Concentration (mg/L) contributed by a single dose of `dose` mg at `tau` hours
 * after its administration. A dose contributes nothing before it is given
 * (`tau < 0` → 0). Dispatches on route; throws if the route's required
 * parameters are missing.
 *
 * This is the `singleDoseCurve` building block referenced in handoff §7: the
 * dosing layer evaluates it at `(t − t_i)` for each scheduled dose `i` and sums
 * the contributions (valid for linear PK only).
 */
export function singleDoseConcentration(
  route: Route,
  params: PkParams,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  switch (route) {
    case 'iv_bolus':
      return ivBolusConcentration(params, dose, tau);
    case 'oral':
      return oralConcentration(params, dose, tau);
    case 'iv_infusion':
      return ivInfusionConcentration(params, dose, tau);
    default: {
      // Exhaustiveness guard: if `Route` gains a member, this fails to compile
      // until a branch is added above.
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}
