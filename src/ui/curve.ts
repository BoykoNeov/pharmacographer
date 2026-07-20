/**
 * UI ↔ engine/data glue (handoff §4, §13 Phase 4).
 *
 * The UI is the ONLY layer allowed to import both the data layer (a validated
 * {@link Compound}) and the engine (the pure curve math). This module is that
 * seam, kept out of the React components so it can be reasoned about (and later
 * tested) on its own:
 *
 *   buildCurve:  Compound + route + dose  →  {t, c}[] sampled for the chart,
 *                plus the derived-value notes and warnings the UI must surface.
 *   routeOptions / defaultRoute:  which routes the engine can actually plot for a
 *                given compound, and a sensible default to select.
 *
 * No React here — this is plain TypeScript that the components consume.
 */

import { concentrationCurve, recurringDoses } from '../engine/dosing.ts';
import {
  infusionMetaboliteConcentrationCurve,
  metabolite2cConcentrationCurve,
  metabolite3cConcentrationCurve,
  metaboliteConcentrationCurve,
  oralMetaboliteConcentrationCurve,
} from '../engine/metabolite.ts';
import { FLIP_FLOP_REL_TOL } from '../engine/models.ts';
import {
  apparentHalfLifeMM,
  firstOrderLimitRateMM,
  ivBolusElapsedTime,
  michaelisMentenCurve,
  type MichaelisMentenParams,
} from '../engine/modelsMM.ts';
import { concentrationCurve2c, oralPeakTime2c, twoCompModes, twoCompRates } from '../engine/models2c.ts';
import {
  concentrationCurve3c,
  oralPeakTime3c,
  threeCompModes,
  threeCompRates,
} from '../engine/models3c.ts';
import type { DoseEvent, PkParams, Route, ThreeCompParams, TwoCompParams } from '../engine/types.ts';
import { REFERENCE_WEIGHT_KG, concentration, time } from '../engine/units.ts';
import {
  deriveMetaboliteDisposition,
  deriveParams,
  deriveParams2c,
  deriveParams3c,
  deriveParamsMM,
  engineRouteOf,
  resolveTransdermalInput,
  type DeriveWarning,
  type DerivedNote,
} from '../data/derive.ts';
import type { Compound, DataRoute } from '../data/schema.ts';

/**
 * Routes the picker offers, in presentation order. These are CLINICAL routes
 * ({@link DataRoute}), which is a wider vocabulary than the engine's input types:
 * `transdermal` resolves onto the engine's zero-order `iv_infusion` via
 * `engineRouteOf`, so the engine never learns what a patch is (handoff §4, §12).
 */
export const ENGINE_ROUTES: readonly DataRoute[] = ['oral', 'iv_bolus', 'iv_infusion', 'transdermal'];

/** Human-facing route names. */
export const ROUTE_LABELS: Record<DataRoute, string> = {
  oral: 'Oral',
  iv_bolus: 'IV bolus',
  iv_infusion: 'IV infusion',
  transdermal: 'Transdermal patch',
};

/**
 * Default infusion duration (h) for the `iv_infusion` route — ~15 minutes, a
 * realistic short clinical infusion. The duration is a DOSING input, not a
 * compound property, so it lives here, not in the data files (handoff §7).
 */
export const DEFAULT_INFUSION_DURATION_H = 0.25;

/**
 * Dose (mg) the chart opens at when a compound declares no scale of its own.
 * Like {@link DEFAULT_INFUSION_DURATION_H} this is a DOSING input rather than a
 * compound property, so it lives here and not in the data files (handoff §7) —
 * but unlike an infusion duration, "500 mg" is not equally sensible for every
 * molecule, which is why a compound may override it (`illustrativeDoseMg`).
 */
export const DEFAULT_DOSE_MG = 500;

/** Number of sample points across the time grid (chart resolution). */
const DEFAULT_SAMPLES = 300;

/** A route as offered in the UI, with whether the engine can plot it. */
export interface RouteOption {
  route: DataRoute;
  label: string;
  /**
   * The engine can produce a curve for this route from the compound's data.
   * IV routes need only disposition (always present); `oral` additionally needs
   * an absorption constant (ka) or a Tmax to derive one from.
   */
  derivable: boolean;
  /**
   * The compound marks this route as having route-specific data. A derivable but
   * not-available route still plots, but the curve is inferred from disposition
   * only (handoff §1, §10) — the UI flags that.
   */
  available: boolean;
  /** If not derivable, why — for a disabled-option title. */
  reason?: string;
}

/** Whether `compound`'s oral route carries enough to derive absorption. */
function hasOralAbsorption(compound: Compound): boolean {
  const oral = compound.routes.oral;
  if (!oral) return false;
  return (oral.ka?.value ?? null) !== null || (oral.tmax?.value ?? null) !== null;
}

/** The route options for a compound, in {@link ENGINE_ROUTES} order. */
export function routeOptions(compound: Compound): RouteOption[] {
  return ENGINE_ROUTES.map((route) => {
    const label = ROUTE_LABELS[route];
    if (route === 'oral') {
      const derivable = hasOralAbsorption(compound);
      return {
        route,
        label,
        derivable,
        available: compound.routes.oral?.available ?? false,
        reason: derivable ? undefined : 'No absorption data (ka or Tmax) in this compound file',
      };
    }
    if (route === 'transdermal') {
      // Unlike the IV routes, a patch is NOT derivable from disposition alone: its
      // whole input is the product's delivery rate and wear period, which only a
      // compound carrying a `transdermal` block has. Without this, every compound
      // would offer a patch it has no data for.
      const derivable = resolveTransdermalInput(compound) !== undefined;
      return {
        route,
        label,
        derivable,
        available: compound.routes.transdermal?.available ?? false,
        reason: derivable ? undefined : 'No transdermal product data (delivery rate and wear duration) in this compound file',
      };
    }
    // IV routes only need disposition (Vd + ke), which every compound has.
    return { route, label, derivable: true, available: compound.routes[route]?.available ?? false };
  });
}

/**
 * A sensible route to select when a compound is first shown: the first route
 * that is both derivable and marked available; failing that, the first derivable
 * one (every compound has at least `iv_bolus`). Used to reset the route when the
 * user switches compounds so a stale, non-derivable route never sticks.
 */
export function defaultRoute(compound: Compound): DataRoute {
  const options = routeOptions(compound);
  const preferred = options.find((o) => o.derivable && o.available) ?? options.find((o) => o.derivable);
  return preferred?.route ?? 'iv_bolus';
}

/** A single sampled point on the concentration-time curve. */
export interface CurvePoint {
  /** Time, h. */
  t: number;
  /** Concentration, mg/L. */
  c: number;
}

/**
 * Analytic time-to-peak (h) of a SINGLE oral dose — the Bateman peak, where the
 * absorption and elimination exponentials balance:
 *
 *   Tmax = ln(ka / ke) / (ka − ke)
 *
 * This is the forward of `derive.ts`'s `kaFromTmax`, so for a compound whose ka
 * was inverted from a reported Tmax it round-trips to that Tmax. As `ka → ke`
 * the expression is 0/0; the analytic limit is `1/ke` (same flip-flop guard the
 * engine's oral model uses). Used to sample the exact oral peak instant so the
 * marked Cmax/Tmax lands on the true peak instead of the nearest grid point.
 */
