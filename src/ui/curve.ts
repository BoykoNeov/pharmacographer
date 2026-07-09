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
  type DeriveWarning,
  type DerivedNote,
} from '../data/derive.ts';
import type { Compound } from '../data/schema.ts';

/** Routes the v1 engine understands, in the order the picker presents them. */
export const ENGINE_ROUTES: readonly Route[] = ['oral', 'iv_bolus', 'iv_infusion'];

/** Human-facing route names. */
export const ROUTE_LABELS: Record<Route, string> = {
  oral: 'Oral',
  iv_bolus: 'IV bolus',
  iv_infusion: 'IV infusion',
};

/**
 * Default infusion duration (h) for the `iv_infusion` route — ~15 minutes, a
 * realistic short clinical infusion. The duration is a DOSING input, not a
 * compound property, so it lives here, not in the data files (handoff §7).
 */
export const DEFAULT_INFUSION_DURATION_H = 0.25;

/** Number of sample points across the time grid (chart resolution). */
const DEFAULT_SAMPLES = 300;

/** A route as offered in the UI, with whether the engine can plot it. */
export interface RouteOption {
  route: Route;
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
export function defaultRoute(compound: Compound): Route {
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

/** A sampled point of the variability envelope, mg/L at time `t` (h). */
export interface BandPoint {
  t: number;
  /** Concentration at the short (fast-elimination) half-life. */
  cLow: number;
  /** Concentration at the long (slow-elimination) half-life. */
  cHigh: number;
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
 * source gives no range (then there is no variability band to draw). This is the
 * ONE parameter v1 varies — Vd/F/ka variability is a documented non-goal
 * (handoff §11). All three values come from the same `disposition.halfLife`
 * field, so the point value always lies within the range (schema-enforced).
 */
export function halfLifeRangeH(compound: Compound): HalfLifeRange | null {
  const hl = compound.disposition.halfLife;
  if (!hl.range) return null;
  return {
    low: time.toCanonical(hl.range[0], hl.unit),
    nominal: time.toCanonical(hl.value, hl.unit),
    high: time.toCanonical(hl.range[1], hl.unit),
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
   * The low/high half-life envelope, present only when the compound reports a
   * half-life range (one-compartment only). Fixed at the reported extremes.
   */
  band?: BandPoint[];
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
  /** The half-life range the band spans, for the slider's bounds. */
  halfLifeRange?: HalfLifeRange;
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
 * Everything the chart area needs for one parameter set. A discriminated union on
 * `model`: the UI narrows on it to read the model-specific fields (1-comp `ke`/
 * `halfLifeH`, 2-comp α/β half-lives, 3-comp α/β/γ half-lives). Shared fields
 * (points, peak, band, metabolites, warnings, horizon) are on the base so the
 * chart consumes any of them.
 */
export type CurveResult =
  | OneCompartmentCurveResult
  | TwoCompartmentCurveResult
  | ThreeCompartmentCurveResult;

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
  route: Route;
  /** The dosing schedule (single = `count: 1`). */
  schedule: DoseSchedule;
  /** Infusion duration, h — used only for `iv_infusion`. */
  infusionDuration?: number;
  /**
   * Main-curve half-life override, h — the variability slider. When set, `ke` is
   * scaled to this half-life (via {@link scaleKe}); unset, the compound's derived
   * `ke` is used. Does NOT move the band, which stays at the reported extremes.
   */
  halfLifeH?: number;
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
    tail += 3 * (Math.LN2 / params.ka);
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

  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  const { params: base, derived, warnings } = deriveParams(compound, route, { weightKg });

  // Disposition + injected infusion duration, shared by the main line and band.
  // Spread (don't mutate) so a memoized `base` stays a faithful cache entry.
  let disposition = base;
  if (route === 'iv_infusion') {
    const requested = input.infusionDuration;
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
  const params: PkParams = { ...disposition, ke: mainKe };

  // Band extremes are FIXED at the reported low/high half-life (not the slider):
  // longer half-life ⇒ smaller ke ⇒ slower elimination ⇒ higher exposure (cHigh).
  const keSlow = range ? scaleKe(base.ke, nominalHalfLifeH, range.high) : mainKe;
  const keFast = range ? scaleKe(base.ke, nominalHalfLifeH, range.low) : mainKe;

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < parent ke) extends the horizon below and
  // isn't clipped mid-decay. Formation is driven by the parent ke actually plotted
  // (mainKe), so moving the half-life slider moves the metabolite consistently.
  const metaboliteDerivations =
    (route === 'iv_bolus' || route === 'oral' || route === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  // Size the grid on the slowest curve in view (smallest ke) so neither the band's
  // long-half-life tail nor a slow metabolite is clipped mid-decay.
  const slowestKe = Math.min(mainKe, keSlow, ...metaboliteDerivations.map((d) => d.params.keM));
  const horizonH = curveHorizon(route, { ...disposition, ke: slowestKe }, lastDoseTime);
  // Uniform grid for the overall shape, plus the exact dose/infusion instants so
  // discontinuous IV peaks aren't aliased (and the axis doesn't flicker).
  const times = mergeGrid(sampleGrid(horizonH, samples), criticalTimes(route, params, doses, horizonH));

  const concentrations = concentrationCurve(route, params, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  let band: BandPoint[] | undefined;
  if (range) {
    const high = concentrationCurve(route, { ...disposition, ke: keSlow }, doses, times);
    const low = concentrationCurve(route, { ...disposition, ke: keFast }, doses, times);
    band = times.map((t, i) => ({ t, cLow: low[i] ?? 0, cHigh: high[i] ?? 0 }));
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
    band,
    halfLifeRange: range ?? undefined,
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
    tail += 3 * (Math.LN2 / params.ka);
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
  const { params: base, derived, warnings } = deriveParams2c(compound, route, { weightKg });

  let disposition = base;
  if (route === 'iv_infusion') {
    const requested = input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < β) extends the horizon below.
  const metaboliteDerivations =
    (route === 'iv_bolus' || route === 'oral' || route === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  const { beta } = twoCompRates(disposition);
  const slowestRate = Math.min(beta, ...metaboliteDerivations.map((d) => d.params.keM));
  const horizonH = curveHorizon2c(route, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes2c(route, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve2c(route, disposition, doses, times);
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
    tail += 3 * (Math.LN2 / params.ka);
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
  const { params: base, derived, warnings } = deriveParams3c(compound, route, { weightKg });

  let disposition = base;
  if (route === 'iv_infusion') {
    const requested = input.infusionDuration;
    const infusionDuration =
      requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    disposition = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  // Metabolites (IV bolus, oral, or IV infusion parent). Derive their disposition up
  // front so a long-lived metabolite (keM < γ) extends the horizon below.
  const metaboliteDerivations =
    (route === 'iv_bolus' || route === 'oral' || route === 'iv_infusion') &&
    compound.metabolites?.length
      ? compound.metabolites.map((m) => ({
          meta: m,
          ...deriveMetaboliteDisposition(m, { weightKg }),
        }))
      : [];

  const { alpha, beta, gamma } = threeCompRates(disposition);
  const slowestRate = Math.min(gamma, ...metaboliteDerivations.map((d) => d.params.keM));
  const horizonH = curveHorizon3c(route, disposition, slowestRate, lastDoseTime);
  const times = mergeGrid(
    sampleGrid(horizonH, samples),
    criticalTimes3c(route, disposition, doses, horizonH),
  );

  const concentrations = concentrationCurve3c(route, disposition, doses, times);
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
