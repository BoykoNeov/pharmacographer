import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import type { Compound } from '../../src/data/schema.ts';
import { buildCurve, type DoseSchedule } from '../../src/ui/curve.ts';
import { concentration, mass, time } from '../../src/engine/units.ts';
import type { ConcentrationUnit, MassUnit, TimeUnit } from '../../src/engine/units.ts';

/**
 * THE MAGNITUDE CHECK, AS DATA RATHER THAN AS A BESPOKE TEST.
 *
 * `CONTRIBUTING.md` and `CLAUDE.md` both say magnitude "cannot come from CI, so
 * it has to come from you", and that is the standing trap. It is not quite what
 * was true. Magnitude WAS already checked in CI — for four compounds, by three
 * hand-written test files: `src/ui/curve.mm.test.ts` (phenytoin's Css cliff and
 * ethanol's 15 mg/dL/h slope), `tests/ui/transdermal.test.tsx` (clonidine's
 * label-reported 0.4 ng/mL plateau) and `tests/ui/intramuscular.test.tsx`
 * (ketamine's Cmax across a 12-fold dose range). Each was written because that
 * compound's parameters are only meaningful together, and each is still the right
 * shape for what it checks — slopes, half-life ranges, approach times.
 *
 * What did not exist was a way to state a magnitude anchor as DATA. A curator who
 * ran the check by hand had two options: write a sentence in `notes`, or write a
 * test file. The first decays silently on the next parameter edit; the second is
 * not something a data-only contribution can reasonably be asked for. So 44 of 48
 * compounds had the sentence.
 *
 * This file is the third option. A compound declares what a source measured, and
 * the check runs forever without anyone writing a test.
 *
 * The cost of leaving it in prose was not hypothetical. A fabricated magnitude
 * number reached shipped `notes` once (sumatriptan: "76.5 ng/mL at 11.6 min",
 * written before the check was run — measured 72.7 at 12.0), and it was found by
 * an advisor reading the file, not by any gate. A number in `notes` also decays
 * silently: every parameter edit invalidates it, and nothing says so.
 *
 * What this file does is mechanical, and that is the point. For each
 * `validation` entry on each compound: build the curve at the dose the source
 * used, on the route the source used, and require the peak to land where the
 * source said it did.
 *
 * Three things it deliberately does NOT do.
 *
 * - **It does not replace the four bespoke tests**, and should not absorb them as
 *   they stand: they assert things a single-dose Cmax/Tmax entry cannot say (a
 *   decline that is straight, a steady state that is superlinear in dose rate, a
 *   plateau reached on the label's timescale). The overlap worth removing is
 *   listed in `docs/ROADMAP.md` B2 — steady-state observations — not the tests
 *   themselves.
 *
 * - **It does not check the compounds that carry no entries**, and it must not be
 *   read as if it did. Coverage is asserted below (as a listed set, never a
 *   count floor — the `loader.test.ts` lesson), so a compound silently dropping
 *   its entries fails, but a compound that never had any is simply not covered
 *   yet. Back-filling the rest is curation work: each entry needs the dose, the
 *   population and the source the number actually came from, which is a reading
 *   of the source, not a transformation of the file.
 * - **It does not replace the curator's judgement about whether a gap matters.**
 *   Where a model is known to miss (diphenhydramine's peak sits above Blyden's
 *   reported band), the entry records the reported number and a tolerance wide
 *   enough to hold, with the reason in `conditions`. That pins the SIZE of the
 *   miss: a later parameter change that widens it fails here.
 */

const compounds = loadAllCompounds();

/** A single dose, the shape `buildCurve` wants. */
function singleDose(amountMg: number): DoseSchedule {
  return { amount: amountMg, count: 1, interval: 0, adHoc: [] };
}

/** Every compound that carries at least one observation, by id. */
const validated = compounds.filter((c) => c.validation && c.validation.length > 0);

/**
 * The compounds expected to carry observations — spelled out rather than counted.
 * A count floor passes while an entry quietly disappears; this fails, and it also
 * makes the coverage gap legible in one place. ADD to this list when you add
 * entries to a compound.
 */
const VALIDATED_IDS = [
  'allopurinol',
  'dextroamphetamine',
  'diazepam',
  'diphenhydramine',
  'levofloxacin',
  'lsd',
  'morphine',
  'methamphetamine',
  'metronidazole',
  'pregabalin',
  'psilocin',
  'sumatriptan',
  'zolpidem',
] as const;

