/**
 * Closed-form PK quantities (handoff §7 "Useful closed forms", §13 Phase 2).
 *
 * Exact analytic expressions used both by the UI (to annotate a curve with its
 * Tmax, total exposure, and steady-state peak/trough/average) and as oracles in
 * the tests. They operate on resolved `PkParams` in canonical units
 * (mg, L, h, 1/h) — the same parameters the model functions consume.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import { twoCompRates } from './models2c.ts';
import type { PkParams, TwoCompParams } from './types.ts';

/**
 * Clearance CL = ke·Vd (L/h). A derived identity in the one-compartment model,
 * not an independent parameter — used by the exposure / Cavg formulas below.
 */
export function clearance(params: PkParams): number {
  return params.ke * params.vd;
}

/**
 * Oral time-to-peak Tmax = ln(ka/ke) / (ka − ke) (h). Requires `ka`.
 *
 * As ka → ke the expression is 0/0; the analytic limit is Tmax → 1/ke. The same
 * relative tolerance as the Bateman flip-flop branch in `models.ts` selects the
 * limit, so the closed form and the curve agree on where the boundary sits.
 */
export function timeToPeak(params: PkParams): number {
  const { ke, ka } = params;
  if (ka === undefined) {
    throw new Error('timeToPeak requires an absorption rate constant (ka)');
  }
  if (Math.abs(ka - ke) <= FLIP_FLOP_REL_TOL * Math.max(ka, ke)) {
    return 1 / ke;
  }
  return Math.log(ka / ke) / (ka - ke);
}

/**
 * Total exposure of a SINGLE dose, AUC₀→∞ = F·D / (Vd·ke) = F·D / CL (mg·h/L).
 * `F` defaults to 1 (IV). Route-independent given F: absorption rate changes the
 * shape of the curve, not the area under it.
 */
export function singleDoseAuc(params: PkParams, dose: number): number {
  const { vd, ke, F = 1 } = params;
  return (F * dose) / (vd * ke);
}

/**
 * Accumulation ratio R = 1 / (1 − e^(−ke·τ)) for a dose repeated every τ hours.
 * Dimensionless; depends only on the product ke·τ. R → 1 as τ ≫ t½ (no
 * accumulation) and grows without bound as τ → 0.
 */
export function accumulationRatio(ke: number, interval: number): number {
  return 1 / (1 - Math.exp(-ke * interval));
}

/**
 * Average steady-state concentration Cavg,ss = F·D / (CL·τ) (mg/L) for a dose
 * `D` repeated every τ hours. Equivalent to the single-dose AUC spread over one
 * dosing interval, hence route-independent given F.
 */
export function cavgSteadyState(params: PkParams, dose: number, interval: number): number {
  return singleDoseAuc(params, dose) / interval;
}

/** Steady-state peak, trough, and average for a repeated IV BOLUS dose. */
export interface SteadyStateIvBolus {
  /** Peak — immediately after a dose, mg/L. */
  cmax: number;
  /** Trough — immediately before the next dose, mg/L. */
  cmin: number;
  /** Interval-average over one τ, mg/L. */
  cavg: number;
}

// ── Two-compartment closed forms (handoff §12) ──────────────────────────────
// Exact quantities for the multi-compartment model, used to annotate its curve
// and as test oracles. All are strikingly simple because AUC and the terminal
// slope are governed by the central clearance and the slow eigenvalue alone —
// distribution only reshapes the early curve, not the total exposure.

/**
 * Central concentration at the instant of a 2-comp IV bolus, `C(0) = D/Vc`
 * (mg/L). The whole dose starts in the central compartment, so the peak is set
 * by the CENTRAL volume — smaller than the total (steady-state) Vd, so a 2-comp
 * bolus peaks higher than a one-compartment collapse would predict.
 */
export function initialConcentration2c(params: TwoCompParams, dose: number): number {
  return dose / params.vc;
}

/**
 * Total exposure of a SINGLE 2-comp dose, AUC₀→∞ = D / CL (mg·h/L). Identical to
 * the one-compartment result and independent of the distribution parameters
 * (Q, Vp) and the route — a teaching point: distribution moves drug around, only
 * clearance removes it.
 */
export function singleDoseAuc2c(params: TwoCompParams, dose: number): number {
  return dose / params.cl;
}

/**
 * Terminal (log-linear) elimination rate constant of a 2-comp model, β (1/h) —
 * the smaller disposition eigenvalue. The late curve decays as `e^(−β·t)`, so the
 * terminal half-life is `ln2/β`. β is always ≤ k10, i.e. the terminal phase is
 * slower than pure central elimination because peripheral drug returns.
 */
export function terminalRate2c(params: TwoCompParams): number {
  return twoCompRates(params).beta;
}

/**
 * Steady-state Cmax / Cmin / Cavg for an IV bolus dose `D` repeated every τ
 * hours (handoff §7):
 *
 *   Cmax,ss = (D/Vd)·R,   Cmin,ss = Cmax,ss·e^(−ke·τ),   Cavg,ss = F·D/(CL·τ)
 *
 * Peak and trough are bolus-specific — an IV bolus peaks the instant it is
 * given and decays monotonically to the trough just before the next dose. Cavg
 * is the general formula (F = 1 for IV).
 */
export function steadyStateIvBolus(
  params: PkParams,
  dose: number,
  interval: number,
): SteadyStateIvBolus {
  const { vd, ke } = params;
  const r = accumulationRatio(ke, interval);
  const cmax = (dose / vd) * r;
  const cmin = cmax * Math.exp(-ke * interval);
  return { cmax, cmin, cavg: cavgSteadyState(params, dose, interval) };
}
