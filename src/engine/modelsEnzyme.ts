/**
 * Capacity-limited elimination with an ENZYME-AMOUNT STATE — the model where the
 * body's clearing capacity is itself a differential equation.
 *
 * `modelsMM.ts` already drops linearity: elimination is `Vmax·C/(Km+C)`, so the
 * rate depends on how much drug is present. But its only state variables are
 * AMOUNTS OF DRUG, and `Vmax` is a constant of the compound. That is the exact
 * boundary `docs/DATA_GUIDE.md` names in the omeprazole re-gate, in the
 * between-dose-trough screen:
 *
 * > When a compound's exposure CHANGES over repeated dosing, compare the dosing
 * > interval with the half-life. If the concentration returns to ≈ zero between
 * > doses and exposure still climbs, the memory is not in the plasma, and no
 * > concentration-driven model can reproduce it at any parameter values.
 *
 * That is a statement about models whose state is drug. Here the state also
 * carries ENZYME, so the memory has somewhere to live: a dose can inactivate
 * enzyme that is still missing days later, when the drug itself is long gone.
 * The engine can therefore now draw the curve the screen said it could not —
 * accumulation across a trough of zero — and `tests/engine/modelsEnzyme.test.ts`
 * asserts exactly that, against `modelsMM.ts` refusing to.
 *
 * ## The model
 *
 * Enzyme is written as a FRACTION of its own drug-free baseline, `e = E/E₀`, so
 * it needs no absolute abundance (which is not citable for a whole body anyway)
 * and `Vmax(t) = Vmax·e(t)` recovers the ordinary MM model at `e ≡ 1`. Enzyme is
 * made at a constant rate and removed by ordinary turnover; a drug may push it
 * in either direction:
 *
 *   de/dt = k_deg·(1 + IND(C)) − k_deg·e − k_inact·(C/(K_I + C))·e
 *   dA_depot/dt   = −ka·A_depot                                    (oral only)
 *   dA_central/dt = input(t) + ka·A_depot − Vmax·e·C/(Km + C)
 *
 * with `C = A_central/Vd` and the two drug-driven terms
 *
 *   IND(C) = indMax·C/(EC50 + C)        induction: more enzyme SYNTHESISED
 *   k_inact·C/(K_I + C)                 inactivation: enzyme DESTROYED faster
 *
 * Both are saturable in the drug concentration, both default to zero, and both
 * are ordinary turnover pharmacology rather than anything invented here. With
 * both off, `e ≡ 1` and every curve is `modelsMM.ts`'s — the collapse anchor that
 * ties this path to the oracle-pinned one, exactly as MM's `Km ≫ C` limit ties it
 * to `models.ts`.
 *
 * Three consequences worth stating, because they are the teaching payload:
 *
 * 1. **Half-life depends on history, not just on concentration.** MM already
 *    made the apparent half-life a function of `C`. Here it is a function of `C`
 *    AND of what the patient took last week: the same concentration clears
 *    slower in someone whose enzyme is 40% inactivated.
 * 2. **Steady state can exist at a dose rate where it otherwise would not, or
 *    vanish at one where it otherwise would.** MM's `Css = r0·Km/(Vmax − r0)`
 *    diverges at `r0 = Vmax`; inactivation lowers that ceiling to
 *    `Vmax·k_deg/(k_deg + k_inact)` and induction raises it — see
 *    {@link enzymeTurnoverSteadyState}.
 * 3. **Recovery is on the ENZYME's clock, not the drug's.** After the drug is
 *    gone, `e` returns to 1 at `k_deg` regardless of how fast the drug cleared
 *    ({@link enzymeRecoveryTime}). A drug with a one-hour half-life can leave a
 *    week-long footprint.
 *
 * ## What this module is NOT
 *
 * **No compound ships against it, and adding one is a sourcing problem this file
 * does not solve.** A curated compound needs `k_deg` (an enzyme turnover
 * half-life) plus a `k_inact`/`K_I` pair (or `indMax`/`EC50`) that apply to the
 * PLASMA concentration this engine plots. Published inactivation constants are
 * usually in vitro, in µM at the enzyme, and turning those into whole-body
 * parameters is a physiologically-based scaling exercise with assumptions of its
 * own — precisely the kind of manufactured number the data guide refuses. So the
 * gate the guide pre-registered has moved rather than opened: it was "the engine
 * cannot represent this at any parameter values", and it is now "find a source
 * that fits these parameters to plasma data". See `docs/DATA_GUIDE.md`.
 *
 * The model is also deliberately ONE compartment and ONE enzyme pool: a lumped
 * whole-body capacity, in the same spirit as `modelsMM.ts`'s lumped `Vmax`/`Km`
 * (theophylline's stored `Km` measures no single enzyme either). A drug cleared
 * by two pathways of which only one is inactivated would need two pools, which
 * this does not have and which no source in this repo currently reports.
 *
 * No React, no DOM, no data/JSON imports, no I/O — see CLAUDE.md / handoff §4.
 */

