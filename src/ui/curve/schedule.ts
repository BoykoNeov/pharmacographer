/**
 * Dosing inputs as the UI expresses them — defaults, and the schedule the dose
 * editor builds — flattened to the `DoseEvent[]` the engine consumes.
 */

import { recurringDoses } from '../../engine/dosing.ts';
import type { DoseEvent } from '../../engine/types.ts';

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
