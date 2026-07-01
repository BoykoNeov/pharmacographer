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
import type { DoseEvent, PkParams, Route } from '../engine/types.ts';
import { REFERENCE_WEIGHT_KG } from '../engine/units.ts';
import { deriveParams, type DeriveWarning, type DerivedNote } from '../data/derive.ts';
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

/** Everything the chart area needs for one parameter set. */
export interface CurveResult {
  /** Sampled concentration-time curve, mg/L vs h. */
  points: CurvePoint[];
  /** The resolved engine parameters that produced the curve. */
  params: PkParams;
  /** Values the derivation computed rather than read (handoff §8). */
  derived: DerivedNote[];
  /** Cautions to surface alongside the curve (inferred route, assumed F, …). */
  warnings: DeriveWarning[];
  /** Elimination half-life, h (ln2 / ke) — for the model caption. */
  halfLifeH: number;
  /** Right edge of the time axis, h. */
  horizonH: number;
}

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
 * Build the chart-ready curve for a dosing schedule. Derives the engine
 * parameters from the compound (throwing, via `deriveParams`, if the compound is
 * nonlinear or the oral route lacks absorption data — the caller catches and
 * shows the message), injects the infusion duration for `iv_infusion`, sizes the
 * time grid to cover the last dose plus its decay, and evaluates the
 * superposition engine over the whole schedule.
 */
export function buildCurve(input: CurveInput): CurveResult {
  const { compound, route, schedule, weightKg, samples = DEFAULT_SAMPLES } = input;
  const { params: base, derived, warnings } = deriveParams(compound, route, { weightKg });

  // Spread (don't mutate) so a memoized `base` stays a faithful cache entry.
  let params = base;
  if (route === 'iv_infusion') {
    const requested = input.infusionDuration;
    const infusionDuration = requested !== undefined && requested > 0 ? requested : DEFAULT_INFUSION_DURATION_H;
    params = { ...base, infusionDuration };
  }

  const doses = buildSchedule(schedule);
  const lastDoseTime = doses.reduce((latest, dose) => Math.max(latest, dose.time), 0);

  const halfLifeH = Math.LN2 / params.ke;
  const horizonH = curveHorizon(route, params, lastDoseTime);
  const times = sampleGrid(horizonH, samples);
  const concentrations = concentrationCurve(route, params, doses, times);
  const points = times.map((t, i) => ({ t, c: concentrations[i] ?? 0 }));

  return { points, params, derived, warnings, halfLifeH, horizonH };
}

/** Format a number to `sig` significant figures, trimming trailing zeros. */
export function fmtNum(x: number, sig = 3): string {
  if (!Number.isFinite(x)) return '—';
  return Number(x.toPrecision(sig)).toString();
}

/** Re-export so the UI labels the reference subject without reaching into engine. */
export { REFERENCE_WEIGHT_KG };
