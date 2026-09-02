/**
 * Scheduled ODE walker — the shared spine of the NONLINEAR models, the way
 * `modes.ts` is the shared spine of the linear ones.
 *
 * Every linear model in this engine expresses a dose as a sum of exponential
 * modes, so `modes.ts` can write each route once, model-independently. Nonlinear
 * models have no such closed form: their curves are integrated. What they DO
 * share is the bookkeeping around the integration — walking a timeline of dose
 * events and sample times, never stepping across a discontinuity, applying a
 * bolus as a jump in the state, holding a zero-order input constant across a
 * segment. That bookkeeping is model-independent in exactly the way the mode
 * drivers are, and it is subtle enough (the dose-instant convention, the
 * midpoint probe for the input rate, doses landing before the grid opens) that
 * having two copies of it would mean re-achieving correctness twice — the
 * failure `src/ui/peak.ts` exists to prevent one layer up.
 *
 * So this module owns the walk, and a nonlinear model owns only its state
 * vector and its right-hand side:
 *
 *   `modelsMM.ts`      state = [depot, central]              (mg)
 *   `modelsEnzyme.ts`  state = [depot, central, enzyme]      (mg, mg, fraction)
 *
 * The integrator is classical fixed-step RK4, with the step sized by the caller
 * from the fastest rate in ITS system (`maxStep`); see `modelsMM.ts`'s
 * `maxStep` for why a bound on the Jacobian is the right thing to size on.
 *
 * **Every state variable is clamped at zero after each step.** That is not a
 * generic numerical policy but a property of the problems this walker serves:
 * each component is a non-negative physical quantity (an amount in mg, or an
 * enzyme level as a fraction of baseline), and the ODEs themselves never take
 * one negative — capacity-limited elimination slows as the amount falls, and
 * enzyme loss is proportional to the enzyme present. A finite step, however,
 * can undershoot past zero, and an unclamped negative amount would make
 * elimination run backwards (drug reappearing from nowhere).
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import type { DoseEvent } from './types.ts';

/**
 * One nonlinear initial-value problem over a dose schedule. The caller supplies
 * the state vector's meaning; this module only walks the timeline.
 *
 * Exactly one of {@link applyDose} and {@link inputRateAt} describes how a
 * scheduled dose enters the system: a JUMP (IV bolus into the central
 * compartment, or an oral dose into the absorption depot) or a zero-order INPUT
 * RATE held over an interval (an infusion). Supplying both, or neither, is a
 * caller bug and throws.
 */
export interface ScheduledOdeProblem {
  /** State vector at the start of the walk (before any dose). */
  readonly initial: readonly number[];
  /**
   * Right-hand side `dy/dt` at a state and a zero-order input rate (mg/h). The
   * walker guarantees `inputRate` is constant across the segment being stepped,
   * so the RHS never has to look at the clock.
   */
  readonly derivatives: (state: readonly number[], inputRate: number) => number[];
  /**
   * Apply an instantaneous dose of `amount` mg to the state — an IV bolus into
   * the central compartment, or an extravascular dose into the absorption depot
   * (where the caller applies `F`). Present for jump routes only.
   */
  readonly applyDose?: (state: readonly number[], amount: number) => number[];
  /**
   * Total zero-order input rate (mg/h) at time `t`, summed over every infusion
   * running then. Present for zero-order routes only. Evaluated at segment
   * MIDPOINTS, so an infusion starting or stopping exactly at a mark is never
   * ambiguous.
   */
  readonly inputRateAt?: (t: number) => number;
  /**
   * Extra instants the walk must stop at because the input rate steps there —
   * infusion ends, typically. Dose times and grid times are already marks.
   */
  readonly breakpoints?: readonly number[];
  /** Largest RK4 step, h. Sized by the caller on the fastest rate in its system. */
  readonly maxStep: number;
}