function oralPeakTime(ka: number, ke: number): number {
  if (Math.abs(ka - ke) <= FLIP_FLOP_REL_TOL * Math.max(ka, ke)) return 1 / ke;
  return Math.log(ka / ke) / (ka - ke);
}

/**
 * The maximum-concentration point of a sampled curve — the model's predicted
 * Cmax (mg/L) and Tmax (h). Argmax over the grid; exact for IV bolus (peak at
 * the dose instant), infusion (peak at end-of-infusion) and a single oral dose
 * because {@link criticalTimes} samples each of those instants precisely. For a
 * multi-dose oral schedule the true peak has no closed form, so this is the
 * grid's best sample (still pinned near each dose's single-dose peak). Empty or
 * all-zero curves yield the first point (t = 0, c = 0).
 */
function findPeak(points: CurvePoint[]): CurvePoint {
  let peak = points[0] ?? { t: 0, c: 0 };
  for (const p of points) {
    if (p.c > peak.c) peak = p;
  }
  return peak;
}

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
 * to the compound's nominals (see {@link buildCurve}, where that trade is made
 * and why). The difference from a merged envelope is real but is one of agency,
 * not of arithmetic: the app never draws a doubly-extreme edge on its own, and
 * the second extreme is one the reader chose and can see selected on a slider —
 * where a merged envelope would present it, unbidden, as the compound's reported
 * spread.
 */
export type VariabilityAxis = 'half_life' | 'vd';

/** Presentation order and short names for the axes the UI offers. */
export const VARIABILITY_AXES: readonly VariabilityAxis[] = ['half_life', 'vd'];

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
 * {@link criticalTimes} pins and force each band edge to carry its own grid
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

/**
 * Scale a derived `ke` to a target half-life, holding everything else fixed.
 * Expressed as a ratio around the nominal (`ke × nominal/target`) rather than
 * `ln2/target` so that selecting the nominal half-life reproduces the compound's
 * default `ke` EXACTLY — even when that `ke` came from clearance (CL/Vd) rather
 * than from the half-life. Longer target ⇒ smaller `ke` ⇒ slower elimination.
 */
function scaleKe(baseKe: number, nominalHalfLifeH: number, targetHalfLifeH: number): number {
  return baseKe * (nominalHalfLifeH / targetHalfLifeH);
}

/**
 * A metabolite's plotted curve (handoff §12; metabolites spike). One line per
 * metabolite formed from the parent, with its own peak and provenance. Present for an
 * IV-bolus, oral, or IV-infusion parent (any compartment count) that declares metabolites.
 */
export interface MetaboliteCurve {
  /** Stable id (metabolite file key). */
  id: string;
  /** Human-facing name for the line and legend. */
  name: string;
  /** Whether the metabolite is pharmacologically active (a display hint). */
  active: boolean;
  /** Sampled metabolite concentration-time curve, mg/L vs h (shares the parent grid). */
  points: CurvePoint[];
  /** The metabolite's model-predicted peak (grid-sampled — not pinned like the parent's). */
  peak: CurvePoint;
  /** Values the metabolite derivation computed rather than read. */
  derived: DerivedNote[];
  /** Cautions surfaced for the metabolite (Vd scaling, implausible fraction, …). */
  warnings: DeriveWarning[];
}

/**
 * The em-dash suffix that labels a metabolite by its pharmacological status —
 * the SINGLE source of truth shared by the chart legend and the provenance panel
 * so the two wordings can never drift (they were previously duplicated string
 * literals). Returns the tag alone (no name, no leading space); callers prepend
 * the metabolite name.
 */
export function metaboliteTag(active: boolean): string {
  return active ? '— active metabolite' : '— metabolite';
}

/** Fields common to every chart result, whatever the disposition model. */
interface CurveResultBase {
  /** Sampled concentration-time curve, mg/L vs h. */
  points: CurvePoint[];
  /**
   * The peak of the main curve — model-predicted Cmax (mg/L) at Tmax (h). For a
   * single dose this is the textbook Cmax/Tmax; for a recurring schedule it is
   * the highest point of the whole plotted course (the last-dose accumulation
   * peak), not a steady-state value.
   */
  peak: CurvePoint;
  /**
   * One envelope per varied parameter that reports a range (one-compartment
   * only), each fixed at that parameter's reported extremes and independent of
   * the sliders. Never merged — see {@link VariabilityAxis}. Which of them are
   * DRAWN is a display choice the chart owns; they are all computed because the
   * cost is one engine pass each and the alternative is threading visibility
   * state down into the math layer.
   */
  bands?: VariabilityBand[];
  /**
   * Metabolite curves, one per declared metabolite. Present for an IV-bolus, oral, or
   * IV-infusion parent (any compartment count) that declares metabolites; `undefined`
   * otherwise. The infusion metabolite is the convolution of the zero-order input
   * window with the unit-bolus Bateman response (engine `infusionMetaboliteConcentration*`).
   */
  metabolites?: MetaboliteCurve[];
  /** Values the derivation computed rather than read (handoff §8). */
  derived: DerivedNote[];
  /** Cautions to surface alongside the curve (inferred route, assumed F, …). */
  warnings: DeriveWarning[];
  /** Right edge of the time axis, h. */
  horizonH: number;
}

/** A one-compartment chart result (the v1 model). */
export interface OneCompartmentCurveResult extends CurveResultBase {
  model: 'one_compartment_first_order';
  /** The resolved engine parameters that produced the (main) curve. */
  params: PkParams;
  /** The half-life range its band spans, for the slider's bounds. */
  halfLifeRange?: HalfLifeRange;
  /** The Vd range its band spans, for the slider's bounds. */
  vdRange?: VdRange;
  /** Elimination half-life, h (ln2 / ke) of the main curve — for the caption. */
  halfLifeH: number;
}

/** A two-compartment chart result (handoff §12). */
export interface TwoCompartmentCurveResult extends CurveResultBase {
  model: 'two_compartment_first_order';
  /** The resolved 2-comp engine parameters that produced the curve. */
  params: TwoCompParams;
  /** Distribution half-life, h (ln2 / α) — the fast early phase. */
  distributionHalfLifeH: number;
  /** Terminal half-life, h (ln2 / β) — the slow late phase, for the caption. */
  terminalHalfLifeH: number;
}

/** A three-compartment chart result (handoff §12, Stage B). */
export interface ThreeCompartmentCurveResult extends CurveResultBase {
  model: 'three_compartment_first_order';
  /** The resolved 3-comp engine parameters that produced the curve. */
  params: ThreeCompParams;
  /** Distribution half-life, h (ln2 / α) — the fastest early phase. */
  distributionHalfLifeH: number;
  /** Intermediate half-life, h (ln2 / β) — the middle phase. */
  intermediateHalfLifeH: number;
  /** Terminal half-life, h (ln2 / γ) — the slow late phase, for the caption. */
  terminalHalfLifeH: number;
}

