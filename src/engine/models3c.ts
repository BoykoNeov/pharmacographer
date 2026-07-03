/**
 * Three-compartment single-dose PK models (handoff §12; the multi-compartment
 * engine extension, Stage B). Pure math, IV routes (bolus + infusion) plus oral
 * (first-order absorption).
 *
 * A linear mammillary model: a central compartment (where drug is measured and
 * eliminated) exchanging with TWO peripheral compartments that do not exchange
 * with each other. From the clinical parameters {@link ThreeCompParams}
 * (CL, Vc, Q2, Vp2, Q3, Vp3) we derive the micro-rate constants
 *
 *   k10 = CL/Vc,  k12 = Q2/Vc,  k21 = Q2/Vp2,  k13 = Q3/Vc,  k31 = Q3/Vp3
 *
 * and the three disposition eigenvalues α > β > γ. Where the two-compartment
 * model's eigenvalues are the two roots of a QUADRATIC (a closed form), the
 * three-compartment eigenvalues are the three roots of a CUBIC
 *
 *   p(λ) = λ³ − a₂·λ² + a₁·λ − a₀ = 0
 *
 * with (using the compartment exit-rate sums E1 = k10+k12+k13, E2 = k21, E3 = k31)
 *
 *   a₂ = E1 + E2 + E3
 *   a₁ = E1·E2 + E1·E3 + E2·E3 − k12·k21 − k13·k31
 *   a₀ = E1·E2·E3 − E2·k13·k31 − E3·k12·k21
 *
 * all strictly positive for physical parameters, giving three real positive
 * roots. We do NOT solve the cubic in closed form (Cardano / the trigonometric
 * method): its fragility — an arccos argument drifting outside [−1, 1] → NaN, and
 * catastrophic cancellation when the roots are widely separated, which is exactly
 * the PK regime α ≫ β ≫ γ — lands precisely where this file's oracles
 * (`C(0)=D/Vc`, `AUC=D/CL`, terminal slope `−γ`) cannot see it. Instead we
 * bracket-and-bisect, which is bulletproof for three real roots and matches the
 * codebase's existing style (`oralPeakTime2c`):
 *
 *   • p'(λ) = 3λ² − 2a₂λ + a₁ is a QUADRATIC whose two roots λ_lo < λ_hi
 *     (a closed form) strictly separate the three cubic roots:
 *        γ ∈ (0, λ_lo),   β ∈ (λ_lo, λ_hi),   α ∈ (λ_hi, a₂).
 *   • Each interval brackets a sign change of p, so bisection converges to it.
 *   • The roots come out ORDERED, so α/β/γ assignment is automatic.
 *
 * The central concentration is then a sum of three exponential MODES
 * (see {@link ExpMode}); every route is a model-independent way of driving those
 * modes, so — exactly as for one and two compartments — the routes live in the
 * shared {@link ./modes.ts} spine and this module only computes the modes. As a
 * peripheral clearance Q → 0 the corresponding eigenvalue → 0 with a vanishing
 * coefficient, so the model collapses to two compartments (and, with both gone,
 * to one) — the load-bearing regression that ties this new path to the
 * oracle-pinned 2-comp and 1-comp curves.
 *
 * `models.ts` / `models2c.ts` are deliberately left untouched; this is a parallel
 * path the UI/derivation would dispatch to on the compound's `model`.
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
import type { DoseEvent, ExpMode, Route, ThreeCompParams } from './types.ts';

/** Central micro-rate constants and disposition eigenvalues of a 3-comp model. */
export interface ThreeCompRates {
  /** Elimination from central, 1/h (`= CL/Vc`) — the metabolite's formation rate. */
  k10: number;
  /** Central → peripheral 1, 1/h (`= Q2/Vc`). */
  k12: number;
  /** Peripheral 1 → central, 1/h (`= Q2/Vp2`). */
  k21: number;
  /** Central → peripheral 2, 1/h (`= Q3/Vc`). */
  k13: number;
  /** Peripheral 2 → central, 1/h (`= Q3/Vp3`). */
  k31: number;
  /** Distribution eigenvalue, 1/h (the largest root). */
  alpha: number;
  /** Intermediate eigenvalue, 1/h (the middle root). */
  beta: number;
  /** Terminal eigenvalue, 1/h (the smallest root) — the terminal log-slope. */
  gamma: number;
}

/**
 * Find the single root of `p` in the closed bracket [lo, hi], which is assumed to
 * hold a sign change (`p(lo)` and `p(hi)` differ in sign — or an endpoint is
 * exactly a root). Direction-agnostic bisection: it tracks which endpoint shares
 * the sign of `p(lo)` rather than assuming increasing/decreasing, so it locates
 * γ (p rises − → +), β (p falls + → −) and α (p rises − → +) with one routine.
 * The 200-iteration cap mirrors `oralPeakTime2c`.
 */
