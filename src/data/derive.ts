/**
 * Derivation layer (handoff §8, docs/DATA_GUIDE.md, §13 Phase 3).
 *
 * Bridges DATA → ENGINE: a raw `Compound` reports whatever a source gave
 * (half-life, maybe clearance, Vd in L/kg, a Tmax instead of ka, F as a
 * percent…); the engine needs resolved `PkParams` in canonical units
 * (absolute L, 1/h, fraction). This module computes that subset and — crucially
 * — returns a LIST of what it had to derive plus any warnings, so the UI can be
 * honest about which numbers were measured and which were inferred.
 *
 * DATA layer: imports the engine (units, models, types) and the schema; the
 * engine never imports this.
 *
 * LINEARITY GATE (handoff §8, CLAUDE.md carry-forward): superposition — the one
 * mechanism the dosing engine uses — is valid only for linear PK. The engine is
 * deliberately pure and has no `linear` flag, so the gate must live here:
 * `deriveParams` refuses a `linear: false` (or non-one-compartment) compound
 * rather than silently feeding the engine parameters it will misuse.
 *
 * This file is the PUBLIC surface; the work lives in `derive/`, one module per
 * concern:
 *
 *   routes.ts            clinical route → engine input type, first pass, F labels, patches
 *   types.ts             the provenance notes, warnings and options every resolver shares
 *   shared.ts            the linearity gate and per-kg volume/clearance scaling
 *   phenotype.ts         phenotype presets, applied before any resolver
 *   tmax.ts              Tmax → ka inversion, one per linear model
 *   oneCompartment.ts    ┐
 *   twoCompartment.ts    │ one resolver per disposition model
 *   threeCompartment.ts  │
 *   michaelisMenten.ts   ┘
 *   metabolites.ts       a metabolite's own disposition
 *
 * Import from here, not from `derive/` — the re-export list below is the
 * deliberate public API, and the helpers the resolvers share are not on it.
 */

export {
  MAX_PLAUSIBLE_MASS_FRACTION,
  deriveMetaboliteDisposition,
  deriveMetaboliteParams,
} from './derive/metabolites.ts';
export type {
  DerivedMetaboliteDisposition,
  DerivedMetaboliteParams,
} from './derive/metabolites.ts';
export { deriveParamsMM } from './derive/michaelisMenten.ts';
export type { DerivedParamsMM } from './derive/michaelisMenten.ts';
export { KE_CROSSCHECK_REL_TOL, deriveParams } from './derive/oneCompartment.ts';
export type { DerivedParams } from './derive/oneCompartment.ts';
export { applyPhenotype, defaultPhenotypeId } from './derive/phenotype.ts';
export {
  absorptionRouteOf,
  appliesFirstPass,
  bioavailabilityLabel,
  engineRouteOf,
  resolveTransdermalInput,
} from './derive/routes.ts';
export type { TransdermalInput } from './derive/routes.ts';
export { deriveParams3c } from './derive/threeCompartment.ts';
export type { DerivedParams3c } from './derive/threeCompartment.ts';
export { kaFromTmax, kaFromTmax2c, kaFromTmax3c } from './derive/tmax.ts';
export { deriveParams2c } from './derive/twoCompartment.ts';
export type { DerivedParams2c } from './derive/twoCompartment.ts';
export type { DeriveOptions, DeriveWarning, DerivedNote } from './derive/types.ts';
