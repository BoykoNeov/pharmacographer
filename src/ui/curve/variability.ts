/**
 * Per-parameter variability: the axes a reader can vary, the reported ranges each
 * one spans, and the envelopes drawn at their extremes.
 */

import { absorptionRouteOf } from '../../data/derive.ts';
import type { Compound, DataRoute } from '../../data/schema.ts';
import { time } from '../../engine/units.ts';

/** A sampled point of a variability envelope, mg/L at time `t` (h). */
export interface BandPoint {
  t: number;
  /** The LOWER concentration edge — which parameter extreme produces it is per-axis. */
  cLow: number;
  /** The UPPER concentration edge. */
  cHigh: number;
}

/**
 * A parameter whose reported range the UI can explore (handoff §12, "variability
 * beyond half-life"). Each axis is varied ALONE, holding the others at their
 * reported point values.
 *
 * That one-at-a-time rule is the whole design, not a simplification. §12's text
 * says to "combine them" into a single envelope, but the phenotype-preset work
 * that landed afterwards settled the opposite principle: do not manufacture
 * populations nobody observed. The outer edge of a combined envelope is a person
 * at the 5th-percentile volume AND the 95th-percentile half-life — a pairing no
 * source reports, and (because Vd and t½ are correlated through clearance) one
 * that may not be physiologically coherent at all. Presets went to the trouble of
 * making the mixed state UNREACHABLE rather than merely discouraged; a merged
 * band here would quietly rebuild it in the chart.
 *
 * Bands are therefore computed per axis and rendered as separate regions. The
 * user may show several at once and compare which parameter dominates the spread
 * — that is honest, because each region is still individually a real reported
 * range.
 *
 * The exact invariant, which is weaker than "no edge ever combines two extremes"
 * and worth stating precisely because overclaiming it here would be the same
 * category of dishonesty the design exists to avoid: **at the default — every
 * slider at nominal — no band edge combines two extremes.** A combined edge IS
 * reachable, by dragging one axis's slider to its own end and then reading
 * another axis's band, because bands are anchored to the plotted line rather than
 * to the compound's nominals (see `buildCurve1c` in oneCompartment.ts, where that trade is made
 * and why). The difference from a merged envelope is real but is one of agency,
 * not of arithmetic: the app never draws a doubly-extreme edge on its own, and
 * the second extreme is one the reader chose and can see selected on a slider —
 * where a merged envelope would present it, unbidden, as the compound's reported
 * spread.
 *
 * `f` (oral bioavailability) is the axis that breaks the pattern, and its
 * difference is worth stating here rather than discovering on screen. The first
 * two axes are visually ORTHOGONAL — the half-life tilts the tail at a fixed
 * peak, Vd scales the peak at a fixed slope — which is what lets a reader
 * attribute a movement to a parameter. F is not orthogonal to Vd at all: it is
 * COLLINEAR with it, because the parent curve depends on the two only through
 * `F·D/Vd`. Halving F and doubling Vd produce the identical plot, so the F band
 * and the Vd band are the same shape scaled differently.
 *
 * That is not a defect to hide, it is the classical non-identifiability of oral
 * PK — an oral concentration curve identifies only the ratio `V/F` (the
 * "apparent" volume), never V and F separately — and the UI states it.
 *
 * Be careful about what that does and does NOT license, because the tempting
 * short version is wrong. Non-identifiability is a statement about ATTRIBUTION:
 * given a curve, you cannot say whether its height came from absorption or from
 * volume. It is not a statement that F and Vd are the same quantity or that
 * their spreads are the same spread. They are separately measured, they vary
 * between people for unrelated physiological reasons, and a high-F / small-Vd
 * person is entirely coherent — for morphine that corner sits at 1.7× the
 * nominal height, outside either band on its own. So the honest position is that
 * this tool cannot combine them, not that they must not be combined: nothing in
 * the data says how F and Vd covary, so both "add these" and "never add these"
 * would be claims we cannot support. The copy states neither.
 *
 * (Contrast the half-life × Vd pair, where declining to merge rests on something
 * stronger: those two ARE coupled, through clearance, so a merged corner may not
 * describe a physiologically possible person at all. For F × Vd the reason to
 * keep the bands separate is legibility and consistency with the other axes —
 * a weaker argument, and worth not overstating.)
 *
 * The one place the two genuinely diverge is the metabolite lines, and that
 * divergence is the on-screen proof they are different parameters despite the
 * identical parent gesture: metabolite formation is `fm·ke·C·Vd = fm·ke·F·D·e^(−ke·t)`,
 * so the parent Vd CANCELS exactly (the Vd band leaves every metabolite line
 * untouched) while F does not (the F band moves them). Both directions are
 * pinned as oracles in `curve.test.ts`.
 */
