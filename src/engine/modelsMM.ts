/**
 * Nonlinear (Michaelis–Menten) one-compartment PK — the handoff §12 nonlinear seam.
 *
 * Every other model in this engine is LINEAR: elimination is `ke·A`, a curve is a
 * sum of exponential modes (`modes.ts`), and a schedule is the superposition of
 * time-shifted single-dose curves (`dosing.ts`). This module is the one place that
 * assumption is dropped. Here elimination is capacity-limited,
 *
 *   rate of elimination = Vmax·C / (Km + C)      (mg/h)
 *
 * which saturates: enzymes work at `Vmax` flat out and cannot go faster however
 * much drug arrives. Two consequences drive every design decision below.
 *
 * **1. There is no single half-life, and that is the teaching payload.** The
 * apparent half-life RISES with concentration ({@link apparentHalfLifeMM}) — at
 * `C ≪ Km` the drug behaves first-order at `ke = Vmax/(Vd·Km)`
 * ({@link firstOrderLimitRateMM}); at `C ≫ Km` it decays in a straight LINE at
 * `Vmax/Vd` mg/L/h, indifferent to how much is there (ethanol's famous
 * "one drink per hour"). A modest dose increase can therefore lift steady state
 * disproportionately — phenytoin's clinical signature.
 *
 * **2. Superposition is invalid, so there is no single-dose building block.** For
 * linear PK, doubling the dose doubles the curve and two doses add; neither holds
 * once `C` sits near `Km`, because each dose changes the elimination rate the
 * OTHER dose experiences. So this module cannot offer a `singleDoseConcentration`
 * for `dosing.ts` to sum. Instead {@link michaelisMentenCurve} integrates the whole
 * schedule as one initial-value problem, with doses applied as jumps in the state
 * (IV bolus → central compartment; oral → the absorption depot) and infusions as a
 * zero-order input term. This is a PARALLEL path to `dosing.ts`, not a route
 * through it.
 *
 * The ODE system, with `C = A_central/Vd`:
 *
 *   dA_depot/dt   = −ka·A_depot                                     (oral only)
 *   dA_central/dt = input(t) + ka·A_depot − Vmax·C/(Km + C)
 *
 * integrated by fixed-step RK4 between event boundaries (see {@link maxStep} for
 * how the step is sized and why that bound is the right one). Because the ODE has
 * no closed-form solution for oral or infusion input, the tests pin it with what
 * IS analytic: the IV-bolus implicit solution ({@link ivBolusElapsedTime}), the
 * IV-bolus AUC ({@link ivBolusAucMM}), the two limiting regimes, and mass balance.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import type { DoseEvent, Route } from './types.ts';

/**
 * Resolved Michaelis–Menten one-compartment parameters, in canonical units
 * (mg, L, mg/L, h, 1/h, mg/h). Unlike {@link PkParams} there is deliberately no
 * `ke` and no half-life: for capacity-limited elimination neither is a constant
 * of the drug, only of the drug AT a concentration (see
 * {@link apparentHalfLifeMM}). `Vmax` and `Km` replace them, and `Vd` keeps its
 * usual meaning.
 */
export interface MichaelisMentenParams {
  /** Absolute volume of distribution, L. */
  vd: number;
  /** Maximum elimination rate, mg/h — the ceiling the enzymes cannot exceed. */
  vmax: number;
  /** Michaelis constant, mg/L — the concentration at which elimination runs at Vmax/2. */
  km: number;
  /** Absorption rate constant, 1/h. Oral (first-order absorption) only. */
  ka?: number;
  /** Bioavailable fraction in [0, 1]. Extravascular routes (oral); 1 for IV. */
  F?: number;
  /** Infusion duration, h. `iv_infusion` only. */
  infusionDuration?: number;
}

/**
 * RK4 step as a fraction of the system's fastest time constant (see
 * {@link maxStep}). RK4's local error scales as `(h·λ)⁵`, so `h·λ = 0.05` leaves
 * roughly 3e-7 per step — far below the tolerance of any oracle here, and
 * calibrated in `tests/engine/modelsMM.test.ts` against the exact IV-bolus
 * implicit solution across both the zero-order and first-order regimes and the
 * transition between them (where fixed-step RK4 is weakest).
 */
const MM_MAX_STEP_FRACTION = 0.05;

/** The integrator's state: drug amounts, mg. */
interface MmState {
  /** Amount awaiting absorption at the depot (oral), mg. */
  depot: number;
  /** Amount in the central compartment, mg. */
  central: number;
}

