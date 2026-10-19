import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import type { Compound } from '../../src/data/schema.ts';
import { resolveTransdermalInput } from '../../src/data/derive.ts';
import { buildCurve, type DoseSchedule } from '../../src/ui/curve.ts';
import {
  REFERENCE_WEIGHT_KG,
  concentration,
  mass,
  massRate,
  time,
} from '../../src/engine/units.ts';
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
 * `validation` entry on each compound: build the curve the source's conditions
 * describe — the single dose, the regimen, or the patch — on the route the source
 * used, and require it to land where the source said it did. A steady state is
 * not assumed after some fixed number of doses: the checker keeps dosing until
 * the curve stops moving, and fails if it never does.
 *
 * Three things it deliberately does NOT do.
 *
 * - **It does not replace the four bespoke tests**, and should not absorb them as
 *   they stand: they assert things a declarative entry cannot say (a decline that
 *   is straight, a steady state that is superlinear in dose rate, a plateau
 *   reached on the label's timescale). Clonidine's plateaus are now entries here
 *   AND its test still checks the approach; that overlap is on purpose.
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
  'acyclovir',
  'allopurinol',
  'amoxicillin',
  'cetirizine',
  'clonidine',
  'dextroamphetamine',
  'diazepam',
  'digitoxin',
  'diphenhydramine',
  'famotidine',
  'fluconazole',
  'levofloxacin',
  'lorazepam',
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

type Observation = NonNullable<Compound['validation']>[number];
type Kind = Observation['kind'];
type ObservationOf<K extends Kind> = Extract<Observation, { kind: K }>;

interface Case {
  compound: Compound;
  observation: Observation;
  label: string;
}

/** The dose, in canonical mg; a per-kg dose is scaled against the reference subject. */
function doseMg(dose: ObservationOf<'cmax'>['dose']): number {
  return dose.unit === 'mg/kg'
    ? dose.value * REFERENCE_WEIGHT_KG
    : mass.toCanonical(dose.value, dose.unit as MassUnit);
}

/** What each kind was given, for the test name. A `Record` so a new kind must say. */
const DESCRIBE: { [K in Kind]: (o: ObservationOf<K>) => string } = {
  cmax: (o) => `${o.dose.value} ${o.dose.unit}`,
  tmax: (o) => `${o.dose.value} ${o.dose.unit}`,
  cmax_ss: (o) => `${o.dose.value} ${o.dose.unit} q${o.intervalH}h`,
  trough_ss: (o) => `${o.dose.value} ${o.dose.unit} q${o.intervalH}h`,
  plateau: (o) => `${o.deliveryRate.value} ${o.deliveryRate.unit}`,
};

const cases: Case[] = validated.flatMap((compound) =>
  (compound.validation ?? []).map((observation) => ({
    compound,
    observation,
    label: `${compound.id} ${observation.kind} on ${observation.route} at ${(DESCRIBE[observation.kind] as (o: Observation) => string)(observation)}`,
  })),
);

/**
 * How close two successive estimates of a steady state must be before the checker
 * calls it reached: 0.01%, far inside any tolerance an entry states, so the
 * convergence error can never be what decides a pass.
 */
const STEADY_STATE_REL_TOL = 1e-4;
/**
 * Doses the checker will give before declaring that a regimen never settles. A
 * linear drug converges geometrically, so this is only reached by a regimen that
 * genuinely has no steady state — a Michaelis–Menten drug dosed faster than its
 * `Vmax` — and failing there is the correct answer, not a limit to raise.
 */
const MAX_DOSES = 1024;
/** Grid points per dosing interval, so the sampled peak does not depend on how many doses were given. */
const SAMPLES_PER_INTERVAL = 1000;
/**
 * The grid for a course read only at its trough. The trough is a dose instant,
 * which every builder samples exactly whatever the grid, so density buys it
 * nothing (the ODE path sizes its own steps from `maxStep`, not from the grid).
 * It costs a great deal: building is superlinear in points, and a long-half-life
 * drug needs a long course to converge — digitoxin's takes 128 daily doses, and
 * the peak grid made that one case ~110 s, past every test timeout.
 */
const TROUGH_SAMPLES_PER_INTERVAL = 10;

/** What a steady-state kind reads off the interval. A `Record`, so a new kind must say. */
const STEADY_STATE_READS: { [K in 'cmax_ss' | 'trough_ss']: 'peak' | 'trough' } = {
  cmax_ss: 'peak',
  trough_ss: 'trough',
};

const relChange = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/**
 * Peak and pre-dose trough of the `n`th (last) interval of a regular course, read
 * off the built curve.
 *
 * The trough is the concentration AT the instant the next dose would be given.
 * Reading it from the sample "a hair before" a real next dose does not work: the
 * builders place that sample at a fixed fraction of the horizon, so it slides
 * earlier as the course lengthens, and the trough never converges (it drifted
 * 0.3% between 8 and 64 doses of acyclovir, 30 times the convergence bound). So
 * the course ends at dose `n`, and a ZERO-amount dose is added at `n·τ`. It puts
 * no drug in (every model sums or integrates dose amounts, and 0 adds nothing),
 * but every builder samples a dose instant exactly. Its value there is the
 * left-hand limit even on an IV bolus, whose jump at that instant is a jump of 0.
 */
function intervalAt(
  compound: Compound,
  o: ObservationOf<'cmax_ss' | 'trough_ss'>,
  n: number,
  samplesPerInterval: number,
) {
  const tau = o.intervalH;
  const start = (n - 1) * tau;
  const end = n * tau;
  const curve = buildCurve({
    compound,
    route: o.route,
    schedule: {
      amount: doseMg(o.dose),
      count: n,
      interval: tau,
      adHoc: [{ time: end, amount: 0 }],
    },
    infusionDuration: o.infusionDurationH,
    samples: samplesPerInterval * (n + 2),
  });
  const inside = curve.points.filter((p) => p.t >= start && p.t <= end);
  const atEnd = inside.at(-1);
  if (!atEnd || Math.abs(atEnd.t - end) > 1e-9) {
    throw new Error(`${compound.id}: no sample at the trough instant ${end} h`);
  }
  return { peak: Math.max(...inside.map((p) => p.c)), trough: atEnd.c };
}

/**
 * The steady-state interval, PROVEN reached rather than assumed: the course is
 * doubled until the trough stops moving — and, for a peak observation, the peak
 * too — then a peak is re-read on a grid twice as fine to show it is the curve's
 * and not the grid's (the oral critical-time mark sits at the SINGLE-dose Tmax,
 * which is not where a steady-state peak falls). A trough observation never
 * reads the peak, so it neither waits on it nor pays for its grid.
 */
function steadyState(compound: Compound, o: ObservationOf<'cmax_ss' | 'trough_ss'>) {
  const readsPeak = STEADY_STATE_READS[o.kind] === 'peak';
  const samples = readsPeak ? SAMPLES_PER_INTERVAL : TROUGH_SAMPLES_PER_INTERVAL;
  let previous = intervalAt(compound, o, 2, samples);
  for (let n = 4; n <= MAX_DOSES; n *= 2) {
    const current = intervalAt(compound, o, n, samples);
    if (
      (!readsPeak || relChange(current.peak, previous.peak) < STEADY_STATE_REL_TOL) &&
      relChange(current.trough, previous.trough) < STEADY_STATE_REL_TOL
    ) {
      if (!readsPeak) return current;
      const finer = intervalAt(compound, o, n, 2 * SAMPLES_PER_INTERVAL);
      if (relChange(finer.peak, current.peak) >= STEADY_STATE_REL_TOL) {
        throw new Error(`${compound.id}: the steady-state peak still moves with the grid`);
      }
      return current;
    }
    previous = current;
  }
  throw new Error(
    `${compound.id}: ${o.dose.value} ${o.dose.unit} every ${o.intervalH} h has not reached steady state after ${MAX_DOSES} doses`,
  );
}

/**
 * A patch's plateau: the concentration at the end of one continuous wear, and
 * proof that it IS a plateau — the last day of wear may move it by no more than
 * 0.1%. A patch whose curve is still climbing at removal has no steady state to
 * compare, however close its last point happens to land.
 */
function plateau(compound: Compound, o: ObservationOf<'plateau'>) {
  const patch = resolveTransdermalInput(compound);
  if (!patch) throw new Error(`${compound.id}: a plateau observation needs a transdermal route`);
  const rateMgPerH = massRate.toCanonical(o.deliveryRate.value, o.deliveryRate.unit);
  const curve = buildCurve({
    compound,
    route: 'transdermal',
    schedule: singleDose(rateMgPerH * patch.wearDurationH),
    samples: 4000,
  });
  const end = curve.points.at(-1)!;
  const dayBefore = curve.points.find((p) => p.t >= end.t - 24)!;
  if (relChange(dayBefore.c, end.c) >= 1e-3) {
    throw new Error(
      `${compound.id}: still ${dayBefore.c < end.c ? 'rising' : 'falling'} on the last day of wear — not a plateau`,
    );
  }
  return end.c;
}

/** A single-dose curve, for the two single-dose kinds. */
function singleDoseCurve(compound: Compound, o: ObservationOf<'cmax' | 'tmax'>) {
  return buildCurve({
    compound,
    route: o.route,
    schedule: singleDose(doseMg(o.dose)),
    infusionDuration: o.infusionDurationH,
    // A fine grid so the sampled peak is the curve's peak, not the grid's best
    // guess at it. (`criticalTimes` pins the analytic peak instant for a single
    // dose anyway; this removes the question.)
    samples: 4000,
  });
}

/**
 * What the model says, per kind, in canonical units. An exhaustive `Record`, not a
 * ternary: a sixth kind must say what it measures or fail to compile, rather than
 * being scored — confidently — as whichever kind the last branch handled.
 */
const MODELLED: {
  [K in Kind]: (compound: Compound, o: ObservationOf<K>) => { value: number; unit: 'mg/L' | 'h' };
} = {
  cmax: (compound, o) => ({ value: singleDoseCurve(compound, o).peak.c, unit: 'mg/L' }),
  tmax: (compound, o) => ({ value: singleDoseCurve(compound, o).peak.t, unit: 'h' }),
  cmax_ss: (compound, o) => ({ value: steadyState(compound, o).peak, unit: 'mg/L' }),
  trough_ss: (compound, o) => ({ value: steadyState(compound, o).trough, unit: 'mg/L' }),
  plateau: (compound, o) => ({ value: plateau(compound, o), unit: 'mg/L' }),
};

/** Built once per case: the steady-state cases are the expensive ones, and two tests read them. */
const modelledCache = new Map<Case, { value: number; unit: 'mg/L' | 'h' }>();
function modelled(c: Case): { value: number; unit: 'mg/L' | 'h' } {
  let result = modelledCache.get(c);
  if (!result) {
    const build = MODELLED[c.observation.kind] as (
      compound: Compound,
      o: Observation,
    ) => { value: number; unit: 'mg/L' | 'h' };
    result = build(c.compound, c.observation);
    modelledCache.set(c, result);
  }
  return result;
}

/** What the source says, in the same canonical units. */
function reported(c: Case): { value?: number; range?: [number, number] } {
  const { observation } = c;
  // Converted in whatever quantity the model answered in, so the two sides of the
  // comparison cannot disagree about whether a kind is a time or a concentration.
  const toCanonical = (x: number) =>
    modelled(c).unit === 'h'
      ? time.toCanonical(x, observation.unit as TimeUnit)
      : concentration.toCanonical(x, observation.unit as ConcentrationUnit);
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