/** One classical RK4 step of size `h`, with every component floored at 0. */
function rk4Step(
  problem: ScheduledOdeProblem,
  state: readonly number[],
  inputRate: number,
  h: number,
): number[] {
  const advance = (base: readonly number[], slope: readonly number[], factor: number): number[] =>
    base.map((y, i) => y + factor * (slope[i] ?? 0));

  const k1 = problem.derivatives(state, inputRate);
  const k2 = problem.derivatives(advance(state, k1, h / 2), inputRate);
  const k3 = problem.derivatives(advance(state, k2, h / 2), inputRate);
  const k4 = problem.derivatives(advance(state, k3, h), inputRate);

  return state.map((y, i) =>
    Math.max(0, y + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0))),
  );
}

/**
 * Integrate from `from` to `to` at a constant `inputRate`, subdividing into
 * whole steps no larger than `problem.maxStep`. The walk guarantees no dose
 * event or input-rate breakpoint falls strictly inside the span, so the input
 * rate really is constant across it.
 */
function integrateSegment(
  problem: ScheduledOdeProblem,
  state: readonly number[],
  inputRate: number,
  from: number,
  to: number,
): number[] {
  const span = to - from;
  if (span <= 0) return [...state];
  const steps = Math.max(1, Math.ceil(span / problem.maxStep));
  const h = span / steps;
  let s: readonly number[] = state;
  for (let i = 0; i < steps; i++) s = rk4Step(problem, s, inputRate, h);
  return [...s];
}

/**
 * Walk a dose schedule and return the STATE VECTOR at each grid time, in grid
 * order. The caller reads whatever it needs out of each state (a concentration
 * is `central / Vd`; an enzyme level is its own component).
 *
 * The timeline is walked through a set of marks — every grid time, every dose
 * time, and every caller-supplied breakpoint — so RK4 never integrates across a
 * discontinuity. At each mark a dose landing exactly there is applied BEFORE the
 * state is recorded, which makes an IV bolus at `t` read `D/Vd` at `t`, matching
 * the linear engine's convention (`singleDoseConcentration` returns the
 * post-dose value at `tau = 0`).
 *
 * Doses before the first grid point are honoured — the walk starts at the
 * earliest mark of either kind — so a curve can open mid-course with drug
 * already on board. An empty grid yields an empty array; an empty schedule
 * yields the initial state at every grid time.
 */
export function integrateScheduledOde(
  problem: ScheduledOdeProblem,
  schedule: readonly DoseEvent[],
  timeGrid: readonly number[],
): number[][] {
  const isJumpRoute = problem.applyDose !== undefined;
  if (isJumpRoute === (problem.inputRateAt !== undefined)) {
    throw new Error(
      'integrateScheduledOde: a problem must supply exactly one of applyDose (jump routes) and inputRateAt (zero-order routes)',
    );
  }
  if (timeGrid.length === 0) return [];

  // Doses arriving as instantaneous jumps; several may share an instant.
  const jumpAt = new Map<number, number>();
  if (isJumpRoute) {
    for (const d of schedule) jumpAt.set(d.time, (jumpAt.get(d.time) ?? 0) + d.amount);
  }

  const marks = new Set<number>(timeGrid);
  for (const d of schedule) marks.add(d.time);
  for (const b of problem.breakpoints ?? []) marks.add(b);
  const ordered = [...marks].sort((a, b) => a - b);

  const sampled = new Map<number, number[]>();
  let state: number[] = [...problem.initial];
  let previous: number | undefined;

  for (const mark of ordered) {
    if (previous !== undefined) {
      // Midpoint probe: the input rate is constant across the segment by construction.
      const inputRate = problem.inputRateAt?.((previous + mark) / 2) ?? 0;
      state = integrateSegment(problem, state, inputRate, previous, mark);
    }
    const amount = jumpAt.get(mark);
    if (amount !== undefined && problem.applyDose) {
      state = [...problem.applyDose(state, amount)];
    }
    sampled.set(mark, state);
    previous = mark;
  }

  return timeGrid.map((t) => sampled.get(t) ?? [...problem.initial]);
}