/**
 * Capacity-limited elimination rate `Vmax·C/(Km + C)` (mg/h) for a central
 * amount. `C` is floored at 0: analytically the concentration never reaches zero
 * (as `C → 0` the term becomes first-order, so decay slows without ever crossing),
 * but a finite RK4 step can undershoot, and an unclamped negative `C` would make
 * elimination negative — drug reappearing from nowhere.
 */
function eliminationRate(params: MichaelisMentenParams, central: number): number {
  const c = Math.max(0, central / params.vd);
  return (params.vmax * c) / (params.km + c);
}

/** Right-hand side of the ODE system at a given state and (constant) input rate. */
function derivatives(
  params: MichaelisMentenParams,
  state: MmState,
  inputRate: number,
): MmState {
  const absorption = params.ka === undefined ? 0 : params.ka * state.depot;
  return {
    depot: -absorption,
    central: inputRate + absorption - eliminationRate(params, state.central),
  };
}

/**
 * Largest RK4 step (h) that keeps the integration accurate. The step is sized on
 * the fastest rate in the system, which is bounded by:
 *
 * - `ka` — absorption, when oral; and
 * - `Vmax/(Vd·Km)` — the elimination term's steepest slope. Differentiating
 *   `Vmax·C/(Km+C)` with respect to `C` gives `Vmax·Km/(Vd·(Km+C)²)`, which is
 *   largest at `C = 0`, where it equals `Vmax/(Vd·Km)`. So the MM Jacobian is
 *   bounded everywhere by its own first-order limit rate — the drug is never
 *   "faster" than the linear drug it becomes at low concentration. This is why a
 *   single fixed step sized here is safe across BOTH regimes, including the
 *   saturated one (where the curve is nearly a straight line and RK4 is close to
 *   exact anyway).
 */
function maxStep(params: MichaelisMentenParams): number {
  const fastest = Math.max(firstOrderLimitRateMM(params), params.ka ?? 0);
  return fastest > 0 ? MM_MAX_STEP_FRACTION / fastest : Infinity;
}

/** One classical RK4 step of size `h`, with both amounts floored at 0. */
function rk4Step(
  params: MichaelisMentenParams,
  state: MmState,
  inputRate: number,
  h: number,
): MmState {
  const k1 = derivatives(params, state, inputRate);
  const k2 = derivatives(
    params,
    { depot: state.depot + (h / 2) * k1.depot, central: state.central + (h / 2) * k1.central },
    inputRate,
  );
  const k3 = derivatives(
    params,
    { depot: state.depot + (h / 2) * k2.depot, central: state.central + (h / 2) * k2.central },
    inputRate,
  );
  const k4 = derivatives(
    params,
    { depot: state.depot + h * k3.depot, central: state.central + h * k3.central },
    inputRate,
  );
  return {
    depot: Math.max(
      0,
      state.depot + (h / 6) * (k1.depot + 2 * k2.depot + 2 * k3.depot + k4.depot),
    ),
    central: Math.max(
      0,
      state.central + (h / 6) * (k1.central + 2 * k2.central + 2 * k3.central + k4.central),
    ),
  };
}

/**
 * Integrate from `from` to `to` at a constant `inputRate`, subdividing into
 * whole steps no larger than {@link maxStep}. The caller guarantees no dose event
 * or infusion boundary falls strictly inside the span, so the input rate really
 * is constant across it.
 */
function integrateSegment(
  params: MichaelisMentenParams,
  state: MmState,
  inputRate: number,
  from: number,
  to: number,
): MmState {
  const span = to - from;
  if (span <= 0) return state;
  const steps = Math.max(1, Math.ceil(span / maxStep(params)));
  const h = span / steps;
  let s = state;
  for (let i = 0; i < steps; i++) s = rk4Step(params, s, inputRate, h);
  return s;
}

/**
 * Total zero-order input rate (mg/h) at time `t` from every infusion running at
 * that instant. Evaluated at a segment MIDPOINT by the caller, so a boundary
 * instant (an infusion starting or stopping exactly at `t`) can never be
 * ambiguous.
 */
function infusionRateAt(
  params: MichaelisMentenParams,
  schedule: DoseEvent[],
  t: number,
): number {
  const duration = params.infusionDuration;
  if (duration === undefined) return 0;
  return schedule.reduce(
    (rate, d) => (t >= d.time && t < d.time + duration ? rate + d.amount / duration : rate),
    0,
  );
}

