/**
 * Sensible bounds for the numeric input fields (handoff §9).
 *
 * These are input HYGIENE, not clinical limits — the bright line is elsewhere.
 * They keep the plot legible and the superposition cheap, and stop a stray
 * keystroke (a pasted phone number, a held-down spinner arrow, a fat-fingered
 * extra zero) from producing an absurd axis or an unresponsive tab.
 *
 * The dose COUNT is the one bound that matters for cost: `concentrationCurve`
 * evaluates every dose at every sample, and the sample grid itself grows with
 * the count (each dose contributes exact instants via `criticalTimes`), so the
 * work is ~O(samples × doses). 200 doses (main line + both band curves) is well
 * under a frame, so the cap is comfortable, not tight.
 *
 * `max`/`min` on `<input type="number">` only constrain the spinner and native
 * validation — they do NOT stop a typed or pasted out-of-range value. So each
 * field sets the attributes (for the spinner + validity UI) AND routes its
 * onChange through {@link clampInput}, which is what actually enforces the bound.
 */
export interface Bounds {
  min: number;
  max: number;
}

export const INPUT_LIMITS = {
  /** Single/ad-hoc dose amount, mg. 100 g is an absurd ceiling, safely clear of any real dose. */
  doseMg: { min: 0, max: 100_000 },
  /** Infusion duration, h — a plotted infusion beyond a few days is not illustrative. */
  infusionH: { min: 0, max: 72 },
  /** Recurring interval τ, h — up to weekly dosing. */
  intervalH: { min: 0, max: 168 },
  /** Number of regular doses — the cost-bounding cap (see module note). */
  doseCount: { min: 1, max: 200 },
  /** Ad-hoc dose time, h — past this the early curve is unreadably squished. */
  adHocTimeH: { min: 0, max: 1_000 },
} as const satisfies Record<string, Bounds>;

/**
 * Clamp a parsed numeric input into `bounds`. A non-finite value (empty or
 * garbage field) collapses to `min` — the same 0-fallback the fields used before,
 * generalised. This is the real enforcement; the `max`/`min` attributes are only
 * UI affordances.
 */
export function clampInput(value: number, bounds: Bounds): number {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}