function bisectRoot(p: (x: number) => number, lo: number, hi: number, scale: number): number {
  let a = lo;
  let b = hi;
  const fa = p(a);
  if (fa === 0) return a;
  if (p(b) === 0) return b;
  const faPositive = fa > 0;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (a + b);
    const fmid = p(mid);
    if (fmid === 0) return mid;
    if (fmid > 0 === faPositive) a = mid;
    else b = mid;
    if (b - a <= 1e-15 * scale) break;
  }
  return 0.5 * (a + b);
}

/**
 * Micro-rate constants + the three eigenvalues α > β > γ from the clinical
 * parameters, via the derivative-bracketed bisection described in the module
 * header. The roots are always real (a mammillary model can't oscillate), so no
 * complex arithmetic is needed. At a collapse edge (Q → 0) one root goes to 0 and
 * the brackets degenerate gracefully — `p(0) = −a₀ = 0` makes γ = 0 fall out of
 * the first bracket.
 */
export function threeCompRates(params: ThreeCompParams): ThreeCompRates {
  const { vc, cl, q2, vp2, q3, vp3 } = params;
  const k10 = cl / vc;
  const k12 = q2 / vc;
  const k21 = q2 / vp2;
  const k13 = q3 / vc;
  const k31 = q3 / vp3;

  const e1 = k10 + k12 + k13;
  const e2 = k21;
  const e3 = k31;
  const a2 = e1 + e2 + e3;
  const a1 = e1 * e2 + e1 * e3 + e2 * e3 - k12 * k21 - k13 * k31;
  const a0 = e1 * e2 * e3 - e2 * k13 * k31 - e3 * k12 * k21;

  const p = (x: number): number => ((x - a2) * x + a1) * x - a0; // Horner: x³ − a₂x² + a₁x − a₀

  // p'(x) = 3x² − 2a₂x + a₁; its two roots λ_lo ≤ λ_hi separate the three roots
  // of p. The discriminant is ≥ 0 whenever p has three real roots.
  const critDisc = Math.sqrt(Math.max(0, a2 * a2 - 3 * a1));
  const critLo = (a2 - critDisc) / 3;
  const critHi = (a2 + critDisc) / 3;
  const scale = a2 > 0 ? a2 : 1;

  // γ ∈ (0, λ_lo): p(0) = −a₀ ≤ 0, p(λ_lo) is the first local max (≥ 0). When the
  // bracket is degenerate (λ_lo ≈ 0, the full 1-comp collapse) p(0) = 0 gives γ = 0.
  const gamma =
    critLo <= 0 || p(critLo) <= 0 ? Math.max(0, critLo) : bisectRoot(p, 0, critLo, scale);
  // β ∈ (λ_lo, λ_hi): p rises to a local max at λ_lo then falls to a local min at λ_hi.
  const beta = critHi <= critLo ? critLo : bisectRoot(p, critLo, critHi, scale);
  // α ∈ (λ_hi, a₂): the largest root is < a₂ (the sum of the three positive roots).
  const alpha = bisectRoot(p, critHi, a2, scale);

  return { k10, k12, k21, k13, k31, alpha, beta, gamma };
}

/**
 * The central concentration's exponential modes for a single dose `D` (mg). For
 * each eigenvalue λ the per-unit-dose (impulse) coefficient is the residue of the
 * central-compartment transfer function:
 *
 *   g_λ = (k21 − λ)·(k31 − λ) / ( Vc · Π_{μ≠λ}(μ − λ) )
 *
 * (peripheral back-rates k21, k31 in the numerator; the other two eigenvalues in
 * the denominator). A Lagrange divided-difference identity makes `Σ_λ g_λ = 1/Vc`
 * exactly, so `C(0) = Σ coef = D/Vc` — the whole dose starts in the central
 * compartment. This is the direct three-mode analogue of `models2c.ts`'s
 * `twoCompModes` and collapses to it as Q3 → 0.
 *
 * Degeneracy guard: when two eigenvalues coincide a residue denominator → 0. At
 * every physical collapse edge the coinciding mode's NUMERATOR also → 0 (its
 * weight vanishes — e.g. the terminal γ-mode as Q → 0), so we drop such a mode
 * rather than divide 0/0; the surviving modes still carry the full `1/Vc`. (A
 * genuine repeated root away from a collapse edge would need a `t·e^(−λt)` limit
 * term and does not arise for physical three-compartment parameters — the same
 * defensive posture `twoCompModes` takes for its α ≈ β edge.) If every mode is
 * degenerate the curve falls back to a single mono-exponential `D/Vc · e^(−α t)`.
 */
export function threeCompModes(params: ThreeCompParams, dose: number): ExpMode[] {
  const { vc } = params;
  const { k21, k31, alpha, beta, gamma } = threeCompRates(params);
  const roots = [alpha, beta, gamma];
  const scale = alpha > 0 ? alpha : 1;
  const tol = FLIP_FLOP_REL_TOL * scale;

  const modes: ExpMode[] = [];
  for (let i = 0; i < roots.length; i++) {
    const lambda = roots[i]!;
    let denom = vc;
    let degenerate = false;
    for (let j = 0; j < roots.length; j++) {
      if (j === i) continue;
      const gap = roots[j]! - lambda;
      if (Math.abs(gap) <= tol) {
        degenerate = true;
        break;
      }
      denom *= gap;
    }
    if (degenerate) continue; // coinciding mode carries vanishing weight — drop it
    const coef = (dose * (k21 - lambda) * (k31 - lambda)) / denom;
    modes.push({ coef, rate: lambda });
  }

  if (modes.length === 0) {
    // Fully degenerate (all roots coincide): keep the curve finite and C(0)=D/Vc.
    return [{ coef: dose / vc, rate: alpha }];
  }
  return modes;
}