import { integrateScheduledOde, type ScheduledOdeProblem } from './ode.ts';
import type { DoseEvent, Route } from './types.ts';

/**
 * Resolved enzyme-turnover parameters, in canonical units (mg, L, mg/L, h, 1/h,
 * mg/h). {@link MichaelisMentenParams} plus the enzyme's own kinetics.
 *
 * `vmax` is the BASELINE maximum elimination rate — the value in force at
 * `e = 1`, i.e. in a subject who has not been exposed. The instantaneous
 * capacity is `vmax·e(t)`.
 */
export interface EnzymeTurnoverParams {
  /** Absolute volume of distribution, L. */
  vd: number;
  /** Baseline maximum elimination rate, mg/h — the ceiling at `e = 1`. */
  vmax: number;
  /** Michaelis constant, mg/L — where elimination runs at half of `Vmax·e`. */
  km: number;
  /**
   * Enzyme turnover (degradation) rate constant, 1/h — `ln2 / t½,enzyme`. This is
   * the clock the system recovers on, and it must be > 0: an enzyme that never
   * turns over would never come back, so the model would have no steady state to
   * return to and `e = 1` would not be a drug-free equilibrium.
   */
  kdeg: number;
  /**
   * Maximum inactivation rate constant, 1/h — the extra first-order enzyme loss
   * imposed by a saturating drug concentration (mechanism-based inactivation).
   * Requires {@link ki}. Omit for a drug that does not inactivate its enzyme.
   */
  kinact?: number;
  /**
   * Drug concentration at half-maximal inactivation, mg/L. Requires
   * {@link kinact}. Expressed against the PLASMA concentration this engine
   * plots — an in vitro `K_I` at the enzyme is a different quantity.
   */
  ki?: number;
  /**
   * Maximum FRACTIONAL increase in enzyme synthesis at a saturating drug
   * concentration (induction): `indMax = 1` means synthesis can double, so `e`
   * approaches 2. Requires {@link ec50}. Omit for a drug that does not induce.
   */
  indMax?: number;
  /** Drug concentration at half-maximal induction, mg/L. Requires {@link indMax}. */
  ec50?: number;
  /** Absorption rate constant, 1/h. First-order input routes only. */
  ka?: number;
  /** Bioavailable fraction in [0, 1]. Extravascular routes; 1 for IV. */
  F?: number;
  /** Infusion duration, h. `iv_infusion` only. */
  infusionDuration?: number;
}

/** Curve output: the plotted concentration, and the enzyme trajectory behind it. */
export interface EnzymeTurnoverCurve {
  /** Central concentration at each grid time, mg/L. */
  concentration: number[];
  /**
   * Enzyme level at each grid time as a fraction of the drug-free baseline
   * (`E/E₀`; 1 = untouched). Returned alongside the concentration rather than
   * hidden, because it is the state that makes this model different from
   * `modelsMM.ts` and the only way a reader can see WHY the curve moved.
   */
  enzymeFraction: number[];
}

/**
 * RK4 step as a fraction of the system's fastest time constant — the same
 * calibration constant and the same reasoning as `modelsMM.ts`'s
 * `MM_MAX_STEP_FRACTION`, applied to a bound that now also covers the enzyme
 * equation (see {@link maxStep}).
 */
const MAX_STEP_FRACTION = 0.05;

/** State-vector layout for the walker (`ode.ts`): two amounts (mg) and a fraction. */
const DEPOT = 0;
const CENTRAL = 1;
const ENZYME = 2;

/** Read a state component defensively (strict index access). */
function at(state: readonly number[], i: number): number {
  return state[i] ?? 0;
}