/**
 * Concentrations (mg/L) at each grid time for a whole dose schedule under
 * capacity-limited elimination — the nonlinear counterpart of `dosing.ts`'s
 * `concentrationCurve`, and the reason it is a separate entry point: these doses
 * INTERACT (each one slows the others' elimination), so they cannot be computed
 * independently and summed.
 *
 * The timeline is walked through a set of marks — every grid time, every dose
 * time, and every infusion end — so that RK4 never integrates across a
 * discontinuity. At each mark any dose landing exactly there is applied BEFORE
 * the sample is recorded, which makes an IV bolus at `t` read `D/Vd` at `t`,
 * matching the linear engine's convention.
 *
 * Doses before the first grid point are honoured (the walk starts at the earliest
 * mark of either kind), so a curve can open mid-course with drug already on board.
 * An empty grid yields an empty array; an empty schedule yields all zeros.
 *
 * Throws if the route's required parameters are missing.
 */
export function michaelisMentenCurve(
  route: Route,
  params: MichaelisMentenParams,
  schedule: DoseEvent[],
  timeGrid: number[],
): number[] {
  if (route === 'oral' && params.ka === undefined) {
    throw new Error('michaelisMentenCurve: oral route requires an absorption rate constant (ka)');
  }
  if (route === 'iv_infusion' && params.infusionDuration === undefined) {
    throw new Error('michaelisMentenCurve: iv_infusion route requires an infusion duration');
  }
  if (timeGrid.length === 0) return [];

  // Bolus/oral doses arrive as instantaneous jumps; several may share an instant.
  const jumpAt = new Map<number, number>();
  if (route !== 'iv_infusion') {
    for (const d of schedule) {
      jumpAt.set(d.time, (jumpAt.get(d.time) ?? 0) + d.amount);
    }
  }

  // Marks: every instant the integrator must stop at — grid samples, dose jumps,
  // and infusion starts/ends (each a step change in the input rate).
  const marks = new Set<number>(timeGrid);
  for (const d of schedule) {
    marks.add(d.time);
    if (route === 'iv_infusion') marks.add(d.time + params.infusionDuration!);
  }
  const ordered = [...marks].sort((a, b) => a - b);

  const sampled = new Map<number, number>();
  let state: MmState = { depot: 0, central: 0 };
  let previous: number | undefined;

  for (const mark of ordered) {
    if (previous !== undefined) {
      // Midpoint probe: the rate is constant across the segment by construction.
      const inputRate =
        route === 'iv_infusion' ? infusionRateAt(params, schedule, (previous + mark) / 2) : 0;
      state = integrateSegment(params, state, inputRate, previous, mark);
    }
    const amount = jumpAt.get(mark);
    if (amount !== undefined) {
      state =
        route === 'iv_bolus'
          ? { ...state, central: state.central + amount }
          : { ...state, depot: state.depot + (params.F ?? 1) * amount };
    }
    sampled.set(mark, state.central / params.vd);
    previous = mark;
  }

  return timeGrid.map((t) => sampled.get(t) ?? 0);
}

// ── Closed forms ────────────────────────────────────────────────────────────
// Capacity-limited elimination has no explicit solution `C(t)`, but the IV-bolus
// case — the only one where C falls monotonically from a known start with no
// input — yields exact expressions by separating variables. They are both the
// engine's oracles and the honest numbers the UI shows in place of "the"
// half-life. Everything here is IV-BOLUS ONLY; see `ivBolusAucMM` for why that
// restriction is real rather than incidental.

/**
 * The C→0 first-order limit rate `ke = Vmax/(Vd·Km)` (1/h). Far below `Km` the
 * elimination term `Vmax·C/(Km+C)` linearises to `(Vmax/Km)·C`, so the drug is
 * indistinguishable from a linear one-compartment drug with this `ke` — the
 * regime most drugs live in at therapeutic doses, and the reason the MM model
 * collapses cleanly onto `models.ts` (a tie the tests pin).
 */
export function firstOrderLimitRateMM(params: MichaelisMentenParams): number {
  return params.vmax / (params.vd * params.km);
}

