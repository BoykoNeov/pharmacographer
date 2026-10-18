/**
 * The shapes that cross from the curve builders to the components: the input a
 * builder takes, and the per-model result the chart narrows on.
 */

import type { DeriveWarning, DerivedNote } from '../../data/derive.ts';
import type { Compound, DataRoute } from '../../data/schema.ts';
import type { MichaelisMentenParams } from '../../engine/modelsMM.ts';
import type { PkParams, ThreeCompParams, TwoCompParams } from '../../engine/types.ts';
import type { DoseSchedule } from './schedule.ts';
import type { FRange, HalfLifeRange, VariabilityBand, VdRange } from './variability.ts';

/** A single sampled point on the concentration-time curve. */
export interface CurvePoint {
  /** Time, h. */
  t: number;
  /** Concentration, mg/L. */
  c: number;
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

/** Fields common to every chart result, whatever the disposition model. */
export interface CurveResultBase {
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

/**
 * Which rate the half-life slider can actually move, on THIS route.
 *
 * The slider's on-screen note used to say, for every compound alike, that it
 * "changes how fast the curve falls, not how high it starts". That is true only
 * while elimination is the slow step. Under **flip-flop kinetics** (`ka < ke`)
 * the terminal slope is set by ABSORPTION, and the sentence inverts: dragging
 * the slider across acamprosate's whole reported 2.5–3.5 h range leaves the tail
 * rate pinned at ka (0.0806/h, unchanged to four significant figures) while the
 * peak moves 25%. Copy written for the ordinary case and inherited silently by a
 * compound where it reverses is this project's recurring defect — the
 * transdermal `PeakNote` explaining a patch with the oral peak story, with every
 * test green. So the regime is computed and the copy branches on it.
 *
 * Decided against the ke EXTREMES rather than the nominal, because the note sits
 * under a control the reader is about to drag: a claim that holds only at the
 * default is not a claim about the slider. `mixed` is the case no shipped
 * compound has — a reported range that STRADDLES `ke = ka`, where the slider
 * genuinely does one thing at one end and the other thing at the other. It earns
 * its own branch anyway, because the alternative is a two-state flag that would
 * quietly hand a straddling compound the wrong sentence, which is the exact
 * failure this type exists to end.
 */
export type HalfLifeAxisRegime =
  /** Ordinary: `ke < ka` across the whole reported range — the slider tilts the tail. */
  | 'elimination_limited'
  /** Flip-flop: `ka < ke` across the whole reported range — the slider moves height, not slope. */
  | 'absorption_limited'
  /** The reported range crosses `ke = ka`: the slider's effect changes partway along it. */
  | 'mixed';

/** A one-compartment chart result (the v1 model). */
export interface OneCompartmentCurveResult extends CurveResultBase {
  model: 'one_compartment_first_order';
  /** The resolved engine parameters that produced the (main) curve. */
  params: PkParams;
  /** The half-life range its band spans, for the slider's bounds. */
  halfLifeRange?: HalfLifeRange;
  /** The Vd range its band spans, for the slider's bounds. */
  vdRange?: VdRange;
  /**
   * The oral-F range its band spans, for the slider's bounds. Present only on an
   * oral route whose compound reports a range — an IV curve has no F to vary.
   */
  fRange?: FRange;
  /** Elimination half-life, h (ln2 / ke) of the main curve — for the caption. */
  halfLifeH: number;
  /** Which rate the half-life slider can move here — selects the slider's note. */
  halfLifeAxisRegime: HalfLifeAxisRegime;
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
   * attribute the movement to a parameter. That orthogonality argument holds for
   * THIS axis unconditionally (nothing about timing moves when Vd does) but the
   * half-life half of it does not: under flip-flop the t½ slider moves the peak
   * and leaves the slope alone, i.e. it does what this one does. See
   * {@link HalfLifeAxisRegime}. The alternative (hold CL fixed) would
   * push `ke = CL/Vd` around and re-say what the half-life slider already says.
   * The on-screen copy states which is held constant; leaving it implicit would
   * make the curve ambiguous rather than merely under-explained.
   */
  vdL?: number;
  /**
   * Main-curve oral bioavailability override, a fraction in [0, 1] — the F
   * variability slider. Unset, the compound's derived F is used. Ignored on any
   * route the engine treats as non-oral, where F is 1 by definition.
   *
   * Unlike {@link vdL} there is no "what is held constant" choice to make: F
   * scales only the mass that enters, so nothing else has to move. What it does
   * do — and Vd does not — is move the METABOLITE lines, because formation
   * follows the absorbed dose. See {@link VariabilityAxis} for why that
   * asymmetry is the only observable difference between these two axes.
   */
  F?: number;
  /** Reference-subject weight, kg, for scaling per-kg Vd (defaults to 70 kg). */
  weightKg?: number;
  /** Grid resolution; defaults to {@link DEFAULT_SAMPLES}. */
  samples?: number;
}
