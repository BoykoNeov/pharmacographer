/**
 * Phenotype preset picker (handoff §12 — "variability beyond half-life", the
 * `geneticFactors` seam made load-bearing).
 *
 * THE COPY HERE IS LOAD-BEARING, NOT DECORATION. A control that switches between
 * genotype-driven curves sits close to the brightest line this project has
 * (CLAUDE.md): educational, never clinical. The distinction it must hold is:
 *
 *   ALLOWED  — "here is what the fast-acetylator POPULATION looks like"
 *   FORBIDDEN — "tell me your genotype and I will show you YOUR curve"
 *
 * So this control never asks the user anything about themselves. It offers two
 * illustrative populations to look at, exactly as the 70 kg reference subject
 * offers an illustrative body weight, and it says so on screen. It is labelled
 * "Illustrative population", not "Your genotype"; the options are archetypes, not
 * a self-report. Do not "improve" this into a personalisation control, however
 * naturally the UI seems to invite it.
 *
 * Presentational: it reports the chosen preset id upward and App owns the state
 * (and the half-life reset that must accompany a switch — see App).
 */

import type { Compound } from '../../data/schema.ts';

interface PhenotypePickerProps {
  compound: Compound;
  selectedId: string | undefined;
  onSelect: (phenotypeId: string) => void;
}

export function PhenotypePicker({ compound, selectedId, onSelect }: PhenotypePickerProps) {
  const phenotypes = compound.variability?.phenotypes;
  // Most compounds model one unnamed population and get no control at all.
  if (!phenotypes) return null;

  const active = phenotypes.presets.find((p) => p.id === selectedId) ?? phenotypes.presets[0];

  return (
    <fieldset className="control control--phenotype">
      <legend className="control__label">
        Illustrative population
        <span className="control__hint"> ({phenotypes.factor})</span>
      </legend>
      <div className="phenotype__options" role="radiogroup" aria-label="Illustrative population">
        {phenotypes.presets.map((preset) => (
          <label key={preset.id} className="phenotype__option">
            <input
              type="radio"
              name={`phenotype-${compound.id}`}
              value={preset.id}
              checked={preset.id === active?.id}
              onChange={() => onSelect(preset.id)}
            />
            <span>{preset.label}</span>
          </label>
        ))}
      </div>
      {active && <p className="control__note">{active.description}</p>}
      <p className="control__note control__note--emphasis">
        These are illustrative population archetypes — the same kind of teaching assumption as the
        70 kg reference subject. This is not a genotype test, it does not ask for or use anything
        about you, and it must not be read as telling any individual which group they fall into.
      </p>
    </fieldset>
  );
}