/**
 * A Michaelis–Menten (nonlinear) chart result (handoff §12; the nonlinear seam).
 *
 * Every other member of {@link CurveResult} reports a half-life, because for a
 * linear drug that is a constant of the molecule. This one deliberately cannot,
 * and the fields that replace it ARE the teaching payload — a saturable drug's
 * half-life depends on how much drug is present, so the honest UI shows a range
 * and where on it this curve sits, not a number.
 */
export interface MichaelisMentenCurveResult extends CurveResultBase {
  model: 'one_compartment_michaelis_menten';
  /** The resolved MM engine parameters that produced the curve. */
  params: MichaelisMentenParams;
  /**
   * Apparent half-life AT the curve's peak concentration, h — the slowest the
   * plotted course gets. For phenytoin at a therapeutic level this runs roughly
   * twice its own low-concentration value.
   */
  apparentHalfLifeAtPeakH: number;
  /**
   * Apparent half-life as concentration approaches zero, h — `ln2·Vd·Km/Vmax`.
   * The FLOOR: the drug's behaviour once it is dilute enough to stop saturating
   * anything, i.e. the half-life it would have if it were an ordinary linear
   * drug. The gap between this and {@link apparentHalfLifeAtPeakH} is the whole
   * nonlinearity, expressed in the units a reader already understands.
   */
  limitHalfLifeH: number;
  /**
   * Fraction of Vmax the elimination machinery is running at when the curve
   * peaks, in [0, 1) — `Cmax/(Km + Cmax)`. This is the plainest statement of how
   * saturated the drug is at the dose plotted: near 0 it is behaving linearly, and
   * near 1 the enzymes are flat out and the decline is a straight line.
   */
  saturationAtPeak: number;
}

/**
 * Everything the chart area needs for one parameter set. A discriminated union on
 * `model`: the UI narrows on it to read the model-specific fields (1-comp `ke`/
 * `halfLifeH`, 2-comp α/β half-lives, 3-comp α/β/γ half-lives, and the
 * Michaelis–Menten pair of dose-dependent half-lives). Shared fields (points,
 * peak, band, metabolites, warnings, horizon) are on the base so the chart
 * consumes any of them.
 */
export type CurveResult =
  | OneCompartmentCurveResult
  | TwoCompartmentCurveResult
  | ThreeCompartmentCurveResult
  | MichaelisMentenCurveResult;

/**
 * A dosing schedule as the UI expresses it: a regular course of `count` doses of
 * `amount` mg every `interval` h, plus any {@link DoseEvent} ad-hoc extra doses.
 * A single dose is just `count: 1`. {@link buildSchedule} flattens this to the
 * `DoseEvent[]` the engine's superposition consumes (handoff §7, §13 Phase 6).
 */
export interface DoseSchedule {
  /** Amount of each regular dose, mg. */
  amount: number;
  /** Number of regular doses; integer ≥ 0. Single dose = 1. */
  count: number;
  /** Interval τ between regular doses, h. Used only when `count` > 1. */
  interval: number;
  /** Extra one-off doses on top of the regular course. */
  adHoc: DoseEvent[];
}

/**
 * Flatten a {@link DoseSchedule} to the `DoseEvent[]` the engine consumes: the
 * regular course (via the engine's {@link recurringDoses}) followed by the
 * ad-hoc doses. Superposition treats any `DoseEvent[]` uniformly, so order does
 * not matter. Throws (via `recurringDoses`) if `count` > 1 with `interval` ≤ 0 —
 * the editor guards against this, and `buildCurve`'s caller catches it.
 */
export function buildSchedule({ amount, count, interval, adHoc }: DoseSchedule): DoseEvent[] {
  const regular = recurringDoses({ amount, count, interval });
  return [...regular, ...adHoc];
}

/** Inputs to {@link buildCurve}. */
export interface CurveInput {
  compound: Compound;
  route: DataRoute;
  /** The dosing schedule (single = `count: 1`). */
  schedule: DoseSchedule;
  /**
   * Infusion duration, h — used only for `iv_infusion`. NOT used for
   * `transdermal`: a patch's zero-order window is its wear period, which is a
   * property of the product (data), not a clinical choice (a UI input).
   */
  infusionDuration?: number;
  /**
   * Main-curve half-life override, h — the half-life variability slider. When set,
   * `ke` is scaled to this half-life (via {@link scaleKe}); unset, the compound's
   * derived `ke` is used. Does NOT move any band, which stay at the reported
   * extremes.
   */
  halfLifeH?: number;
  /**
   * Main-curve volume-of-distribution override, L — the Vd variability slider.
   * Unset, the compound's derived Vd is used.
   *
   * `ke` (and therefore the half-life) is held FIXED as this moves, which makes
   * clearance co-vary: `CL = ke·Vd`. That choice is what keeps the two axes
   * visually orthogonal — the half-life slider tilts the tail at a fixed peak,
   * this one raises or lowers the peak at a fixed slope — so a reader can
   * attribute the movement to a parameter. The alternative (hold CL fixed) would
   * push `ke = CL/Vd` around and re-say what the half-life slider already says.
   * The on-screen copy states which is held constant; leaving it implicit would
   * make the curve ambiguous rather than merely under-explained.
   */
  vdL?: number;
  /** Reference-subject weight, kg, for scaling per-kg Vd (defaults to 70 kg). */
  weightKg?: number;
  /** Grid resolution; defaults to {@link DEFAULT_SAMPLES}. */
  samples?: number;
}

/** Round up to a "nice" axis bound: 1, 2, 5 × 10ⁿ. */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(x)));
  const normalized = x / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/**
 * Pick a time horizon (h) that shows the whole story: the last dose plus a tail
 * of ~5 elimination half-lives (the curve has decayed to ~3% by then), extended
 * for oral so the absorption phase plays out and for an infusion so it covers
 * the infusion plus its decay. `lastDoseTime` shifts the tail to the end of the
 * course so a recurring schedule isn't clipped mid-decay.
 */
function curveHorizon(route: Route, params: PkParams, lastDoseTime: number): number {
  const halfLife = Math.LN2 / params.ke;
  let tail = 5 * halfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    // Oral: the terminal decline is governed by the SLOWER of absorption (ka) and
    // elimination (ke) — normally ke, but in flip-flop kinetics (ka < ke) absorption
    // is rate-limiting and the tail decays at ka (a LONGER half-life). Size the
    // 5-half-life tail on the slower rate and add ~3 half-lives of the faster
    // (transient) rate for the other phase. Reduces EXACTLY to the previous
    // `5·ln2/ke + 3·ln2/ka` when ka > ke, so no normal compound's horizon moves.
    // (`params.ke` is already the slowest ke in view, so this also keeps a slow
    // metabolite in the running for the terminal rate.)
    const terminalRate = Math.min(params.ka, params.ke);
    const transientRate = Math.max(params.ka, params.ke);
    tail = 5 * (Math.LN2 / terminalRate) + 3 * (Math.LN2 / transientRate);
  }
  if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + 5 * halfLife);
  }
  return niceCeil(lastDoseTime + tail);
}

/** A uniform grid of `samples + 1` times from 0 to `horizonH` inclusive. */
function sampleGrid(horizonH: number, samples: number): number[] {
  return Array.from({ length: samples + 1 }, (_, i) => (i / samples) * horizonH);
}