/** Reject a parameter set whose optional pairs are half-supplied. */
function assertParams(params: EnzymeTurnoverParams): void {
  if (!(params.kdeg > 0)) {
    throw new Error(
      'enzyme turnover model requires kdeg > 0 — an enzyme that never turns over never recovers, so `e = 1` would not be a drug-free steady state',
    );
  }
  if ((params.kinact === undefined) !== (params.ki === undefined)) {
    throw new Error('enzyme turnover model: kinact and ki must be supplied together');
  }
  if ((params.indMax === undefined) !== (params.ec50 === undefined)) {
    throw new Error('enzyme turnover model: indMax and ec50 must be supplied together');
  }
}

/**
 * The saturable inactivation rate `k_inact·C/(K_I + C)` (1/h) at a concentration
 * — the EXTRA first-order enzyme loss on top of ordinary turnover. Zero when the
 * drug does not inactivate, and bounded by `k_inact` however high `C` goes.
 */
export function inactivationRate(params: EnzymeTurnoverParams, c: number): number {
  const { kinact, ki } = params;
  if (kinact === undefined || ki === undefined) return 0;
  const conc = Math.max(0, c);
  return (kinact * conc) / (ki + conc);
}

/**
 * The saturable induction term `indMax·C/(EC50 + C)` (dimensionless) at a
 * concentration — the FRACTIONAL increase in enzyme synthesis. Zero when the
 * drug does not induce, and bounded by `indMax`.
 */
export function inductionFactor(params: EnzymeTurnoverParams, c: number): number {
  const { indMax, ec50 } = params;
  if (indMax === undefined || ec50 === undefined) return 0;
  const conc = Math.max(0, c);
  return (indMax * conc) / (ec50 + conc);
}

/**
 * The enzyme level `e` a HELD concentration `c` would eventually settle at:
 *
 *   e_ss(c) = k_deg·(1 + IND(c)) / (k_deg + k_inact·c/(K_I + c))
 *
 * from `de/dt = 0`. `e_ss(0) = 1` (the drug-free baseline) for any parameters.
 * Note what the ratio says: inactivation matters in proportion to how it
 * compares with TURNOVER, not in absolute terms. A drug that inactivates an
 * enzyme with a 10 h turnover half-life at the same rate as one with a 100 h
 * half-life suppresses it ten times less, because the body rebuilds it ten times
 * faster. That is why `k_deg` is a required parameter and not a refinement.
 */
export function enzymeSteadyStateFraction(params: EnzymeTurnoverParams, c: number): number {
  assertParams(params);
  const { kdeg } = params;
  return (kdeg * (1 + inductionFactor(params, c))) / (kdeg + inactivationRate(params, c));
}

/**
 * Time (h) for the enzyme to travel from `from` to `to` (both as fractions of
 * baseline) once the DRUG IS GONE. With no drug the enzyme equation is linear —
 * `de/dt = k_deg·(1 − e)` — so recovery is exactly exponential toward 1:
 *
 *   e(t) = 1 − (1 − e₀)·e^(−k_deg·t)     ⇒     t = ln(|1 − e₀| / |1 − e₁|) / k_deg
 *
 * and the same formula serves induction decaying back DOWN to 1. This is the
 * honest answer to "how long until this wears off", and it is a property of the
 * enzyme alone: it contains no drug parameter at all — not `Vmax`, not `Km`, not
 * the half-life. A drug that leaves the body in an hour can leave a footprint
 * that takes a week to fill in.
 *
 * Requires `from` and `to` on the same side of 1 with `to` strictly closer to it
 * (recovery is monotone, so anything else is not a recovery).
 */
export function enzymeRecoveryTime(params: EnzymeTurnoverParams, from: number, to: number): number {
  assertParams(params);
  const gapFrom = 1 - from;
  const gapTo = 1 - to;
  if (gapFrom === 0 || gapTo === 0 || Math.sign(gapFrom) !== Math.sign(gapTo)) {
    throw new Error(
      'enzymeRecoveryTime: `from` and `to` must both sit on the same side of the baseline (1) and neither may be exactly 1',
    );
  }
  if (Math.abs(gapTo) >= Math.abs(gapFrom)) {
    throw new Error(
      'enzymeRecoveryTime: recovery moves toward the baseline, so `to` must be strictly closer to 1 than `from`',
    );
  }
  return Math.log(Math.abs(gapFrom) / Math.abs(gapTo)) / params.kdeg;
}

