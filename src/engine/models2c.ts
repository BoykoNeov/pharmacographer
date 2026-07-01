/**
 * Two-compartment single-dose PK models (handoff §12; the multi-compartment
 * engine extension). Pure math, IV routes only (bolus + infusion).
 *
 * A linear mammillary model: a central compartment (measured, eliminated from)
 * exchanging with one peripheral compartment. From the clinical parameters
 * {@link TwoCompParams} (CL, Vc, Q, Vp) we derive the micro-rate constants and
 * the two disposition eigenvalues α (distribution, larger) and β (terminal,
 * smaller):
 *
 *   k10 = CL/Vc,  k12 = Q/Vc,  k21 = Q/Vp
 *   α, β = ½·[ (k10+k12+k21) ± √((k10+k12+k21)² − 4·k10·k21) ]
 *
 * The central concentration is then a sum of two exponential MODES
 * (see {@link ExpMode}); every route is a different way of driving those modes:
 *
 *   IV bolus:     C(t) = coef_α·e^(−α·t) + coef_β·e^(−β·t)
 *   IV infusion:  C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·t))            during 0 ≤ t ≤ T
 *                 C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·T))·e^(−λ·(t−T))   after t > T
 *
 * where `g_λ = coef_λ / Dose` is the per-unit-dose (impulse) coefficient. This is
 * exactly the one-compartment infusion formula (`models.ts`) summed per mode —
 * the single-mode case reduces to it. Because the system is linear, the dosing
 * layer superposes time-shifted single-dose curves just as for one compartment.
 *
 * `models.ts` (the one-compartment models) is deliberately left untouched; this
 * is a parallel path the UI/derivation dispatches to on the compound's `model`.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import type { DoseEvent, ExpMode, Route, TwoCompParams } from './types.ts';

/** Central micro-rate constants and disposition eigenvalues of a 2-comp model. */
export interface TwoCompRates {
  /** Elimination from central, 1/h (`= CL/Vc`) — the metabolite's formation rate. */
  k10: number;
  /** Central → peripheral, 1/h (`= Q/Vc`). */
  k12: number;
  /** Peripheral → central, 1/h (`= Q/Vp`). */
  k21: number;
  /** Distribution eigenvalue, 1/h (the larger root). */
  alpha: number;
  /** Terminal eigenvalue, 1/h (the smaller root) — the terminal log-slope. */
  beta: number;
}

/**
 * Micro-rate constants + eigenvalues from the clinical parameters. The
 * discriminant `(k10+k12+k21)² − 4·k10·k21` equals `(k10+k12−k21)² + 4·k12·k21`,
 * which is ≥ 0 for non-negative rates, so the roots are always real (no complex
 * / oscillatory disposition — a mammillary model can't overshoot).
 */
export function twoCompRates(params: TwoCompParams): TwoCompRates {
  const { vc, cl, q, vp } = params;
  const k10 = cl / vc;
  const k12 = q / vc;
  const k21 = q / vp;
  const sum = k10 + k12 + k21;
  const disc = Math.sqrt(Math.max(0, sum * sum - 4 * k10 * k21));
  const alpha = 0.5 * (sum + disc);
  const beta = 0.5 * (sum - disc);
  return { k10, k12, k21, alpha, beta };
}

/**
 * The central concentration's exponential modes for a single dose `D` (mg). Each
 * mode's `coef` (mg/L) is `D · g_λ` where the per-unit-dose coefficients are
 *
 *   g_α = (α − k21) / (Vc·(α − β)),   g_β = (k21 − β) / (Vc·(α − β))
 *
 * so that `g_α + g_β = 1/Vc` and hence `C(0) = D/Vc` (the whole dose starts in
 * the central compartment). As the peripheral clearance `Q → 0` the model
 * collapses to one compartment: `β → 0` with `coef_β → 0`, leaving the single
 * mode `C(t) = (D/Vc)·e^(−k10·t)` (k10 = CL/Vc = ke). `α − β` stays bounded away
 * from 0 for physical parameters, but a defensive tolerance guards the 0/0 the
 * repeated-root edge would otherwise produce.
 */
