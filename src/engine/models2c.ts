/**
 * Two-compartment single-dose PK models (handoff §12; the multi-compartment
 * engine extension). Pure math, IV routes only (bolus + infusion).
 *
 * Pure math, IV routes (bolus + infusion) plus oral (first-order absorption).
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
 * (see {@link ExpMode}); every route is a different way of driving those modes —
 * and the driving is model-independent, so it lives in the shared {@link ./modes.ts}
 * spine (`sumModes` / `infusionConcentrationFromModes` / `oralConcentrationFromModes`)
 * that this module and `models.ts`'s one-compartment collapse both reduce to:
 *
 *   IV bolus:     C(t) = coef_α·e^(−α·t) + coef_β·e^(−β·t)
 *   IV infusion:  C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·t))            during 0 ≤ t ≤ T
 *                 C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·T))·e^(−λ·(t−T))   after t > T
 *   oral:         C(t) = Σ batemanMode(F·D·ka·g_λ, ka, λ, t)   (a tri-exponential curve)
 *
 * where `g_λ = coef_λ / Dose` is the per-unit-dose (impulse) coefficient. Because
 * the system is linear, the dosing layer superposes time-shifted single-dose
 * curves just as for one compartment.
 *
 * `models.ts` (the one-compartment models) is deliberately left untouched; this
 * is a parallel path the UI/derivation dispatches to on the compound's `model`.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import {
  batemanModeDerivative,
  infusionConcentrationFromModes,
  oralConcentrationFromModes,
  sumModes,
} from './modes.ts';
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
 * Delegates to the shared {@link infusionConcentrationFromModes} driven by the
 * per-unit-dose (impulse) modes `g_λ = coef_λ / dose`; the two branches agree at
 * `t = T`, so the curve is continuous.
 */
function twoCompInfusionConcentration(params: TwoCompParams, dose: number, tau: number): number {
  const { infusionDuration } = params;
  if (infusionDuration === undefined) {
    throw new Error('iv_infusion (2-comp) model requires an infusion duration');
  }
  const r0 = dose / infusionDuration; // mg/h
  return infusionConcentrationFromModes(twoCompModes(params, 1), r0, infusionDuration, tau);
}

/**
 * Oral (first-order absorption), single dose `D`: the convolution of the
 * absorption input `ka·F·D·e^(−ka·t)` with the bi-exponential disposition impulse
 * response gives one {@link batemanMode} per disposition mode (α, β) — a
 * tri-exponential curve with `C(0) = 0`. Delegates to the shared
 * {@link oralConcentrationFromModes} driven by the per-unit-dose modes. Requires
 * an absorption constant `ka`; `F` defaults to 1.
 */
function twoCompOralConcentration(params: TwoCompParams, dose: number, tau: number): number {
  const { ka, F = 1 } = params;
  if (ka === undefined) {
    throw new Error('oral (2-comp) model requires an absorption rate constant (ka)');
  }
  return oralConcentrationFromModes(twoCompModes(params, 1), ka, F, dose, tau);
}

/**
 * Central concentration (mg/L) contributed by a single 2-comp dose of `dose` mg
 * at `tau` hours after administration (0 before the dose). Dispatches on route;
 * covers IV bolus, IV infusion, and oral (first-order absorption). This is the
 * two-compartment analogue of {@link singleDoseConcentration} in `models.ts`.
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
      return twoCompOralConcentration(params, dose, tau);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

/**
 * Time-to-peak (h) of a single 2-comp ORAL dose — the Tmax of its tri-exponential
 * curve. There is no closed form (unlike the one-compartment
 * `Tmax = ln(ka/ke)/(ka−ke)`), so we root-find `dC/dt = 0` in `t`. `dC/dt` is the
 * sum over the disposition modes of {@link batemanModeDerivative} (`F`/`D` drop
 * out as positive scale factors); it starts at `+ka/Vc > 0` (the curve rises out
 * of `C(0)=0`) and the unimodal oral curve has a single interior maximum, so the
 * derivative crosses zero exactly once. We bracket `[0, hi]` by growing `hi` until
 * the slope turns negative, then bisect. This is the forward that `derive.ts`'s
 * {@link kaFromTmax2c} inverts, so a ka derived from a reported Tmax round-trips
 * back to that Tmax.
 */
export function oralPeakTime2c(params: TwoCompParams): number {
  const { ka } = params;
  if (ka === undefined) {
    throw new Error('oralPeakTime2c requires an absorption rate constant (ka)');
  }
  const unitModes = twoCompModes(params, 1); // g_λ (F, D drop out of the root)
  const slope = (t: number): number =>
    unitModes.reduce((s, { coef: g, rate }) => s + batemanModeDerivative(ka * g, ka, rate, t), 0);

  // Bracket [0, hi]: slope(0) > 0; grow hi until the slope turns negative.
  let hi = 1;
  while (slope(hi) > 0) {
    hi *= 2;
    if (hi > 1e12) throw new Error('oralPeakTime2c: failed to bracket the peak');
  }
  let lo = 0;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (slope(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * hi) break;
  }
  return 0.5 * (lo + hi);
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