/**
 * IV bolus, single dose `D`: the whole dose enters the central compartment
 * instantly, then disposes tri-exponentially. `C(0) = D/Vc`.
 */
function threeCompBolusConcentration(params: ThreeCompParams, dose: number, tau: number): number {
  return sumModes(threeCompModes(params, dose), tau);
}

/**
 * IV infusion, total dose `D` over `infusionDuration` at constant rate
 * `R0 = D / infusionDuration` (zero-order in, tri-exponential disposition out).
 * Delegates to the shared {@link infusionConcentrationFromModes} driven by the
 * per-unit-dose modes `g_λ = coef_λ / dose`; the branches agree at `t = T`, so
 * the curve is continuous.
 */
function threeCompInfusionConcentration(
  params: ThreeCompParams,
  dose: number,
  tau: number,
): number {
  const { infusionDuration } = params;
  if (infusionDuration === undefined) {
    throw new Error('iv_infusion (3-comp) model requires an infusion duration');
  }
  const r0 = dose / infusionDuration; // mg/h
  return infusionConcentrationFromModes(threeCompModes(params, 1), r0, infusionDuration, tau);
}

/**
 * Oral (first-order absorption), single dose `D`: the convolution of the
 * absorption input `ka·F·D·e^(−ka·t)` with the tri-exponential disposition
 * impulse response gives one {@link batemanMode} per disposition mode (α, β, γ) —
 * a four-exponential curve with `C(0) = 0`. Delegates to the shared
 * {@link oralConcentrationFromModes}. Requires an absorption constant `ka`; `F`
 * defaults to 1.
 */
function threeCompOralConcentration(params: ThreeCompParams, dose: number, tau: number): number {
  const { ka, F = 1 } = params;
  if (ka === undefined) {
    throw new Error('oral (3-comp) model requires an absorption rate constant (ka)');
  }
  return oralConcentrationFromModes(threeCompModes(params, 1), ka, F, dose, tau);
}

/**
 * Central concentration (mg/L) contributed by a single 3-comp dose of `dose` mg
 * at `tau` hours after administration (0 before the dose). Dispatches on route;
 * covers IV bolus, IV infusion, and oral (first-order absorption). The
 * three-compartment analogue of {@link singleDose2cConcentration}.
 */
export function singleDose3cConcentration(
  route: Route,
  params: ThreeCompParams,
  dose: number,
  tau: number,
): number {
  if (tau < 0) return 0;
  switch (route) {
    case 'iv_bolus':
      return threeCompBolusConcentration(params, dose, tau);
    case 'iv_infusion':
      return threeCompInfusionConcentration(params, dose, tau);
    case 'oral':
      return threeCompOralConcentration(params, dose, tau);
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

/**
 * Time-to-peak (h) of a single 3-comp ORAL dose — the Tmax of its
 * four-exponential curve. No closed form, so we root-find `dC/dt = 0` in `t`:
 * `dC/dt` is the sum over disposition modes of {@link batemanModeDerivative}
 * (`F`/`D` drop out as positive scale factors); it starts at `+ka/Vc > 0` and the
 * unimodal oral curve has a single interior maximum, so the derivative crosses
 * zero exactly once. Bracket `[0, hi]` by growing `hi` until the slope turns
 * negative, then bisect — the same idiom as {@link oralPeakTime2c}.
 */
export function oralPeakTime3c(params: ThreeCompParams): number {
  const { ka } = params;
  if (ka === undefined) {
    throw new Error('oralPeakTime3c requires an absorption rate constant (ka)');
  }
  const unitModes = threeCompModes(params, 1); // g_λ (F, D drop out of the root)
  const slope = (t: number): number =>
    unitModes.reduce((s, { coef: g, rate }) => s + batemanModeDerivative(ka * g, ka, rate, t), 0);

  let hi = 1;
  while (slope(hi) > 0) {
    hi *= 2;
    if (hi > 1e12) throw new Error('oralPeakTime3c: failed to bracket the peak');
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
 * superposition of every scheduled 3-comp dose. Mirrors {@link concentrationCurve2c}
 * (same linearity invariant): each dose contributes
 * `singleDose3cConcentration(route, params, d.amount, t − d.time)`, which is 0
 * until the dose is given. An empty schedule yields all zeros.
 */
export function concentrationCurve3c(
  route: Route,
  params: ThreeCompParams,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  return timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) => total + singleDose3cConcentration(route, params, dose.amount, t - dose.time),
      0,
    ),
  );
}
