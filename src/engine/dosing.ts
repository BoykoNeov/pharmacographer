/**
 * Dosing & superposition (handoff §7, §13 Phase 2).
 *
 * Multiple / recurring dosing is handled by ONE mechanism: linear superposition
 * of time-shifted single-dose curves. For a schedule of doses Dᵢ given at times
 * tᵢ (same route), the total concentration is
 *
 *   C_total(t) = Σᵢ singleDoseConcentration(route, params, Dᵢ, t − tᵢ)
 *
 * where each dose contributes only for t ≥ tᵢ (the building block returns 0 for
 * negative elapsed time). Single doses, ad-hoc extra doses, and regular
 * recurring schedules are therefore all just different `DoseEvent[]` inputs.
 *
 * LINEARITY INVARIANT — superposition is mathematically valid ONLY for linear
 * PK. The engine works in resolved numeric parameters and deliberately has no
 * `linear` flag (that belongs to the compound, in the data layer). The caller
 * MUST NOT feed a nonlinear compound's parameters here: per handoff §8,
 * `linear: false` compounds disable superposition in the UI, and v1 ships none.
 * When nonlinear PK arrives (§12) it replaces superposition with numerical ODE
 * integration — a different code path, not this one.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { singleDoseConcentration } from './models.ts';
import type { ConcentrationCurve, DoseEvent } from './types.ts';

/**
 * Total concentration (mg/L) at each grid time, as the linear superposition of
 * every scheduled dose. Each dose `d` contributes
 * `singleDoseConcentration(route, params, d.amount, t − d.time)`, which is 0
 * until the dose is administered. An empty schedule yields all zeros.
 */
export const concentrationCurve: ConcentrationCurve = (route, params, schedule, timeGrid) =>
  timeGrid.map((t) =>
    schedule.reduce(
      (total, dose) => total + singleDoseConcentration(route, params, dose.amount, t - dose.time),
      0,
    ),
  );

/** Parameters describing a regular, evenly-spaced course of identical doses. */
export interface RecurringDoseSpec {
  /** Amount of each dose, mg. */
  amount: number;
  /** Number of doses; non-negative integer (0 → empty schedule). */
  count: number;
  /** Interval τ between consecutive doses, h. Must be > 0 when `count` > 1. */
  interval: number;
  /** Time of the first dose, h. Defaults to 0. */
  start?: number;
}

/**
 * Build the `DoseEvent[]` for a regular recurring schedule: `count` doses of
 * `amount` mg, the first at `start` and each subsequent one `interval` hours
 * later. Ad-hoc extra doses are expressed by concatenating further
 * `DoseEvent`s — `concentrationCurve` treats any `DoseEvent[]` uniformly.
 */
export function recurringDoses({
  amount,
  count,
  interval,
  start = 0,
}: RecurringDoseSpec): DoseEvent[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('recurringDoses: count must be a non-negative integer');
  }
  if (count > 1 && !(interval > 0)) {
    throw new Error('recurringDoses: interval must be positive when count > 1');
  }
  const doses: DoseEvent[] = [];
  for (let i = 0; i < count; i++) {
    doses.push({ time: start + i * interval, amount });
  }
  return doses;
}