/**
 * The elimination capacity ceiling (mg/h) as the concentration grows without
 * bound — the sustained input rate this system can never clear:
 *
 *   sup elimination = Vmax · k_deg·(1 + indMax) / (k_deg + k_inact)
 *
 * because a saturating concentration drives `C/(Km+C) → 1`, `IND → indMax` and
 * the inactivation term → `k_inact`. With neither term the ceiling is `Vmax`,
 * recovering `modelsMM.ts`'s statement that `Css` diverges at `r0 = Vmax`.
 *
 * The teaching point is that a drug which destroys its own enzyme LOWERS the
 * dose rate at which steady state stops existing, and one that induces its own
 * metabolism RAISES it — the same cliff phenytoin illustrates, moved by the
 * enzyme rather than by the dose.
 */
export function eliminationCeiling(params: EnzymeTurnoverParams): number {
  assertParams(params);
  const { vmax, kdeg, kinact = 0, indMax = 0 } = params;
  return (vmax * (kdeg * (1 + indMax))) / (kdeg + kinact);
}

/** Sustained elimination rate (mg/h) at a held concentration, once enzyme has settled. */
function sustainedElimination(params: EnzymeTurnoverParams, c: number): number {
  return (params.vmax * enzymeSteadyStateFraction(params, c) * c) / (params.km + c);
}

/**
 * Steady-state concentration (mg/L) under a sustained input of `r0` mg/h, solving
 * the COUPLED equilibrium — drug and enzyme both stationary:
 *
 *   r0 = Vmax·e_ss(Css)·Css/(Km + Css),   e_ss(C) = k_deg(1+IND(C)) / (k_deg + k_inact·C/(K_I+C))
 *
 * Unlike `modelsMM.ts`'s `Css = r0·Km/(Vmax − r0)` this has no closed form (the
 * two saturable terms are of different concentrations), so it is solved
 * numerically — but the SOLVE is algebraic, independent of the ODE integrator,
 * which is what makes it usable as an oracle for the curve.
 *
 * Returns `Infinity` when `r0` is at or above {@link eliminationCeiling}: input
 * outruns what the (possibly depleted) enzyme can clear, and drug accumulates
 * without limit. With `kinact` and `indMax` both absent this reduces exactly to
 * the MM closed form.
 *
 * Method: the sustained-elimination function is scanned upward geometrically for
 * the first sign change and then bisected, so the root returned is the SMALLEST
 * one — the equilibrium a curve rising from zero actually reaches. (Elimination
 * is a product of a rising saturable term and a falling one, so it is not proven
 * monotone in general; taking the first crossing is the physically right answer
 * whether or not it is unique.)
 */
