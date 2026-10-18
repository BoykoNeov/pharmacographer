/**
 * Metabolite resolvers: a metabolite's own disposition (model-agnostic), and the
 * one-compartment parent's wrapper that attaches the formation rate.
 */

import type { MetaboliteDisposition, MetaboliteParams } from '../../engine/types.ts';
import { REFERENCE_WEIGHT_KG, time } from '../../engine/units.ts';
import type { Metabolite } from '../schema.ts';
import { asFraction, fmt, resolveVolumeParam } from './shared.ts';
import type { DeriveOptions, DeriveWarning, DerivedNote } from './types.ts';

/**
 * Plausibility ceiling for a metabolite's mass-basis formation (or first-pass)
 * fraction. The engine's `fractionFormed`/`firstPassFraction` scale parent MASS
 * cleared (dA_m/dt = fm·CL·C_p, no molar-mass term), and by this data set's
 * convention they are MW-adjusted from the molar fraction — so for a metabolite
 * HEAVIER than the parent they legitimately exceed 1: conjugation conserves
 * MOLES, not mass, and a glucuronide (MW ~2.2× the parent) formed from most of a
 * dose gives a mass-fm up to ~2.2 (e.g. acetaminophen glucuronide 119%). The
 * ceiling therefore reflects the largest realistic single-step parent→metabolite
 * mass gain, NOT 1; a value above it is a units/typo error, not chemistry.
 */
export const MAX_PLAUSIBLE_MASS_FRACTION = 3;

/** Resolved metabolite engine parameters plus the provenance of what was derived. */
export interface DerivedMetaboliteParams {
  /** Canonical-unit metabolite parameters ready for `engine/metabolite.ts`. */
  params: MetaboliteParams;
  /** What had to be computed (vs read), for the "measured vs derived" UI. */
  derived: DerivedNote[];
  /** Cautions: Vd scaling assumption, implausible formation fraction, … */
  warnings: DeriveWarning[];
}

/** Resolved metabolite disposition (model-agnostic) plus the provenance of what was derived. */
export interface DerivedMetaboliteDisposition {
  params: MetaboliteDisposition;
  derived: DerivedNote[];
  warnings: DeriveWarning[];
}

/**
 * Resolve the metabolite's OWN disposition — `vdM` (scaled from L/kg against the
 * reference subject, like the parent's), `keM = ln2 / t½_m` (metabolites report
 * no clearance, so `ke` always comes from the half-life), and `fractionFormed`
 * (normalised from percent when needed). This is independent of how the parent
 * delivers the metabolite, so it is shared by both the one- and two-compartment
 * parent paths (the one-compartment {@link deriveMetaboliteParams} adds the
 * single `keParent` input rate; the two-compartment path pairs it with the
 * parent's modes at plot time).
 */
export function deriveMetaboliteDisposition(
  metabolite: Metabolite,
  options: DeriveOptions = {},
): DerivedMetaboliteDisposition {
  const weightKg = options.weightKg ?? REFERENCE_WEIGHT_KG;
  const derived: DerivedNote[] = [];
  const warnings: DeriveWarning[] = [];

  // Metabolite Vd — absolute litres (scale per-kg against the reference subject).
  const vdM = resolveVolumeParam(metabolite.vd, 'metabolite Vd', 'vdM', weightKg, derived);

  // Metabolite ke — always from its half-life (no clearance is stored for metabolites).
  const halfLifeMH = time.toCanonical(metabolite.halfLife.value, metabolite.halfLife.unit);
  const keM = Math.LN2 / halfLifeMH;
  derived.push({
    parameter: 'keM',
    note: `metabolite ke = ln2 / t½ = ${fmt(keM)} 1/h (half-life ${fmt(metabolite.halfLife.value)} ${metabolite.halfLife.unit})`,
  });

  // Formation fraction — normalise percent to a [0, 1] fraction; flag implausible values.
  const fractionFormed = asFraction(metabolite.fractionFormed);
  if (metabolite.fractionFormed.unit === 'percent') {
    derived.push({
      parameter: 'fractionFormed',
      note: `formation fraction ${fmt(metabolite.fractionFormed.value)}% expressed as ${fmt(fractionFormed)}`,
    });
  }

  // Pre-systemic (first-pass) fraction — optional; the oral-only additive term. Normalise
  // percent to a fraction like fractionFormed; absent ⇒ undefined (no first-pass term).
  let firstPassFraction: number | undefined;
  if (metabolite.firstPassFraction) {
    firstPassFraction = asFraction(metabolite.firstPassFraction);
    if (metabolite.firstPassFraction.unit === 'percent') {
      derived.push({
        parameter: 'firstPassFraction',
        note: `first-pass fraction ${fmt(metabolite.firstPassFraction.value)}% expressed as ${fmt(firstPassFraction)}`,
      });
    }
    if (firstPassFraction < 0 || firstPassFraction > MAX_PLAUSIBLE_MASS_FRACTION) {
      warnings.push({
        parameter: 'firstPassFraction',
        message: `metabolite first-pass fraction ${fmt(firstPassFraction)} is implausible (mass-fm may exceed 1 for a heavier-than-parent metabolite, but not by this much) — check the source and units`,
      });
    }
  }

  // Formation must have at least one active pathway. `fractionFormed` may now be 0 —
  // a purely pre-systemic metabolite (all first-pass) is legitimate — but only when a
  // first-pass fraction carries it; the total (fm + ffp) must be positive.
  if (fractionFormed < 0 || fractionFormed > MAX_PLAUSIBLE_MASS_FRACTION) {
    warnings.push({
      parameter: 'fractionFormed',
      message: `metabolite formation fraction ${fmt(fractionFormed)} is implausible (mass-fm may exceed 1 for a heavier-than-parent metabolite, but not by this much) — check the source and units`,
    });
  } else if (fractionFormed + (firstPassFraction ?? 0) <= 0) {
    warnings.push({
      parameter: 'fractionFormed',
      message: `metabolite has no formation pathway (fractionFormed and firstPassFraction both 0) — check the source and units`,
    });
  }

  return { params: { vdM, keM, fractionFormed, firstPassFraction }, derived, warnings };
}

/**
 * Resolve the {@link MetaboliteParams} the engine's `engine/metabolite.ts` needs
 * for one metabolite formed from a ONE-COMPARTMENT parent, given the parent's
 * already-derived elimination rate (`parentKe`, 1/h — the metabolite's
 * formation/input rate). Thin wrapper over {@link deriveMetaboliteDisposition}
 * that attaches `keParent`. Does NOT re-check linearity — the caller only reaches
 * this after {@link deriveParams} has passed the linearity gate for the parent.
 */
export function deriveMetaboliteParams(
  metabolite: Metabolite,
  parentKe: number,
  options: DeriveOptions = {},
): DerivedMetaboliteParams {
  if (!(parentKe > 0)) {
    throw new Error('deriveMetaboliteParams: parentKe must be a positive rate constant');
  }
  const { params, derived, warnings } = deriveMetaboliteDisposition(metabolite, options);
  return { params: { ...params, keParent: parentKe }, derived, warnings };
}