export type VariabilityAxis = 'half_life' | 'vd' | 'f';

/** Presentation order and short names for the axes the UI offers. */
export const VARIABILITY_AXES: readonly VariabilityAxis[] = ['half_life', 'vd', 'f'];

/** One axis's envelope: the curve at that parameter's reported extremes. */
export interface VariabilityBand {
  axis: VariabilityAxis;
  /**
   * What the LOW-concentration edge means, in the parameter's own terms. Worth
   * spelling out per axis because the mapping inverts: a long half-life raises
   * concentration, but a large volume LOWERS it — so "low" is the slow-elimination
   * edge on one axis and the large-volume edge on the other. A bare low/high would
   * invite the reader to assume both extremes point the same way.
   */
  lowLabel: string;
  /** What the HIGH-concentration edge means. */
  highLabel: string;
  /** The envelope, index-aligned with the main curve's `points`. */
  points: BandPoint[];
}

/** The band for one axis, if the compound reports that parameter's range. */
export function bandFor(
  bands: VariabilityBand[] | undefined,
  axis: VariabilityAxis,
): VariabilityBand | undefined {
  return bands?.find((b) => b.axis === axis);
}

/** A half-life range in canonical hours, as read from the compound's source. */
export interface HalfLifeRange {
  /** Shortest reported half-life, h. */
  low: number;
  /** Point (nominal) half-life, h — where the slider starts. */
  nominal: number;
  /** Longest reported half-life, h. */
  high: number;
}

/**
 * The compound's reported half-life range in canonical hours, or `null` if the
 * source gives no range (then there is no half-life band to draw). All three
 * values come from the same `disposition.halfLife` field, so the point value
 * always lies within the range (schema-enforced).
 *
 * No longer the only parameter varied — {@link vdRangeL} is the second axis
 * (handoff §12). `F` is a candidate third; `ka` is deliberately NOT, because it
 * moves Tmax, which would invalidate the exact Bateman peak instant
 * the 1-comp `criticalTimes` pins and force each band edge to carry its own grid
 * densification. That is a separate piece of work, not a slider.
 *
 * Always `null` for a Michaelis–Menten compound, which has no `disposition` block
 * to read (handoff §12). That is not a missing feature: the band answers "how
 * much does this drug's half-life vary BETWEEN people?", and for a saturable drug
 * the half-life already varies within one person, by dose, which the slider's
 * fixed low/nominal/high triple cannot express. The nonlinear honesty panel shows
 * the dose-dependent half-life instead.
 */
export function halfLifeRangeH(compound: Compound): HalfLifeRange | null {
  const hl = compound.disposition?.halfLife;
  if (!hl?.range) return null;
  return {
    low: time.toCanonical(hl.range[0], hl.unit),
    nominal: time.toCanonical(hl.value, hl.unit),
    high: time.toCanonical(hl.range[1], hl.unit),
  };
}

/** A volume-of-distribution range in canonical absolute litres. */
export interface VdRange {
  /** Smallest reported Vd, L — the edge that RAISES concentration. */
  low: number;
  /** Point (nominal) Vd, L — where the slider starts. */
  nominal: number;
  /** Largest reported Vd, L — the edge that LOWERS concentration. */
  high: number;
}