/**
 * Where a nonlinear curve's tail is considered spent: 2% of the peak. The linear
 * horizon uses "5 half-lives" (≈3% remaining) for the same purpose, but a
 * saturable drug HAS no half-life to count, so the threshold has to be stated as
 * a concentration and inverted through the implicit solution instead.
 */
const MM_TAIL_FRACTION = 0.02;

/**
 * Time (h) for a saturable drug to fall from `fromC` to {@link MM_TAIL_FRACTION}
 * of it, exactly, via the IV-bolus implicit solution. Expanding it shows why a
 * nonlinear horizon cannot be a constant:
 *
 *   t = (Vd/Vmax)·(Km·ln(50) + 0.98·fromC)
 *
 * The first term is fixed (the first-order tail, which no drug ever fully
 * escapes) but the second grows LINEARLY with the concentration reached — so
 * doubling the dose of a saturated drug adds a fixed slab of time rather than one
 * half-life. That term is where "twice the drink, twice the wait" comes from.
 */
function decayTimeMM(params: MichaelisMentenParams, fromC: number): number {
  if (!(fromC > 0)) return 0;
  return ivBolusElapsedTime(params, fromC, fromC * MM_TAIL_FRACTION);
}

/**
 * Pick a time horizon (h) for a nonlinear curve: the last dose plus the time to
 * decay from `peakC` to a spent tail, extended for oral so absorption plays out
 * and for an infusion so it covers the infusion itself.
 *
 * The linear {@link curveHorizon} reads its tail straight off `ke`, because a
 * half-life does not care how much drug there is. Here it does — the tail is a
 * function of the concentration actually reached, which is why this takes `peakC`
 * as an argument and why {@link buildCurveMM} has to size the grid in two passes.
 */
function curveHorizonMM(
  route: Route,
  params: MichaelisMentenParams,
  lastDoseTime: number,
  peakC: number,
): number {
  let tail = decayTimeMM(params, peakC);
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    tail += 3 * (Math.LN2 / params.ka);
  }
  if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + decayTimeMM(params, peakC));
  }
  return niceCeilFine(lastDoseTime + tail);
}

/**
 * Round a NONLINEAR horizon up to a readable axis bound, on a finer ladder than
 * {@link niceCeil}'s 1 / 2 / 5 / 10.
 *
 * The coarse ladder is right for a linear curve, whose tail is a heuristic ("5
 * half-lives") and whose exponential keeps decaying visibly however far the axis
 * runs — spare axis there costs nothing and rounds to a friendlier number. A
 * nonlinear decay time is not a heuristic: {@link decayTimeMM} computes it exactly
 * from the implicit solution, so rounding (say) 5.07 h up to 10 h discards
 * precision we actually have and spends half the axis on a tail that is already
 * spent.
 *
 * The SEMI-LOG view is what makes that unacceptable rather than untidy. On the
 * linear axis a spent tail is a flat line hugging zero; on a log axis those same
 * hours are several empty decades, because a saturable drug below its Km reverts
 * to first-order at `Vmax/(Vd·Km)` and free-falls (ethanol's dilute-limit
 * half-life is ~7 minutes). Decades of nothing compress the part that teaches —
 * the flat, saturated plateau and the knee where it ends — into a sliver. The
 * lin/semi-log toggle is pedagogy, not polish (CLAUDE.md), so the horizon owes it
 * a tight bound.
 */
function niceCeilFine(x: number): number {
  if (!(x > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(x)));
  const normalized = x / magnitude;
  const stops = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (stops.find((stop) => normalized <= stop) ?? 10) * magnitude;
}

/**
 * {@link criticalTimes} for a nonlinear curve: the dose instants (and the hair
 * before each, so an IV-bolus jump draws vertical) plus each infusion's end.
 *
 * There is deliberately no oral-peak mark. The linear version pins the Bateman
 * peak exactly because `Tmax = ln(ka/ke)/(ka − ke)` is a closed form; under
 * saturation no such expression exists — there is no `ke`, and the peak moves
 * with dose — so an oral MM Cmax/Tmax is the grid's best sample, exactly as it
 * already is for a multi-dose oral schedule in the linear path.
 */
function criticalTimesMM(
  route: Route,
  params: MichaelisMentenParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const jumpEps = horizonH * 1e-5;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (route === 'iv_bolus') {
      if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    }
    marks.push(dose.time);
    if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
  }
  return marks;
}

/**
 * Build the chart-ready curve for a Michaelis–Menten compound (handoff §12).
 *
 * Structurally simpler than the linear builders in one way and harder in another.
 * Simpler: there is no variability band and no `ke` scaling, because there is no
 * half-life to vary — {@link halfLifeRangeH} returns null for these compounds, and
 * the slider has nothing to move. Harder: the whole schedule must be integrated at
 * once (`michaelisMentenCurve`, not `concentrationCurve`), since the doses
 * interact, and the horizon depends on the peak the curve reaches — which is only
 * known after building it.
 *
 * Hence TWO passes. The first bounds the tail using the largest single dose's
 * ceiling `F·D/Vd`, which is what that dose would reach with nothing else on
 * board. That underestimates a course whose doses accumulate — precisely the case
 * these compounds exist to show — so the curve is rebuilt on a horizon sized from
 * the concentration the probe actually reaches after the last dose. The cost is one
 * extra integration; the alternative is a phenytoin schedule clipped mid-decline.
 */
function buildCurveMM(input: CurveInput): MichaelisMentenCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // No shipped MM compound offers a patch, but the vocabularies still have to
  // meet here: the integrator, like every engine path, speaks input types.
  const engineRoute = engineRouteOf(route);
  const { params: base, derived, warnings } = deriveParamsMM(compound, route, { weightKg });

  let params = base;
  if (engineRoute === 'iv_infusion') {
    const requested = input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    params = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  const build = (horizonH: number): CurvePoint[] => {
    const times = mergeGrid(
      sampleGrid(horizonH, samples),
      criticalTimesMM(engineRoute, params, doses, horizonH),
    );
    const values = michaelisMentenCurve(engineRoute, params, doses, times);
    return times.map((t, i) => ({ t, c: values[i] ?? 0 }));
  };

  // Pass 1 — a provisional horizon from the largest single dose's ceiling.
  const bioavailable = engineRoute === 'oral' ? (params.F ?? 1) : 1;
  const largestDose = doses.reduce((most, dose) => Math.max(most, dose.amount), 0);
  const provisionalPeak = (bioavailable * largestDose) / params.vd;
  const probe = build(curveHorizonMM(engineRoute, params, lastDoseTime, provisionalPeak));

  // Pass 2 — re-size from what the course actually leaves behind. The tail has to
  // clear the highest concentration reached AT OR AFTER the last dose; anything
  // earlier has already decayed and does not govern the right edge.
  //
  // This deliberately TRUSTS the measured peak rather than taking `max(measured,
  // provisional)`. The provisional ceiling `F·D/Vd` is what a dose would reach with
  // nothing eliminated during input — real for an IV bolus, but an overestimate for
  // an oral dose (ethanol absorbs over hours and is being cleared throughout, so it
  // peaks at ~455 mg/L against a 782 mg/L ceiling) and for an infusion. Keeping the
  // max would size every horizon off a concentration the curve never reaches, which
  // is exactly the second pass being cancelled out. Fall back only if the probe
  // found nothing at all (an empty schedule).
  const tailPeak = probe.reduce((most, p) => (p.t >= lastDoseTime && p.c > most ? p.c : most), 0);
  const horizonH = curveHorizonMM(
    engineRoute,
    params,
    lastDoseTime,
    tailPeak > 0 ? tailPeak : provisionalPeak,
  );
  const points = build(horizonH);
  const peak = findPeak(points);

  return {
    model: 'one_compartment_michaelis_menten',
    params,
    points,
    peak,
    derived,
    warnings,
    horizonH,
    apparentHalfLifeAtPeakH: apparentHalfLifeMM(params, peak.c),
    limitHalfLifeH: Math.LN2 / firstOrderLimitRateMM(params),
    saturationAtPeak: peak.c / (params.km + peak.c),
  };
}