export function twoCompModes(params: TwoCompParams, dose: number): ExpMode[] {
  const { vc } = params;
  const { k21, alpha, beta } = twoCompRates(params);
  const gap = alpha - beta;
  if (gap <= FLIP_FLOP_REL_TOL * alpha) {
    // Degenerate (repeated-root) edge: fall back to the mono-exponential form,
    // which is also the exact Q → 0 collapse. Keeps the curve finite.
    return [{ coef: dose / vc, rate: alpha }];
  }
  const gAlpha = (alpha - k21) / (vc * gap);
  const gBeta = (k21 - beta) / (vc * gap);
  return [
    { coef: dose * gAlpha, rate: alpha },
    { coef: dose * gBeta, rate: beta },
  ];
}

/** Sum the exponential modes at elapsed time `tau` (h). */
function sumModes(modes: ExpMode[], tau: number): number {
  return modes.reduce((total, m) => total + m.coef * Math.exp(-m.rate * tau), 0);
}

/**
 * IV bolus, single dose `D`: the whole dose enters the central compartment
 * instantly, then disposes bi-exponentially. `C(0) = D/Vc`.
 */
function twoCompBolusConcentration(params: TwoCompParams, dose: number, tau: number): number {
  return sumModes(twoCompModes(params, dose), tau);
}

/**
 * IV infusion, total dose `D` over `infusionDuration` at constant rate
 * `R0 = D / infusionDuration` (zero-order in, bi-exponential disposition out).
 * Per mode the plateau contribution is `R0·g_λ/λ`; the two branches agree at
 * `t = T`, so the curve is continuous.
 */
function twoCompInfusionConcentration(params: TwoCompParams, dose: number, tau: number): number {
  const { infusionDuration } = params;
  if (infusionDuration === undefined) {
    throw new Error('iv_infusion (2-comp) model requires an infusion duration');
  }
  const r0 = dose / infusionDuration; // mg/h
  // Per-unit-dose (impulse) modes: g_λ = coef_λ / dose.
  const modes = twoCompModes(params, 1);
  return modes.reduce((total, { coef: g, rate: lambda }) => {
    // A zero-rate, zero-weight mode only appears at the Q → 0 collapse (β → 0
    // with coef → 0); it contributes nothing and would divide by zero here.
    if (lambda === 0 || g === 0) return total;
    const plateau = (r0 * g) / lambda; // R0·g_λ/λ — this mode's steady-state ceiling
    if (tau <= infusionDuration) {
      return total + plateau * (1 - Math.exp(-lambda * tau));
    }
    return (
      total +
      plateau * (1 - Math.exp(-lambda * infusionDuration)) * Math.exp(-lambda * (tau - infusionDuration))
    );
  }, 0);
}

/**
 * Central concentration (mg/L) contributed by a single 2-comp dose of `dose` mg
 * at `tau` hours after administration (0 before the dose). Dispatches on route;
 * the extension covers the IV routes only — `oral` (a tri-exponential parent) is
 * deferred and throws. This is the two-compartment analogue of
 * {@link singleDoseConcentration} in `models.ts`.
 */
export function singleDose2cConcentration(
  route: Route,
  params: TwoCompParams,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  switch (route) {
    case 'iv_bolus':
      return twoCompBolusConcentration(params, dose, tau);
    case 'iv_infusion':
      return twoCompInfusionConcentration(params, dose, tau);
    case 'oral':
      throw new Error(
        'oral is not supported by the two-compartment model yet (a tri-exponential parent; deferred — handoff §12)',
      );
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

/**
 * Total central concentration (mg/L) at each grid time, as the linear
 * superposition of every scheduled 2-comp dose. Mirrors `dosing.ts`'s
 * `concentrationCurve` (same linearity invariant): each dose `d` contributes
 * `singleDose2cConcentration(route, params, d.amount, t − d.time)`, which is 0
 * until the dose is given. An empty schedule yields all zeros.
 */
export function concentrationCurve2c(
  route: Route,
  params: TwoCompParams,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) => total + singleDose2cConcentration(route, params, dose.amount, t - dose.time),
      0,
    ),
  );
}
