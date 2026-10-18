/**
 * Phenotype presets (§12: variability beyond half-life) — a Compound→Compound
 * transform applied before any resolver runs.
 */

import type { Compound } from '../schema.ts';

/**
 * The phenotype a compound opens on — its FIRST preset, which the schema requires
 * to carry no overrides. Undefined for a compound with no phenotypes, which is
 * every compound predating the feature.
 */
export function defaultPhenotypeId(compound: Compound): string | undefined {
  return compound.variability?.phenotypes?.presets[0]?.id;
}

/**
 * Re-anchor a compound onto one illustrative phenotype, returning the compound
 * that every downstream `derive*` call should be handed.
 *
 * This is a pure Compound→Compound transform applied BEFORE derivation, and that
 * is the whole design: by the time any model function runs, a phenotype has
 * already collapsed into ordinary numbers that look like they were always there.
 * No `derive*` signature knows phenotypes exist, and — the invariant that matters
 * — nothing about genotype crosses the engine boundary. The engine stays a pure
 * function of parameters, exactly as `CLAUDE.md` requires.
 *
 * Switching phenotype swaps EVERY affected parameter at once (half-life and each
 * polymorphic `fm` together), which is what makes the mixed state unreachable:
 * you cannot end up on one phenotype's half-life while `fm` is pinned to the
 * other's. That state is the documented procainamide catch, and it is now a thing
 * the type system cannot express rather than a thing a curator must remember.
 *
 * The default preset overrides nothing, so this returns the SAME OBJECT — the
 * default render is the base compound by construction, not by reconstruction.
 */
export function applyPhenotype(compound: Compound, phenotypeId?: string): Compound {
  const phenotypes = compound.variability?.phenotypes;
  if (!phenotypes) return compound;

  const id = phenotypeId ?? defaultPhenotypeId(compound);
  const preset = phenotypes.presets.find((p) => p.id === id);
  if (!preset) {
    throw new Error(
      `applyPhenotype: "${id}" is not a phenotype of "${compound.id}" (have: ${phenotypes.presets.map((p) => p.id).join(', ')})`,
    );
  }

  const overrides = preset.overrides;
  if (!overrides || (!overrides.halfLife && !overrides.fractionFormed?.length)) {
    return compound;
  }

  const next: Compound = { ...compound };
  if (overrides.halfLife && compound.disposition) {
    next.disposition = { ...compound.disposition, halfLife: overrides.halfLife };
  }
  if (overrides.fractionFormed?.length && compound.metabolites) {
    const byId = new Map(overrides.fractionFormed.map((f) => [f.metaboliteId, f.param]));
    next.metabolites = compound.metabolites.map((m) => {
      const fm = byId.get(m.id);
      return fm ? { ...m, fractionFormed: fm } : m;
    });
  }
  return next;
}