/**
 * Times that MUST be sampled exactly, on top of the uniform grid. An IV-bolus
 * concentration JUMPS at each dose instant, so the true peak lives exactly at
 * `t = dose.time`; a uniform grid that misses it renders whatever the nearest
 * sample decayed to, which aliases the peak height and makes the auto axis
 * flicker as the schedule shifts under the grid (the "add 1 h, peak changes"
 * bug). For each dose we sample:
 *   - `dose.time` itself — pins the exact peak;
 *   - a hair before it (`dose.time − ε`) — so the jump draws vertical instead of
 *     as a diagonal ramp up from the previous uniform sample;
 *   - for an infusion, `dose.time + infusionDuration` — the slope break at the
 *     end of the infusion;
 *   - for oral, `dose.time + oralPeakTime(ka, ke)` — the smooth Bateman peak of
 *     that single dose. Its concentration IS continuous, but the uniform grid
 *     can straddle it, so the marked Cmax/Tmax would otherwise land a fraction
 *     of an hour off — visible against the Tmax the provenance panel reports.
 */
function criticalTimes(route: Route, params: PkParams, doses: DoseEvent[], horizonH: number): number[] {
  // Small enough to look vertical, large enough to stay well clear of the
  // dedupe threshold (so the pre-dose point is never merged into the dose time).
  const jumpEps = horizonH * 1e-5;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    marks.push(dose.time);
    if (route === 'iv_infusion' && params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
    if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
      const peakT = dose.time + oralPeakTime(params.ka, params.ke);
      if (peakT <= horizonH) marks.push(peakT);
    }
  }
  return marks;
}

/**
 * Merge the uniform grid with the {@link criticalTimes} marks into one ascending,
 * de-duplicated grid. Recharts draws points in array order, so the result MUST be
 * sorted (an unsorted merge zigzags the line) and free of duplicate x (a dose
 * time landing on a uniform point). The dedupe threshold only removes true
 * coincidences — it is far below `jumpEps`, so a pre-dose mark is always kept.
 */
function mergeGrid(uniform: number[], marks: number[]): number[] {
  const all = [...uniform, ...marks].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) {
    if (out.length === 0 || t - out[out.length - 1]! > 1e-9) out.push(t);
  }
  return out;
}

/**
 * Build the chart-ready curve for a dosing schedule. Derives the engine
 * parameters from the compound (throwing, via `deriveParams`, if the compound is
 * nonlinear or the oral route lacks absorption data — the caller catches and
 * shows the message), injects the infusion duration for `iv_infusion`, sizes the
 * time grid to cover the last dose plus its decay, and evaluates the
 * superposition engine over the whole schedule.
 */
