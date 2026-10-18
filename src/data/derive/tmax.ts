/**
 * Invert a reported Tmax for the absorption constant `ka`: in closed form for one
 * compartment, and by one mode-based solve shared by two and three.
 */

import { FLIP_FLOP_REL_TOL } from '../../engine/models.ts';
import { batemanModeDerivative } from '../../engine/modes.ts';
import { twoCompModes } from '../../engine/models2c.ts';
import { threeCompModes } from '../../engine/models3c.ts';
import type { ExpMode, ThreeCompParams, TwoCompParams } from '../../engine/types.ts';

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
 * Invert the oral Tmax relationship for a MULTI-EXPONENTIAL disposition — find
 * the absorption constant `ka` whose oral curve peaks at `tmax` (canonical h),
 * given the disposition's per-unit-dose modes `g_λ` (fixed by the compartment
 * parameters alone, so independent of `ka`). The two- and three-compartment
 * inversions are this one function over two and three modes.
 *
 * There is no closed form (unlike the one-compartment `kaFromTmax`), but the peak
 * condition `C′(tmax; ka) = 0` is a SINGLE equation in `ka` — no nested inner
 * peak-search. `C′(tmax; ka)` is the sum over the disposition modes of
 * {@link batemanModeDerivative} (with amplitude `ka·g_λ`; the `F·D` scale drops
 * out of the root) and is strictly decreasing in `ka`: a larger `ka` peaks earlier,
 * so at the fixed instant `tmax` the curve is already past its peak (slope < 0),
 * while a smaller `ka` peaks later (slope > 0 at `tmax`). We bracket that sign
 * change and bisect.
 *
 * `name` is the public inverter's, so a thrown message names the function the
 * caller actually called.
 */
function kaFromTmaxModes(tmax: number, unitModes: ExpMode[], name: string): number {
  // Slope of the oral curve at `tmax` for a candidate `ka` (up to the positive
  // F·D scale, which cannot move the root); monotone decreasing in `ka`.
  const slopeAtTmax = (ka: number): number =>
    unitModes.reduce(
      (s, { coef: g, rate }) => s + batemanModeDerivative(ka * g, ka, rate, tmax),
      0,
    );

  // Bracket [lo, hi] so slopeAtTmax(lo) > 0 (ka too small) and slopeAtTmax(hi) < 0
  // (ka too large). Expand outward from a unit seed until both signs hold.
  let lo = 1;
  while (slopeAtTmax(lo) <= 0) {
    lo /= 2;
    if (lo < 1e-12) throw new Error(`${name}: failed to bracket (ka too small)`);
  }
  let hi = lo;
  while (slopeAtTmax(hi) >= 0) {
    hi *= 2;
    if (hi > 1e12) throw new Error(`${name}: failed to bracket (ka too large)`);
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
 * The TWO-COMPARTMENT Tmax inversion: {@link kaFromTmaxModes} over the α/β modes
 * that CL/Vc/Q/Vp fix. The exact inverse of `models2c.ts`'s `oralPeakTime2c`, so a
 * `ka` recovered here round-trips back to `tmax`.
 */
export function kaFromTmax2c(tmax: number, params: TwoCompParams): number {
  if (!(tmax > 0)) throw new Error('kaFromTmax2c: Tmax must be positive');
  return kaFromTmaxModes(tmax, twoCompModes(params, 1), 'kaFromTmax2c');
}

/**
 * The THREE-COMPARTMENT Tmax inversion: {@link kaFromTmaxModes} over the α/β/γ
 * modes that CL/Vc/Q2/Vp2/Q3/Vp3 fix. The exact inverse of `models3c.ts`'s
 * `oralPeakTime3c`, so a `ka` recovered here round-trips back to `tmax`.
 */
export function kaFromTmax3c(tmax: number, params: ThreeCompParams): number {
  if (!(tmax > 0)) throw new Error('kaFromTmax3c: Tmax must be positive');
  return kaFromTmaxModes(tmax, threeCompModes(params, 1), 'kaFromTmax3c');
}