/**
 * The compound's reported Vd range in absolute litres, or `null` when the source
 * gives no range. About 30 of the 47 shipped compounds report one, so this is a
 * genuinely populated axis rather than a hook waiting for data.
 *
 * Expressed as RATIOS around the already-derived nominal (`baseVdL`) rather than
 * re-converting the range from source units. That is the same trick {@link scaleKe}
 * uses, and it buys the same two things: the per-kg → absolute scaling (against the
 * illustrative reference subject) is never re-implemented and so cannot drift from
 * `derive.ts`'s, and the nominal reproduces the compound's default Vd EXACTLY —
 * making "every slider at nominal" provably the pre-feature curve rather than a
 * curve that merely looks like it.
 */
export function vdRangeL(compound: Compound, baseVdL: number): VdRange | null {
  const vd = compound.disposition?.vd;
  if (!vd?.range || !(vd.value > 0)) return null;
  return {
    low: baseVdL * (vd.range[0] / vd.value),
    nominal: baseVdL,
    high: baseVdL * (vd.range[1] / vd.value),
  };
}

/** A bioavailable-fraction range, as a fraction in [0, 1]. */
export interface FRange {
  /** Smallest reported F — the edge that LOWERS concentration. */
  low: number;
  /** Point (nominal) F — where the slider starts. */
  nominal: number;
  /** Largest reported F — the edge that RAISES concentration. */
  high: number;
}

/**
 * The compound's reported oral bioavailability range, or `null` when the source
 * gives no range. Ten of the shipped compounds report one.
 *
 * ORAL ONLY, and not by convention: an IV dose is bioavailable by DEFINITION
 * (F = 1, the `definition` sentinel in `schema.ts`), so a slider there would
 * offer to vary a constant. The transdermal schema goes further and refuses to
 * store an `F` at all, because a patch label's delivered rate is already the
 * systemic input — so there is nothing on that route for this axis to read even
 * if it wanted to. Callers gate on the ENGINE route, so `transdermal` (which
 * rides the `iv_infusion` path) is excluded with the IV routes.
 *
 * Ratio-of-nominal for the same reasons as {@link vdRangeL}: the percent →
 * fraction conversion is never re-implemented here, and selecting the nominal
 * reproduces the derived F exactly, so "every slider at nominal" stays provably
 * the pre-feature curve.
 */
export function fRangeOral(compound: Compound, baseF: number, route: DataRoute): FRange | null {
  // Read through `absorptionRouteOf`, NOT `compound.routes.oral`. Reaching for the
  // oral block directly was a live defect this route's audit surfaced: the caller
  // gates on the ENGINE route, so every first-order route arrived here, and ketamine
  // — which has an `im` block and no `oral` one — silently lost its F band entirely
  // while `im.F` carried a perfectly good range. A compound with BOTH blocks would
  // have been worse than a missing band: it would have painted oral's relative spread
  // onto the IM number, and nothing on screen would have said so. Same lesson as
  // `absorptionRouteOf`'s own docstring, one axis later.
  const f = absorptionRouteOf(compound, route)?.F;
  // `F` is an OPTIONAL param, so its `value` may be null even when the field is
  // present — a compound can record a range with no point estimate. That is not a
  // case this axis can serve: without a nominal there is nothing for the ratio
  // form to anchor to, and no defensible place to start the slider.
  const nominal = f?.value;
  if (!f?.range || nominal === null || nominal === undefined || !(nominal > 0)) return null;
  return {
    low: baseF * (f.range[0] / nominal),
    nominal: baseF,
    high: baseF * (f.range[1] / nominal),
  };
}

/**
 * Scale a derived `ke` to a target half-life, holding everything else fixed.
 * Expressed as a ratio around the nominal (`ke × nominal/target`) rather than
 * `ln2/target` so that selecting the nominal half-life reproduces the compound's
 * default `ke` EXACTLY — even when that `ke` came from clearance (CL/Vd) rather
 * than from the half-life. Longer target ⇒ smaller `ke` ⇒ slower elimination.
 */
export function scaleKe(baseKe: number, nominalHalfLifeH: number, targetHalfLifeH: number): number {
  return baseKe * (nominalHalfLifeH / targetHalfLifeH);
}
