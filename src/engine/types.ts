/**
 * Core engine types (handoff §7).
 *
 * The engine is a pure function library: parameters + a dose schedule in, a
 * concentration-time array out. It knows nothing about drugs, files, or pixels.
 * Everything here is expressed in the canonical internal units defined in
 * {@link ./units.ts} (mg, L, mg/L, h, 1/h, L/h, mg/h).
 */

/** Administration routes supported by the v1 one-compartment engine. */
export type Route = 'iv_bolus' | 'oral' | 'iv_infusion';

/**
 * Pharmacokinetic parameters in canonical units, already resolved for a single
 * subject (i.e. Vd is absolute litres after reference-weight scaling). Produced
 * by the derivation layer from a raw compound; consumed by the model functions.
 */
export interface PkParams {
  /** Absolute volume of distribution, L. */
  vd: number;
  /** Elimination rate constant, 1/h. */
  ke: number;
  /** Absorption rate constant, 1/h. Oral (first-order absorption) only. */
  ka?: number;
  /** Bioavailable fraction in [0, 1]. Extravascular routes (oral); 1 for IV. */
  F?: number;
  /** Infusion duration, h. `iv_infusion` only. */
  infusionDuration?: number;
}

/**
 * Parameters for a single metabolite formed from the parent, in canonical units
 * (handoff §12). The metabolite has its own one-compartment disposition; its
 * formation is driven by the parent's elimination flux, so the parent's `ke`
 * enters as the *input* (formation) rate — the metabolite is Bateman-shaped with
 * `keParent` playing the role the absorption constant `ka` plays for an oral dose.
 *
 * Spike scope is an IV-BOLUS parent only (a mono-exponential parent → a 2-exp
 * metabolite). An oral parent (first-order absorption ⇒ a bi-exponential parent
 * ⇒ a 3-exp metabolite) and pre-systemic/first-pass formation are deferred.
 */
export interface MetaboliteParams {
  /** Metabolite volume of distribution, L (absolute, after any reference scaling). */
  vdM: number;
  /** Metabolite elimination rate constant, 1/h. */
  keM: number;
  /** Parent elimination rate constant, 1/h — the metabolite's formation (input) rate. */
  keParent: number;
  /** Fraction of the parent dose converted to this metabolite, in [0, 1]. */
  fractionFormed: number;
}

/** A single administered dose: `amount` mg given at `time` h. */
export interface DoseEvent {
  /** Administration time, h (relative to t = 0). */
  time: number;
  /** Dose amount, mg. */
  amount: number;
}

/**
 * The core engine entry point: parameters + schedule + sample grid →
 * concentrations (mg/L), one per grid point. Implemented as superposition over
 * a {@link singleDoseCurve} building block (handoff §7). Declared here so the UI
 * and tests can depend on the contract before the implementation lands.
 */
export type ConcentrationCurve = (
  route: Route,
  params: PkParams,
  schedule: DoseEvent[],
  timeGrid: number[],
) => number[];
