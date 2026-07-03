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
 * Resolved two-compartment disposition (handoff §12; the multi-compartment
 * extension), in canonical units. A linear mammillary model: a central
 * compartment (where drug is measured and eliminated) exchanging with one
 * peripheral compartment. Parameterised in the most *citable* clinical form —
 * clearances and volumes — from which the engine derives the micro-rate
 * constants (`k10 = CL/Vc`, `k12 = Q/Vc`, `k21 = Q/Vp`) and the bi-exponential
 * eigenvalues α, β internally (see {@link ./models2c.ts}).
 *
 * The whole system is linear, so superposition over a dose schedule stays valid
 * (same mechanism as `dosing.ts`). Routes covered are IV bolus, IV infusion, and
 * oral (first-order absorption ⇒ a tri-exponential curve: the two disposition
 * modes α, β plus the absorption mode ka). A 3-compartment parent is deferred.
 */
export interface TwoCompParams {
  /** Central volume of distribution, L — the concentration reference (C = A_central / Vc). */
  vc: number;
  /** Total (central) clearance, L/h — `= k10·Vc`; sets AUC = Dose/CL. */
  cl: number;
  /** Inter-compartmental clearance, L/h — `= k12·Vc = k21·Vp`; drives distribution. */
  q: number;
  /** Peripheral volume of distribution, L. */
  vp: number;
  /** Absorption rate constant, 1/h. Oral (first-order absorption) only. */
  ka?: number;
  /** Bioavailable fraction in [0, 1]. Extravascular routes (oral); 1 for IV. */
  F?: number;
  /** Infusion duration, h. `iv_infusion` only. */
  infusionDuration?: number;
}

/**
 * Resolved three-compartment disposition (handoff §12; the multi-compartment
 * extension, Stage B). A linear mammillary model: a central compartment (where
 * drug is measured and eliminated) exchanging with TWO peripheral compartments
 * that do not communicate with each other. Like {@link TwoCompParams} it is
 * parameterised in the most *citable* clinical form — clearances and volumes —
 * from which the engine derives the micro-rate constants
 *
 *   k10 = CL/Vc,  k12 = Q2/Vc,  k21 = Q2/Vp2,  k13 = Q3/Vc,  k31 = Q3/Vp3
 *
 * and the THREE disposition eigenvalues α > β > γ (the roots of a cubic, all
 * real and positive for physical parameters) internally (see {@link ./models3c.ts}).
 * The central concentration is a sum of three exponential {@link ExpMode}s, driven
 * by the same model-independent route spine ({@link ./modes.ts}) as the one- and
 * two-compartment models. As either peripheral clearance vanishes it collapses
 * to the two-compartment model, and with both gone to one compartment.
 */
export interface ThreeCompParams {
  /** Central volume of distribution, L — the concentration reference (C = A_central / Vc). */
  vc: number;
  /** Total (central) clearance, L/h — `= k10·Vc`; sets AUC = Dose/CL. */
  cl: number;
  /** Inter-compartmental clearance to peripheral 1, L/h — `= k12·Vc = k21·Vp2`. */
  q2: number;
  /** First peripheral volume of distribution, L. */
  vp2: number;
  /** Inter-compartmental clearance to peripheral 2, L/h — `= k13·Vc = k31·Vp3`. */
  q3: number;
  /** Second peripheral volume of distribution, L. */
  vp3: number;
  /** Absorption rate constant, 1/h. Oral (first-order absorption) only. */
  ka?: number;
  /** Bioavailable fraction in [0, 1]. Extravascular routes (oral); 1 for IV. */
  F?: number;
  /** Infusion duration, h. `iv_infusion` only. */
  infusionDuration?: number;
}

/**
 * One exponential mode of a linear disposition's central concentration for a
 * given dose: contributes `coef · e^(−rate·t)` mg/L. A one-compartment curve is
 * a single mode (`coef = D/Vd`, `rate = ke`); a two-compartment IV-bolus curve
 * is two modes (the distribution α and terminal β). Expressing disposition as a
 * list of modes is what lets the metabolite math (a superposition over the
 * parent's modes) and the parent curve share one building block (handoff §12).
 */
export interface ExpMode {
  /** Concentration coefficient, mg/L (scales with dose). */
  coef: number;
  /** Decay rate constant, 1/h. */
  rate: number;
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

/**
 * The metabolite's OWN disposition, independent of how the parent delivers it
 * (handoff §12). For a two-compartment parent the formation input is no longer a
 * single parent rate but a superposition over the parent's modes, so the
 * metabolite math is parameterised by these three quantities plus the parent's
 * modes and clearance — see {@link ./metabolite.ts}. `MetaboliteParams` (the
 * one-compartment case) is this shape plus the single `keParent` input rate.
 */
export interface MetaboliteDisposition {
  /** Metabolite volume of distribution, L (absolute, after any reference scaling). */
  vdM: number;
  /** Metabolite elimination rate constant, 1/h. */
  keM: number;
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