export function buildCurve(input: CurveInput): CurveResult {
  // Dispatch on the compound's disposition model. Two-compartment compounds go
  // through the parallel 2-comp path (α/β modes, distribution-phase densification);
  // everything below is the one-compartment model.
  if (input.compound.model === 'two_compartment_first_order') {
    return buildCurve2c(input);
  }
  if (input.compound.model === 'three_compartment_first_order') {
    return buildCurve3c(input);
  }
  if (input.compound.model === 'one_compartment_michaelis_menten') {
    return buildCurveMM(input);
  }

  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // The engine speaks input types, not clinical routes: a patch IS a zero-order
  // input, so it rides the `iv_infusion` path from here down (handoff §12).
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams(compound, route, { weightKg });

  // Disposition + injected infusion duration, shared by the main line and band.
  // Spread (don't mutate) so a memoized `base` stays a faithful cache entry.
  let disposition = base;
  if (engineRoute === 'iv_infusion') {
    // A patch's window is its WEAR PERIOD, read from the product data; an IV
    // infusion's is the user's, from the controls.
    const requested = patch ? patch.wearDurationH : input.infusionDuration;
    const infusionDuration = requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  // Reference half-life for ke scaling: the reported nominal when there is a
  // range (keeps the band centred), else ln2/ke (identity — no scaling).
  const range = halfLifeRangeH(compound);
  const nominalHalfLifeH = range?.nominal ?? Math.LN2 / base.ke;

  // Main line: slider override (if any), scaled around the derived ke.
  const selectedHalfLifeH = input.halfLifeH !== undefined && input.halfLifeH > 0 ? input.halfLifeH : nominalHalfLifeH;
  const mainKe = scaleKe(base.ke, nominalHalfLifeH, selectedHalfLifeH);

  // Vd is varied with ke held fixed (see CurveInput.vdL): a pure vertical
  // rescale, because every 1-comp mode coefficient carries 1/Vd. Nothing about
  // TIMING moves, so the horizon, the critical-time marks, and the oral Bateman
  // peak instant below are all untouched by this axis.
  const vdRange = vdRangeL(compound, base.vd);
  const mainVd = input.vdL !== undefined && input.vdL > 0 ? input.vdL : base.vd;
  const params: PkParams = { ...disposition, ke: mainKe, vd: mainVd };

  // Band extremes are FIXED at each parameter's reported low/high (not the
  // sliders): longer half-life ⇒ smaller ke ⇒ slower elimination ⇒ higher
  // exposure; larger Vd ⇒ more dilution ⇒ LOWER exposure (the two axes map onto
  // concentration in opposite directions, which is why the edges are labelled).
  const keSlow = range ? scaleKe(base.ke, nominalHalfLifeH, range.high) : mainKe;
  const keFast = range ? scaleKe(base.ke, nominalHalfLifeH, range.low) : mainKe;

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < parent ke) extends the horizon below and
  // isn't clipped mid-decay. Formation is driven by the parent ke actually plotted
  // (mainKe), so moving the half-life slider moves the metabolite consistently.
  const metaboliteDerivations =
    (engineRoute === 'iv_bolus' || engineRoute === 'oral' || engineRoute === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  // Size the grid on the slowest curve in view (smallest ke) so neither the band's
  // long-half-life tail nor a slow metabolite is clipped mid-decay.
  const slowestKe = Math.min(mainKe, keSlow, ...metaboliteDerivations.map((d) => d.params.keM));
  // A patch's horizon is the wear period EXACTLY — no decay tail, and no rounding
  // up past it. Every other route pads the window with ~5 half-lives so the tail
  // plays out; doing that here would plot the hours AFTER the patch comes off, and
  // that decline is the one part of a patch curve this model gets wrong (drug keeps
  // absorbing from a skin depot, so the real slope is the absorption rate, not ke).
  // Ending the window at patch-off keeps the unfaithful part out of frame rather
  // than drawing it and disclaiming it. See clonidine.json's `displayNote`.
  const horizonH = patch
    ? lastDoseTime + patch.wearDurationH
    : curveHorizon(engineRoute, { ...disposition, ke: slowestKe }, lastDoseTime);
  // Uniform grid for the overall shape, plus the exact dose/infusion instants so
  // discontinuous IV peaks aren't aliased (and the axis doesn't flicker).
  const times = mergeGrid(sampleGrid(horizonH, samples), criticalTimes(engineRoute, params, doses, horizonH));

  const concentrations = concentrationCurve(engineRoute, params, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  // Each band varies ITS OWN axis across the reported range while every other
  // parameter stays where the main line has it. Anchoring to the plotted curve
  // (rather than to the compound's nominals) is what keeps a band an envelope OF
  // the line on screen: a Vd band pinned to the nominal half-life would simply
  // detach from the curve as soon as the half-life slider moved, which reads as a
  // rendering bug and answers a question nobody asked. The cost is that dragging
  // a slider to its own extreme and then reading the other axis's band puts one
  // reported extreme on top of a user-chosen one — but that is a state the reader
  // deliberately steered into, not a combined envelope the app draws unprompted,
  // and at the default (every slider nominal) no edge is doubly extreme.
  const bands: VariabilityBand[] = [];
  const bandPoints = (lowParams: PkParams, highParams: PkParams): BandPoint[] => {
    const low = concentrationCurve(engineRoute, lowParams, doses, times);
    const high = concentrationCurve(engineRoute, highParams, doses, times);
    return times.map((t, i) => ({ t, cLow: low[i] ?? 0, cHigh: high[i] ?? 0 }));
  };
  if (range) {
    bands.push({
      axis: 'half_life',
      lowLabel: `Short t½ ${fmtNum(range.low)} h (fast elim.)`,
      highLabel: `Long t½ ${fmtNum(range.high)} h (slow elim.)`,
      points: bandPoints({ ...params, ke: keFast }, { ...params, ke: keSlow }),
    });
  }
  if (vdRange) {
    // Note the inversion: the LARGE volume gives the LOW concentration.
    bands.push({
      axis: 'vd',
      lowLabel: `Large Vd ${fmtNum(vdRange.high)} L (more dilution)`,
      highLabel: `Small Vd ${fmtNum(vdRange.low)} L (less dilution)`,
      points: bandPoints({ ...params, vd: vdRange.high }, { ...params, vd: vdRange.low }),
    });
  }

  // Evaluate each metabolite over the same grid/schedule as the parent. An IV-bolus
  // parent contributes a plain Bateman metabolite (formation rate = the plotted mainKe);
  // an oral parent's metabolite is driven off the parent's residue-form mode
  // (single 1/Vd mode at mainKe, absorption ka/F), so the slider still reshapes it; an
  // IV-infusion parent's metabolite is the zero-order-input convolution over that same
  // single mode (duration from the injected disposition).
  const metabolites: MetaboliteCurve[] | undefined = metaboliteDerivations.length
    ? metaboliteDerivations.map(({ meta, params: mp, derived: mDerived, warnings: mWarnings }) => {
        const c =
          route === 'oral'
            ? oralMetaboliteConcentrationCurve(
                [{ coef: 1 / params.vd, rate: mainKe }],
                mainKe * params.vd,
                params.ka ?? 0,
                params.F ?? 1,
                mp,
                doses,
                times,
              )
            : route === 'iv_infusion'
              ? infusionMetaboliteConcentrationCurve(
                  [{ coef: 1 / params.vd, rate: mainKe }],
                  mainKe * params.vd,
                  mp,
                  doses,
                  disposition.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
                  times,
                )
              : metaboliteConcentrationCurve({ ...mp, keParent: mainKe }, doses, times);
        const mPoints = times.map((t, i) => ({ t, c: c[i] ?? 0 }));
        return {
          id: meta.id,
          name: meta.name,
          active: meta.active,
          points: mPoints,
          peak: findPeak(mPoints),
          derived: mDerived,
          warnings: mWarnings,
        };
      })
    : undefined;

  const halfLifeH = Math.LN2 / mainKe;
  return {
    model: 'one_compartment_first_order',
    points,
    peak: findPeak(points),
    bands: bands.length > 0 ? bands : undefined,
    halfLifeRange: range ?? undefined,
    vdRange: vdRange ?? undefined,
    metabolites,
    params,
    derived,
    warnings,
    halfLifeH,
    horizonH,
  };
}

// ── Two-compartment glue (handoff §12) ──────────────────────────────────────
// The parallel build path for `two_compartment_first_order` compounds, reached
// via `buildCurve`'s model dispatch. Kept a separate function (not folded into
// the 1-comp body) because its disposition is α/β modes (plus an oral absorption
// mode), not a single ke, and it needs early-phase grid densification. Returns a
// {@link TwoCompartmentCurveResult} so the UI narrows on `model` for the caption.
// (The metabolite `<Line>` rows remain deferred, as with the metabolites spike.)

/**
 * Pick a 2-comp time horizon (h): the last dose plus ~5 TERMINAL (β) half-lives,
 * extended for an infusion to cover the infusion plus its decay, and for oral so
 * the absorption phase (~3 ka half-lives) plays out. Sized on the `slowestRate`
 * (the smallest of β and any metabolite's kₘ) so a long-lived metabolite isn't
 * clipped mid-decay — the 2-comp analogue of {@link curveHorizon}.
 */
function curveHorizon2c(
  route: Route,
  params: TwoCompParams,
  slowestRate: number,
  lastDoseTime: number,
): number {
  const terminalHalfLife = Math.LN2 / slowestRate;
  let tail = 5 * terminalHalfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    // Flip-flop-aware, as in {@link curveHorizon}: the terminal decline follows the
    // SLOWER of absorption (ka) and the terminal disposition rate (`slowestRate` —
    // already the min of β and any metabolite kₘ). In flip-flop (ka < β) the tail
    // decays at ka, so sizing on β alone would clip it. Reduces EXACTLY to the
    // previous `5·ln2/β + 3·ln2/ka` when ka > slowestRate.
    const terminalRate = Math.min(params.ka, slowestRate);
    const transientRate = Math.max(params.ka, slowestRate);
    tail = 5 * (Math.LN2 / terminalRate) + 3 * (Math.LN2 / transientRate);
  }
  if (params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + 5 * terminalHalfLife);
  }
  return niceCeil(lastDoseTime + tail);
}

