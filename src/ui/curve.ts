/**
 * UI ↔ engine/data glue (handoff §4, §13 Phase 4).
 *
 * The UI is the ONLY layer allowed to import both the data layer (a validated
 * {@link Compound}) and the engine (the pure curve math). This module is that
 * seam, kept out of the React components so it can be reasoned about (and
 * tested) on its own:
 *
 *   buildCurve:  Compound + route + dose  →  {t, c}[] sampled for the chart,
 *                plus the derived-value notes and warnings the UI must surface.
 *   routeOptions / defaultRoute:  which routes the engine can actually plot for a
 *                given compound, and a sensible default to select.
 *
 * No React here — this is plain TypeScript that the components consume.
 *
 * This file is the PUBLIC surface and the model dispatch; the work lives in
 * `curve/`, one module per concern:
 *
 *   routes.ts            the route picker's options
 *   schedule.ts          dosing defaults and the schedule → DoseEvent[] flattening
 *   variability.ts       the variability axes, their ranges and bands
 *   types.ts             CurveInput and the per-model CurveResult union
 *   grid.ts              the sampling grid every builder shares
 *   linear.ts            horizon + critical times shared by the linear builders
 *   metabolites.ts       which metabolites, and their curves, for the linear builders
 *   oneCompartment.ts    ┐
 *   twoCompartment.ts    │ one builder per disposition model
 *   threeCompartment.ts  │
 *   michaelisMenten.ts   ┘
 *   format.ts            number and concentration-unit display
 *
 * Import from here, not from `curve/` — the re-export list below is the
 * deliberate public API, and the helpers the builders share are not on it.
 */

import type { CompoundModel } from '../data/schema.ts';
import { buildCurveMM } from './curve/michaelisMenten.ts';
import { buildCurve1c } from './curve/oneCompartment.ts';
import { buildCurve3c } from './curve/threeCompartment.ts';
import { buildCurve2c } from './curve/twoCompartment.ts';
import type { CurveInput, CurveResult } from './curve/types.ts';

/**
 * The builder for each disposition model. A `Record` rather than an `if` chain
 * whose last branch is the one-compartment body: a fifth model must name its
 * builder here or fail to COMPILE, instead of being drawn — confidently and
 * silently — as a one-compartment drug. That is the route-ternary fallthrough
 * (CLAUDE.md) one axis over.
 */
const BUILDERS: Record<CompoundModel, (input: CurveInput) => CurveResult> = {
  one_compartment_first_order: buildCurve1c,
  two_compartment_first_order: buildCurve2c,
  three_compartment_first_order: buildCurve3c,
  one_compartment_michaelis_menten: buildCurveMM,
};

/**
 * Build the chart-ready curve for a dosing schedule, dispatching on the
 * compound's disposition model. Each builder derives its engine parameters from
 * the compound (throwing if the route lacks the data it needs — the caller
 * catches and shows the message), sizes the time grid to cover the last dose
 * plus its decay, and evaluates the engine over the whole schedule.
 */
export function buildCurve(input: CurveInput): CurveResult {
  return BUILDERS[input.compound.model](input);
}

export { buildCurve2c, buildCurve3c };
export { CONCENTRATION_UNITS, fmtNum, fmtPercent, toDisplayConcentration } from './curve/format.ts';
export type { ConcentrationDisplayUnit } from './curve/format.ts';
export { metaboliteTag } from './curve/metabolites.ts';
export { ENGINE_ROUTES, ROUTE_LABELS, defaultRoute, routeOptions } from './curve/routes.ts';
export type { RouteOption } from './curve/routes.ts';
export { DEFAULT_DOSE_MG, DEFAULT_INFUSION_DURATION_H, buildSchedule } from './curve/schedule.ts';
export type { DoseSchedule } from './curve/schedule.ts';
export type {
  CurveInput,
  CurvePoint,
  CurveResult,
  HalfLifeAxisRegime,
  MetaboliteCurve,
  MichaelisMentenCurveResult,
  OneCompartmentCurveResult,
  ThreeCompartmentCurveResult,
  TwoCompartmentCurveResult,
} from './curve/types.ts';
export {
  VARIABILITY_AXES,
  bandFor,
  fRangeOral,
  halfLifeRangeH,
  vdRangeL,
} from './curve/variability.ts';
export type {
  BandPoint,
  FRange,
  HalfLifeRange,
  VariabilityAxis,
  VariabilityBand,
  VdRange,
} from './curve/variability.ts';

/** Re-export so the UI labels the reference subject without reaching into engine. */
export { REFERENCE_WEIGHT_KG } from '../engine/units.ts';