export function enzymeTurnoverSteadyState(params: EnzymeTurnoverParams, r0: number): number {
  assertParams(params);
  if (r0 <= 0) return 0;
  if (r0 >= eliminationCeiling(params)) return Infinity;

  // Bracket: start just above zero and grow until elimination overtakes the input.
  let lo = 0;
  let hi = Math.max(params.km, 1e-9);
  for (let i = 0; i < 200 && sustainedElimination(params, hi) < r0; i++) {
    lo = hi;
    hi *= 2;
  }
  if (sustainedElimination(params, hi) < r0) return Infinity;

  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (sustainedElimination(params, mid) < r0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Largest RK4 step (h) that keeps the integration accurate — the fastest rate in
 * the system, bounded above by three terms, each of which is a genuine bound
 * rather than an estimate:
 *
 * - `ka` — absorption, when the route has one;
 * - `Vmax·(1 + indMax)/(Vd·Km)` — the elimination term's steepest slope. As in
 *   `modelsMM.ts` the derivative of `Vmax·e·C/(Km+C)` is largest at `C = 0`,
 *   where it is `Vmax·e/(Vd·Km)`; and `e` itself is bounded by `1 + indMax`,
 *   since `de/dt ≤ k_deg·(1 + indMax) − k_deg·e` forces `e` down whenever it
 *   exceeds that;
 * - `k_deg + k_inact` — the enzyme equation's own decay rate, since its `e`
 *   coefficient is `k_deg + k_inact·C/(K_I+C) ≤ k_deg + k_inact`.
 */
function maxStep(params: EnzymeTurnoverParams): number {
  const { vmax, vd, km, kdeg, kinact = 0, indMax = 0, ka = 0 } = params;
  const fastest = Math.max(ka, (vmax * (1 + indMax)) / (vd * km), kdeg + kinact);
  return fastest > 0 ? MAX_STEP_FRACTION / fastest : Infinity;
}

/** Right-hand side of the three-state system at a state and a constant input rate. */
function derivatives(
  params: EnzymeTurnoverParams,
  state: readonly number[],
  inputRate: number,
): number[] {
  const depot = at(state, DEPOT);
  const central = at(state, CENTRAL);
  const enzyme = at(state, ENZYME);
  const c = Math.max(0, central / params.vd);

  const absorption = params.ka === undefined ? 0 : params.ka * depot;
  const elimination = (params.vmax * enzyme * c) / (params.km + c);
  const enzymeChange =
    params.kdeg * (1 + inductionFactor(params, c)) -
    (params.kdeg + inactivationRate(params, c)) * enzyme;

  return [-absorption, inputRate + absorption - elimination, enzymeChange];
}

/** Total zero-order input rate (mg/h) at `t` from every infusion running then. */
function infusionRateAt(
  params: EnzymeTurnoverParams,
  schedule: readonly DoseEvent[],
  t: number,
): number {
  const duration = params.infusionDuration;
  if (duration === undefined) return 0;
  return schedule.reduce(
    (rate, d) => (t >= d.time && t < d.time + duration ? rate + d.amount / duration : rate),
    0,
  );
}

/** The {@link ScheduledOdeProblem} for one route of this model. */
function enzymeProblem(
  route: Route,
  params: EnzymeTurnoverParams,
  schedule: readonly DoseEvent[],
): ScheduledOdeProblem {
  const common = {
    // The subject starts drug-free and enzyme-intact: e(0) = 1.
    initial: [0, 0, 1],
    derivatives: (state: readonly number[], inputRate: number) =>
      derivatives(params, state, inputRate),
    maxStep: maxStep(params),
  };

  if (route === 'iv_infusion') {
    const duration = params.infusionDuration;
    if (duration === undefined) {
      throw new Error('enzymeTurnoverCurve: iv_infusion route requires an infusion duration');
    }
    return {
      ...common,
      inputRateAt: (t) => infusionRateAt(params, schedule, t),
      breakpoints: schedule.map((d) => d.time + duration),
    };
  }

  return {
    ...common,
    applyDose: (state, amount) =>
      route === 'iv_bolus'
        ? [at(state, DEPOT), at(state, CENTRAL) + amount, at(state, ENZYME)]
        : [at(state, DEPOT) + (params.F ?? 1) * amount, at(state, CENTRAL), at(state, ENZYME)],
  };
}

/**
 * Concentrations (mg/L) and enzyme levels (fraction of baseline) at each grid
 * time for a whole dose schedule, under capacity-limited elimination whose
 * capacity is itself a state.
 *
 * Like `michaelisMentenCurve` this is a PARALLEL path to `dosing.ts`, not a route
 * through it: doses interact, so the schedule is integrated as one initial-value
 * problem rather than summed from single-dose curves. It interacts more strongly
 * and for longer than MM does — two doses a week apart still affect one another
 * if the enzyme has not recovered, which is the whole point.
 *
 * The walk itself (marks, dose instants, the input-rate midpoint probe) is shared
 * with `modelsMM.ts` via `ode.ts`; only the state vector and the right-hand side
 * differ. Throws if the route's required parameters are missing, or if the enzyme
 * parameters are half-supplied.
 */
export function enzymeTurnoverCurve(
  route: Route,
  params: EnzymeTurnoverParams,
  schedule: DoseEvent[],
  timeGrid: number[],
): EnzymeTurnoverCurve {
  assertParams(params);
  if (route === 'oral' && params.ka === undefined) {
    throw new Error('enzymeTurnoverCurve: oral route requires an absorption rate constant (ka)');
  }

  const states = integrateScheduledOde(enzymeProblem(route, params, schedule), schedule, timeGrid);
  return {
    concentration: states.map((state) => at(state, CENTRAL) / params.vd),
    enzymeFraction: states.map((state) => at(state, ENZYME)),
  };
}
