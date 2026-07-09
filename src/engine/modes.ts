/**
 * Shared exponential-mode drivers (handoff §12; the multi-compartment spine).
 *
 * Every linear disposition — one-, two-, or three-compartment — expresses its
 * central concentration for a single dose as a sum of exponential MODES
 * (see {@link ExpMode}): `C(t) = Σ coef_λ·e^(−λ·t)`. What differs between models is
 * only HOW the modes are computed (a scalar for one compartment, a quadratic for
 * two, a cubic for three); once you have them, the ROUTES are model-independent.
 * This module is those model-independent drivers, so `models2c.ts` / `models3c.ts`
 * don't each re-implement the bolus / infusion / oral evaluation:
 *
 *   IV bolus:     C(t) = Σ coef_λ·e^(−λ·t)                              (sumModes)
 *   IV infusion:  C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·t))          during 0 ≤ t ≤ T
 *                 C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·T))·e^(−λ·(t−T))     after t > T
 *   oral:         C(t) = Σ batemanMode(F·D·ka·g_λ, ka, λ, t)
 *
 * where `g_λ = coef_λ / Dose` are the per-unit-dose (impulse) coefficients. The
 * oral form is the convolution of first-order absorption `ka·F·D·e^(−ka·t)` with
 * the disposition's unit impulse response `Σ g_λ·e^(−λ·t)`; each mode convolves to
 * a Bateman term, so the oral curve reuses {@link batemanMode} and inherits its
 * `ka ≈ λ` flip-flop guard for free. As the peripheral clearance(s) vanish the
 * modes collapse to a single mode and every driver reduces to its one-compartment
 * form (`models.ts`).
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { FLIP_FLOP_REL_TOL } from './models.ts';
import type { ExpMode } from './types.ts';

/**
 * One first-order compartment (rate `elimRate`) driven from a zero start by an
 * exponentially-decaying input `amplitude·e^(−inputRate·tau)`; the Bateman
 * function
 *
 *   amplitude / (elimRate − inputRate) · ( e^(−inputRate·tau) − e^(−elimRate·tau) )
 *
 * which is 0 at `tau = 0` and 0/0 when `inputRate ≈ elimRate`; the analytic limit
 * `amplitude·tau·e^(−elimRate·tau)` is used there (same relative tolerance as the
 * oral Bateman flip-flop branch in `models.ts`). Unit-agnostic: `amplitude` may be
 * a formation flux (mg/h → the metabolite AMOUNT) or a concentration flux
 * (mg/(L·h) → a central CONCENTRATION for an oral mode); the caller supplies units.
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
 * Time-derivative `d/dtau` of {@link batemanMode} — the slope of one Bateman
 * term. Differentiating
 *
 *   amplitude / (elimRate − inputRate) · ( e^(−inputRate·tau) − e^(−elimRate·tau) )
 *
 * gives
 *
 *   amplitude / (elimRate − inputRate) · ( elimRate·e^(−elimRate·tau) − inputRate·e^(−inputRate·tau) )
 *
 * and the equal-rates limit `amplitude·(1 − elimRate·tau)·e^(−elimRate·tau)` (the
 * derivative of `amplitude·tau·e^(−elimRate·tau)`) covers the `inputRate ≈ elimRate`
 * 0/0 with the same tolerance. At `tau = 0` this is `+amplitude` (the curve rises
 * out of zero). Used to locate an oral curve's peak — the sum of these over the
 * disposition modes is `dC/dt`, whose root is Tmax — without a nested peak search:
 * `models2c.ts`'s `oralPeakTime2c` solves it in `t`, `derive.ts`'s `kaFromTmax2c`
 * solves it in `ka`. Unit-agnostic, like {@link batemanMode}.
 */
export function batemanModeDerivative(
  amplitude: number,
  inputRate: number,
  elimRate: number,
  tau: number,
): number {
  if (Math.abs(inputRate - elimRate) <= FLIP_FLOP_REL_TOL * Math.max(inputRate, elimRate)) {
    return amplitude * (1 - elimRate * tau) * Math.exp(-elimRate * tau);
  }
  return (
    (amplitude / (elimRate - inputRate)) *
    (elimRate * Math.exp(-elimRate * tau) - inputRate * Math.exp(-inputRate * tau))
  );
}