/**
 * Critical sample times for a 2-comp curve. On top of the {@link criticalTimes}
 * concerns (the IV-bolus jump at each dose, the infusion end, the oral peak), this
 * DENSIFIES the fast early phase: the horizon is sized on the slow terminal β, so
 * a uniform grid gives the α distribution phase — the very feature that motivates
 * 2-comp — only a handful of points and aliases it into a straight line. We add
 * log-spaced marks over the first few half-lives of the FASTEST early rate after
 * each dose (α, or the absorption ka when it is faster still, for oral) so the
 * knee renders truthfully; for oral we also pin the exact Bateman peak instant so
 * the marked Cmax/Tmax lands on the true peak.
 */
function criticalTimes2c(
  route: Route,
  params: TwoCompParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const { alpha } = twoCompRates(params);
  const jumpEps = horizonH * 1e-5;
  // Densify over the fastest early phase — α, or a faster absorption ka (oral).
  const fastRate =
    route === 'oral' && params.ka !== undefined && params.ka > 0 ? Math.max(alpha, params.ka) : alpha;
  const fastHalfLife = Math.LN2 / fastRate;
  const distEnd = Math.min(horizonH, 6 * fastHalfLife);
  const distStart = distEnd * 1e-3;
  const nDist = 40;
  // Geometric offsets spanning the early phase (dense near t = 0).
  const distOffsets = Array.from({ length: nDist + 1 }, (_, i) =>
    distStart * Math.pow(distEnd / distStart, i / nDist),
  );
  const oralPeakOffset =
    route === 'oral' && params.ka !== undefined && params.ka > 0 ? oralPeakTime2c(params) : undefined;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    marks.push(dose.time);
    for (const off of distOffsets) {
      const t = dose.time + off;
      if (t <= horizonH) marks.push(t);
    }
    if (oralPeakOffset !== undefined) {
      const peakT = dose.time + oralPeakOffset;
      if (peakT <= horizonH) marks.push(peakT);
    }
    if (params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
  }
  return marks;
}

/**
 * Build the chart-ready curve for a two-compartment compound (handoff §12). The
 * 2-comp analogue of {@link buildCurve}: derives {@link TwoCompParams} (throwing,
 * via `deriveParams2c`, for a nonlinear compound or an oral route lacking
 * absorption data — the caller catches and shows the message), injects the
 * infusion duration and oral absorption (ka/F), sizes and densifies the grid, and
 * evaluates the 2-comp superposition (IV bolus, IV infusion, or oral). Metabolites
 * (IV-bolus, oral, or IV-infusion parent) are driven off the parent's α/β modes.
 * Variability band/slider are intentionally omitted — varying a single half-life
 * is ill-defined across two eigenvalues (a §12 follow-on, like the 1-comp band).
 */