/**
 * Exact elapsed time (h) for an IV bolus to fall from `c0` to `c` (mg/L), from
 * the implicit solution of the MM ODE:
 *
 *   Km·ln(C0/C) + (C0 − C) = (Vmax/Vd)·t
 *
 * Separating `dC/dt = −Vmax·C/(Vd·(Km+C))` gives this directly. It cannot be
 * inverted to `C(t)` in elementary functions — which is exactly why the curve is
 * integrated numerically — but in this direction it is exact, making it the
 * engine's primary oracle: choose a target `c`, get the time it must occur at,
 * and check the integrator agrees.
 *
 * Requires `c0 > 0` and `0 < c ≤ c0`. As `c → 0` the time diverges logarithmically:
 * the first-order tail means the drug never formally reaches zero, however
 * straight the saturated part of its decline looks.
 */
export function ivBolusElapsedTime(
  params: MichaelisMentenParams,
  c0: number,
  c: number,
): number {
  if (!(c0 > 0) || !(c > 0) || c > c0) {
    throw new Error('ivBolusElapsedTime: requires c0 > 0 and 0 < c <= c0');
  }
  return (params.vd / params.vmax) * (params.km * Math.log(c0 / c) + (c0 - c));
}

/**
 * Apparent half-life (h) AT a concentration `c` (mg/L) — the time an IV bolus
 * currently at `c` takes to reach `c/2`, from the implicit solution with
 * `C0 = c`, `C = c/2`:
 *
 *   t½(c) = (Vd/Vmax)·(Km·ln2 + c/2)
 *
 * This is the honest replacement for a stored half-life, and the number the UI
 * should show instead of one: it RISES linearly with concentration, so the same
 * molecule reports different half-lives at different doses — a fixed value is not
 * merely imprecise for these drugs, it is a category error. As `c → 0` it tends
 * to `ln2/{@link firstOrderLimitRateMM}`, recovering the ordinary linear
 * half-life; at `c ≫ Km` it roughly doubles when the dose doubles.
 */
export function apparentHalfLifeMM(params: MichaelisMentenParams, c: number): number {
  return (params.vd / params.vmax) * (params.km * Math.LN2 + c / 2);
}

/**
 * Total exposure of a single IV BOLUS dose, AUC₀→∞ (mg·h/L):
 *
 *   AUC = (Vd/Vmax)·(Km·C0 + C0²/2),    C0 = D/Vd
 *
 * obtained by the change of variables `dt = −Vd·(Km+C)/(Vmax·C)·dC`, which needs
 * `C` monotonic — true for a bolus, false the moment there is input.
 *
 * **Route-dependent, unlike every linear AUC in this engine.** For linear PK,
 * `AUC = F·D/CL` whatever the input rate: absorption reshapes the curve but not
 * its area. Under saturation that breaks — slower input keeps `C` lower, further
 * from saturation, so elimination runs proportionally FASTER and the same dose
 * yields LESS exposure. So there is deliberately no `oralAucMM`: an oral MM dose's
 * AUC depends on `ka` and is not available in closed form. The quadratic `C0²/2`
 * term is where dose-proportionality dies — double the dose and AUC MORE than
 * doubles.
 */
export function ivBolusAucMM(params: MichaelisMentenParams, dose: number): number {
  const c0 = dose / params.vd;
  return (params.vd / params.vmax) * (params.km * c0 + (c0 * c0) / 2);
}

/**
 * Steady-state concentration (mg/L) under a sustained input of `r0` mg/h — the
 * one exactly-solvable quantity outside the IV-bolus case, because steady state
 * is algebraic rather than dynamic: setting `dA/dt = 0` means input equals
 * elimination, `r0 = Vmax·Css/(Km + Css)`, so
 *
 *   Css = r0·Km / (Vmax − r0)
 *
 * **This is the whole nonlinear story in one line.** For a linear drug
 * `Css = r0/CL` — a straight line through the origin, so 10% more dose is 10%
 * more concentration, forever. Here `Css` has a VERTICAL ASYMPTOTE at `r0 = Vmax`:
 * as the dose rate approaches the enzymes' ceiling the curve bends upward without
 * limit, and beyond it no steady state exists at all — drug accumulates until
 * something else intervenes. Phenytoin's clinical signature is exactly this:
 * near the top of its range a small dose increment can move concentration
 * disproportionately, because the dose rate is climbing the asymptote.
 *
 * Returns `Infinity` when `r0 ≥ Vmax` (no steady state — input outruns the
 * maximum the body can clear). `r0 = Vmax` is included: the limit diverges.
 */
export function infusionSteadyStateMM(params: MichaelisMentenParams, r0: number): number {
  if (r0 >= params.vmax) return Infinity;
  return (r0 * params.km) / (params.vmax - r0);
}