/**
 * Running area `∫₀^tau batemanMode(amplitude, inputRate, elimRate, v) dv` — the
 * cumulative exposure of one Bateman term from the dose instant to `tau`.
 * Integrating
 *
 *   amplitude / (elimRate − inputRate) · ( e^(−inputRate·v) − e^(−elimRate·v) )
 *
 * gives
 *
 *   amplitude / (elimRate − inputRate) · ( (1 − e^(−inputRate·tau))/inputRate
 *                                        − (1 − e^(−elimRate·tau))/elimRate )
 *
 * and the equal-rates limit `amplitude · (1 − e^(−elimRate·tau)(1 + elimRate·tau)) / elimRate²`
 * (the integral of `amplitude·v·e^(−elimRate·v)`) covers the `inputRate ≈ elimRate`
 * 0/0 with the SAME tolerance as {@link batemanMode}, so the integrand and its
 * integral switch branches at the same boundary. `0` at `tau = 0`; as `tau → ∞`
 * it tends to `amplitude/(inputRate·elimRate)` (the full Bateman AUC). Used to
 * build the metabolite of an IV-INFUSION parent, whose zero-order input makes the
 * metabolite the convolution of a rectangular window with the unit-bolus Bateman
 * response — that convolution is a difference of these running areas. Unit-agnostic
 * like {@link batemanMode}. Precondition: `inputRate > 0` and `elimRate > 0` (both
 * hold for physical disposition/elimination rates — the caller skips any zero-rate
 * collapse mode, as {@link infusionConcentrationFromModes} does).
 */
export function batemanModeIntegral(
  amplitude: number,
  inputRate: number,
  elimRate: number,
  tau: number,
): number {
  if (Math.abs(inputRate - elimRate) <= FLIP_FLOP_REL_TOL * Math.max(inputRate, elimRate)) {
    return (
      (amplitude * (1 - Math.exp(-elimRate * tau) * (1 + elimRate * tau))) / (elimRate * elimRate)
    );
  }
  return (
    (amplitude / (elimRate - inputRate)) *
    ((1 - Math.exp(-inputRate * tau)) / inputRate - (1 - Math.exp(-elimRate * tau)) / elimRate)
  );
}

/** Sum the exponential modes at elapsed time `tau` (h) — the IV-bolus curve. */
export function sumModes(modes: ExpMode[], tau: number): number {
  return modes.reduce((total, m) => total + m.coef * Math.exp(-m.rate * tau), 0);
}

/**
 * IV infusion from the per-unit-dose modes `unitModes` (`g_λ = coef_λ/Dose`),
 * total dose delivered at constant rate `r0 = Dose/duration` over `duration` h
 * (zero-order in, multi-exponential disposition out). Per mode the plateau
 * contribution is `r0·g_λ/λ`; the during/after branches agree at `tau = duration`,
 * so the curve is continuous. A zero-rate, zero-weight mode (the collapse edge,
 * `λ → 0` with `g → 0`) contributes nothing and is skipped so it can't divide by 0.
 */
export function infusionConcentrationFromModes(
  unitModes: ExpMode[],
  r0: number,
  duration: number,
  tau: number,
): number {
  return unitModes.reduce((total, { coef: g, rate: lambda }) => {
    if (lambda === 0 || g === 0) return total;
    const plateau = (r0 * g) / lambda; // r0·g_λ/λ — this mode's steady-state ceiling
    if (tau <= duration) {
      return total + plateau * (1 - Math.exp(-lambda * tau));
    }
    return total + plateau * (1 - Math.exp(-lambda * duration)) * Math.exp(-lambda * (tau - duration));
  }, 0);
}

/**
 * Oral (first-order absorption) central concentration for a single dose `dose`
 * mg, from the per-unit-dose disposition modes `unitModes` (`g_λ = coef_λ/Dose`),
 * absorption constant `ka`, and bioavailable fraction `F`. The convolution of the
 * absorption input `ka·F·D·e^(−ka·t)` with the impulse response `Σ g_λ·e^(−λ·t)`
 * gives one {@link batemanMode} per disposition mode:
 *
 *   C(t) = Σ_λ batemanMode(ka·F·D·g_λ, ka, λ, t)
 *
 * so `C(0) = 0` (nothing absorbed yet) and the `ka ≈ λ` flip-flop is handled by
 * `batemanMode`. As the disposition collapses to a single mode `g = 1/Vd` at rate
 * `ke`, this reduces to the one-compartment oral Bateman in `models.ts`.
 */
export function oralConcentrationFromModes(
  unitModes: ExpMode[],
  ka: number,
  F: number,
  dose: number,
  tau: number,
): number {
  return unitModes.reduce(
    (total, { coef: g, rate: lambda }) => total + batemanMode(ka * F * dose * g, ka, lambda, tau),
    0,
  );
}