export function buildCurve2c(input: CurveInput): TwoCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // Routes are model-independent (the mode spine), so a patch on a 2-comp parent
  // needs nothing here but the same clinical→input-type mapping as the 1-comp path.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams2c(compound, route, { weightKg });

  let disposition = base;
  if (engineRoute === 'iv_infusion') {
    const requested = patch ? patch.wearDurationH : input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < β) extends the horizon below.
  const metaboliteDerivations =
    (engineRoute === 'iv_bolus' || engineRoute === 'oral' || engineRoute === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  const { beta } = twoCompRates(disposition);
  const slowestRate = Math.min(beta, ...metaboliteDerivations.map((d) => d.params.keM));
  // Patch horizon = the wear period exactly; see buildCurve for why no decay tail.
  const horizonH = patch
    ? lastDoseTime + patch.wearDurationH
    : curveHorizon2c(engineRoute, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes2c(engineRoute, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve2c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites: MetaboliteCurve[] | undefined = metaboliteDerivations.length
    ? metaboliteDerivations.map(({ meta, params: mp, derived: mDerived, warnings: mWarnings }) => {
        const c =
          route === 'oral'
            ? oralMetaboliteConcentrationCurve(
                twoCompModes(disposition, 1),
                disposition.cl,
                disposition.ka ?? 0,
                disposition.F ?? 1,
                mp,
                doses,
                times,
              )
            : route === 'iv_infusion'
              ? infusionMetaboliteConcentrationCurve(
                  twoCompModes(disposition, 1),
                  disposition.cl,
                  mp,
                  doses,
                  disposition.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
                  times,
                )
              : metabolite2cConcentrationCurve(disposition, mp, doses, times);
        const mPoints = times.map((t, i) => ({ t, c: c[i] ?? 0 }));
        return {
          id: meta.id,
          name: meta.name,
          active: meta.active,
          points: mPoints,
          peak: findPeak(mPoints),
          derived: mDerived,
          warnings: mWarnings,
        };
      })
    : undefined;

  const { alpha } = twoCompRates(disposition);
  return {
    model: 'two_compartment_first_order',
    points,
    peak: findPeak(points),
    metabolites,
    params: disposition,
    derived,
    warnings,
    distributionHalfLifeH: Math.LN2 / alpha,
    terminalHalfLifeH: Math.LN2 / beta,
    horizonH,
  };
}

// ── Three-compartment glue (handoff §12, Stage B) ───────────────────────────
// The parallel build path for `three_compartment_first_order` compounds, reached
// via `buildCurve`'s model dispatch. Like the 2-comp path its disposition is a set
// of exponential modes (α, β, γ) rather than a single ke, and it needs early-phase
// grid densification. Covers all three routes (IV bolus, IV infusion, and oral — a
// four-exponential parent whose ka comes from `deriveParams3c`/`kaFromTmax3c`), though
// no shipped 3-comp compound declares an oral Tmax yet, so oral is engine capability
// rather than a live route today. Returns a {@link ThreeCompartmentCurveResult} so the
// UI narrows on `model` for the caption. Metabolites (IV-bolus, oral, or IV-infusion
// parent) are driven off the parent's α/β/γ modes, as in the 2-comp path; the band is
// intentionally omitted (varying one half-life across three eigenvalues is ill-defined).

/**
 * Pick a 3-comp time horizon (h): the last dose plus ~5 TERMINAL (γ) half-lives,
 * extended for an infusion to cover the infusion plus its decay, and for oral so the
 * absorption phase (~3 ka half-lives) plays out. The 3-comp analogue of
 * {@link curveHorizon2c}; sized on the slow terminal γ so the long tail isn't clipped.
 */
function curveHorizon3c(
  route: Route,
  params: ThreeCompParams,
  terminalRate: number,
  lastDoseTime: number,
): number {
  const terminalHalfLife = Math.LN2 / terminalRate;
  let tail = 5 * terminalHalfLife;
  if (route === 'oral' && params.ka !== undefined && params.ka > 0) {
    // Flip-flop-aware, as in {@link curveHorizon}: the terminal decline follows the
    // SLOWER of absorption (ka) and the terminal disposition rate (`terminalRate` —
    // already the min of γ and any metabolite kₘ). In flip-flop (ka < γ) the tail
    // decays at ka, so sizing on γ alone would clip it. Reduces EXACTLY to the
    // previous `5·ln2/γ + 3·ln2/ka` when ka > terminalRate.
    const slowRate = Math.min(params.ka, terminalRate);
    const fastRate = Math.max(params.ka, terminalRate);
    tail = 5 * (Math.LN2 / slowRate) + 3 * (Math.LN2 / fastRate);
  }
  if (params.infusionDuration !== undefined) {
    tail = Math.max(tail, params.infusionDuration + 5 * terminalHalfLife);
  }
  return niceCeil(lastDoseTime + tail);
}

/**
 * Critical sample times for a 3-comp curve. Like {@link criticalTimes2c} it pins the
 * IV-bolus jump at each dose, the infusion end, and (for oral) the exact Bateman peak,
 * and DENSIFIES the fast early phase — the horizon is sized on the slow terminal γ, so
 * without densification the α distribution and β intermediate phases (which span only
 * the first few minutes for a drug like remifentanil) alias into a straight vertical
 * drop. We log-space marks over the first few half-lives of the FASTEST early rate after
 * each dose (α, or the absorption ka when it is faster still, for oral) so both early
 * knees render truthfully; for oral we also pin the exact {@link oralPeakTime3c} instant
 * so the marked Cmax/Tmax lands on the true peak.
 */
function criticalTimes3c(
  route: Route,
  params: ThreeCompParams,
  doses: DoseEvent[],
  horizonH: number,
): number[] {
  const { alpha } = threeCompRates(params);
  const jumpEps = horizonH * 1e-5;
  // Densify over the fastest early phase — α, or a faster absorption ka (oral).
  const fastRate =
    route === 'oral' && params.ka !== undefined && params.ka > 0 ? Math.max(alpha, params.ka) : alpha;
  const fastHalfLife = Math.LN2 / fastRate;
  const distEnd = Math.min(horizonH, 6 * fastHalfLife);
  const distStart = distEnd * 1e-3;
  const nDist = 40;
  const distOffsets = Array.from({ length: nDist + 1 }, (_, i) =>
    distStart * Math.pow(distEnd / distStart, i / nDist),
  );
  const oralPeakOffset =
    route === 'oral' && params.ka !== undefined && params.ka > 0 ? oralPeakTime3c(params) : undefined;
  const marks: number[] = [];
  for (const dose of doses) {
    if (dose.time > horizonH) continue;
    if (dose.time - jumpEps > 0) marks.push(dose.time - jumpEps);
    marks.push(dose.time);
    for (const off of distOffsets) {
      const t = dose.time + off;
      if (t <= horizonH) marks.push(t);
    }
    if (oralPeakOffset !== undefined) {
      const peakT = dose.time + oralPeakOffset;
      if (peakT <= horizonH) marks.push(peakT);
    }
    if (params.infusionDuration !== undefined) {
      const end = dose.time + params.infusionDuration;
      if (end <= horizonH) marks.push(end);
    }
  }
  return marks;
}

/**
 * Build the chart-ready curve for a three-compartment compound (handoff §12,
 * Stage B). The 3-comp analogue of {@link buildCurve2c}: derives {@link ThreeCompParams}
 * (throwing, via `deriveParams3c`, for a nonlinear compound or an oral route lacking
 * absorption data — the caller catches and shows the message), injects the infusion
 * duration and oral absorption (ka/F), sizes and densifies the grid on the α/γ
 * eigenvalues, and evaluates the 3-comp superposition (IV bolus, IV infusion, or oral).
 * Metabolites (IV-bolus, oral, or IV-infusion parent) are driven off the α/β/γ modes.
 * Returns α/β/γ half-lives for the caption.
 */
export function buildCurve3c(input: CurveInput): ThreeCompartmentCurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  // As in the 1-/2-comp paths: the mode spine makes routes model-independent, so a
  // patch costs nothing here beyond mapping the clinical route to its input type.
  const engineRoute = engineRouteOf(route);
  const patch = route === 'transdermal' ? resolveTransdermalInput(compound) : undefined;
  const { params: base, derived, warnings } = deriveParams3c(compound, route, { weightKg });

  let disposition = base;
  if (engineRoute === 'iv_infusion') {
    const requested = patch ? patch.wearDurationH : input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < γ) extends the horizon below.
  const metaboliteDerivations =
    (engineRoute === 'iv_bolus' || engineRoute === 'oral' || engineRoute === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  const { alpha, beta, gamma } = threeCompRates(disposition);
  const slowestRate = Math.min(gamma, ...metaboliteDerivations.map((d) => d.params.keM));
  // Patch horizon = the wear period exactly; see buildCurve for why no decay tail.
  const horizonH = patch
    ? lastDoseTime + patch.wearDurationH
    : curveHorizon3c(engineRoute, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes3c(engineRoute, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve3c(engineRoute, disposition, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  const metabolites: MetaboliteCurve[] | undefined = metaboliteDerivations.length
    ? metaboliteDerivations.map(({ meta, params: mp, derived: mDerived, warnings: mWarnings }) => {
        const c =
          route === 'oral'
            ? oralMetaboliteConcentrationCurve(
                threeCompModes(disposition, 1),
                disposition.cl,
                disposition.ka ?? 0,
                disposition.F ?? 1,
                mp,
                doses,
                times,
              )
            : route === 'iv_infusion'
              ? infusionMetaboliteConcentrationCurve(
                  threeCompModes(disposition, 1),
                  disposition.cl,
                  mp,
                  doses,
                  disposition.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
                  times,
                )
              : metabolite3cConcentrationCurve(disposition, mp, doses, times);
        const mPoints = times.map((t, i) => ({ t, c: c[i] ?? 0 }));
        return {
          id: meta.id,
          name: meta.name,
          active: meta.active,
          points: mPoints,
          peak: findPeak(mPoints),
          derived: mDerived,
          warnings: mWarnings,
        };
      })
    : undefined;

  return {
    model: 'three_compartment_first_order',
    points,
    peak: findPeak(points),
    metabolites,
    params: disposition,
    derived,
    warnings,
    distributionHalfLifeH: Math.LN2 / alpha,
    intermediateHalfLifeH: Math.LN2 / beta,
    terminalHalfLifeH: Math.LN2 / gamma,
    horizonH,
  };
}

/** Format a number to `sig` significant figures, trimming trailing zeros. */
export function fmtNum(x: number, sig = 3): string {
  if (!Number.isFinite(x)) return '—';
  return Number(x.toPrecision(sig)).toString();
}

/**
 * Concentration display units offered by the chart's unit toggle (handoff §15
 * #6). All curve math stays in canonical mg/L; these are display-only. The three
 * chosen units differ by powers of ten (µg/mL ≡ mg/L; ng/mL = mg/L × 1000), a
 * deliberate teaching point — switching mg/L ↔ µg/mL must not move the number.
 */
export const CONCENTRATION_UNITS = ['mg/L', 'µg/mL', 'ng/mL'] as const;
export type ConcentrationDisplayUnit = (typeof CONCENTRATION_UNITS)[number];

/**
 * Convert a canonical mg/L concentration into a chosen display unit. Because
 * every offered unit is a power-of-ten factor, decade ticks generated in mg/L
 * remain decade ticks after conversion — the chart relies on this to keep its
 * semi-log gridlines round in any unit.
 */
export function toDisplayConcentration(mgPerL: number, unit: ConcentrationDisplayUnit): number {
  return concentration.fromCanonical(mgPerL, unit);
}

/** Re-export so the UI labels the reference subject without reaching into engine. */
export { REFERENCE_WEIGHT_KG };