describe('coverage', () => {
  it('exactly the compounds listed here carry validation entries', () => {
    expect(validated.map((c) => c.id).sort()).toEqual([...VALIDATED_IDS].sort());
  });

  it('every entry is actually exercised below', () => {
    // Guards the loop that generates the cases: an entry the harness silently
    // skips would be worse than no entry, since the file would claim a check that
    // never runs.
    const declared = validated.reduce((n, c) => n + (c.validation?.length ?? 0), 0);
    expect(cases.length).toBe(declared);
  });
});

interface Case {
  compound: Compound;
  observation: NonNullable<Compound['validation']>[number];
  label: string;
}

const cases: Case[] = validated.flatMap((compound) =>
  (compound.validation ?? []).map((observation) => ({
    compound,
    observation,
    label: `${compound.id} ${observation.kind} on ${observation.route} at ${observation.dose.value} ${observation.dose.unit}`,
  })),
);

/** What the model says: the peak of the single-dose curve, in canonical units. */
function modelled(c: Case): { value: number; unit: 'mg/L' | 'h' } {
  const { compound, observation } = c;
  const doseMg = mass.toCanonical(observation.dose.value, observation.dose.unit as MassUnit);
  const curve = buildCurve({
    compound,
    route: observation.route,
    schedule: singleDose(doseMg),
    infusionDuration: observation.infusionDurationH,
    // A fine grid so the sampled peak is the curve's peak, not the grid's best
    // guess at it. (`criticalTimes` pins the analytic peak instant for a single
    // dose anyway; this removes the question.)
    samples: 4000,
  });
  return observation.kind === 'cmax'
    ? { value: curve.peak.c, unit: 'mg/L' }
    : { value: curve.peak.t, unit: 'h' };
}

/** What the source says, in the same canonical units. */
function reported(c: Case): { value?: number; range?: [number, number] } {
  const { observation } = c;
  const toCanonical = (x: number) =>
    observation.kind === 'cmax'
      ? concentration.toCanonical(x, observation.unit as ConcentrationUnit)
      : time.toCanonical(x, observation.unit as TimeUnit);
  return {
    value: observation.value === undefined ? undefined : toCanonical(observation.value),
    range:
      observation.range === undefined
        ? undefined
        : [toCanonical(observation.range[0]), toCanonical(observation.range[1])],
  };
}

/**
 * The miss, as a fraction: 0 when the model lands on the reported value (or
 * anywhere inside the reported range), otherwise the relative distance to the
 * nearest thing the source actually reported.
 *
 * A range is treated as a region of agreement rather than as a point: a source
 * reporting 37–83 ng/mL has not claimed 60, and scoring against a midpoint would
 * invent a precision it does not have. When a source gives BOTH (a mean and a
 * spread) the point value wins, because that is the number it is asserting.
 */
function relativeMiss(modelValue: number, target: { value?: number; range?: [number, number] }) {
  if (target.value !== undefined) {
    return Math.abs(modelValue - target.value) / target.value;
  }
  const [low, high] = target.range!;
  if (modelValue >= low && modelValue <= high) return 0;
  return modelValue < low ? (low - modelValue) / low : (modelValue - high) / high;
}

describe('the built curve reproduces what was measured', () => {
  for (const c of cases) {
    it(c.label, () => {
      const model = modelled(c);
      const target = reported(c);
      const miss = relativeMiss(model.value, target);

      const shown =
        target.value !== undefined
          ? `${target.value} ${model.unit}`
          : `${target.range![0]}–${target.range![1]} ${model.unit}`;
      expect(
        miss,
        `${c.label}: the curve gives ${model.value.toPrecision(4)} ${model.unit}, the source reports ${shown} — a ${(miss * 100).toFixed(1)}% miss against a stated tolerance of ${(c.observation.tolerance * 100).toFixed(0)}%. Fix the model or the parameters; do NOT widen the tolerance to fit. (${c.observation.conditions})`,
      ).toBeLessThanOrEqual(c.observation.tolerance);
    });
  }

  /**
   * The other half of honesty about tolerance: a tolerance far LOOSER than the
   * model needs is a claim that the check is weak when it is not, and it hides
   * a regression inside its own slack. Every entry must be within a factor of
   * three of the miss it actually admits — i.e. a 30% tolerance over a 2% miss
   * is a bug in the entry, not a safety margin.
   */
  it('no entry hides behind a tolerance it does not need', () => {
    const slack = cases
      .map((c) => ({
        label: c.label,
        miss: relativeMiss(modelled(c).value, reported(c)),
        tol: c.observation.tolerance,
      }))
      .filter(({ miss, tol }) => tol > 0.05 && miss * 3 < tol);
    expect(slack, `tolerances loose enough to hide a regression: ${JSON.stringify(slack)}`).toEqual(
      [],
    );
  });
});
