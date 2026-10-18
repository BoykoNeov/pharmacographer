/**
 * The first-order absorption every resolver fills for a route the engine treats
 * as `oral`: the bioavailable fraction `F`, and the absorption constant `ka` —
 * read from the route's own block, or (linear models only) inverted from a
 * reported Tmax through the model's own peak solve.
 */

import { rateConstant, time } from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';
import { bioavailabilityLabel, type absorptionRouteOf } from './routes.ts';
import { asFraction, fmt } from './shared.ts';
import type { DeriveWarning, DerivedNote } from './types.ts';

/** The absorption block a first-order route reads (see `absorptionRouteOf`). */
type AbsorptionBlock = ReturnType<typeof absorptionRouteOf>;

/**
 * How one linear model turns a reported Tmax into `ka`. The inversion and the
 * flip-flop test are the model's own, and deliberately not unified: a
 * one-compartment curve is flip-flop when `Tmax > 1/ke`, a multi-compartment one
 * when `ka` falls below the TERMINAL rate (β or γ), and they say so differently.
 */
export interface TmaxInversion {
  /** `ka` (1/h) whose curve on this disposition peaks at `tmaxH`. */
  invert: (tmaxH: number) => number;
  /** What the note says `ka` was estimated against, e.g. `ke` or `the α/β disposition`. */
  against: string;
  /** This model's flip-flop warning for the recovered `ka`, or `undefined`. */
  flipFlop: (ka: number, tmaxH: number) => string | undefined;
}

/**
 * Resolve `F` (a fraction) for a first-order route. A missing value is assumed
 * 1, which is recorded both as a derived value and as a warning: it overstates
 * exposure for any drug that is not completely absorbed.
 */
export function resolveF(
  absorption: AbsorptionBlock,
  route: DataRoute,
  derived: DerivedNote[],
  warnings: DeriveWarning[],
): number {
  if (absorption?.F && absorption.F.value !== null) {
    return asFraction({ value: absorption.F.value, unit: absorption.F.unit });
  }
  warnings.push({
    parameter: 'F',
    message: `${bioavailabilityLabel(route)} not provided; assuming F = 1, which overestimates exposure for an incompletely absorbed drug`,
  });
  derived.push({ parameter: 'F', note: 'F assumed 1 (no value provided)' });
  return 1;
}

/** A cited `ka` in 1/h, or `undefined` when the route block carries none. */
export function statedKa(absorption: AbsorptionBlock): number | undefined {
  if (absorption?.ka && absorption.ka.value !== null) {
    return rateConstant.toCanonical(absorption.ka.value, absorption.ka.unit);
  }
  return undefined;
}

/**
 * Resolve `ka` for a LINEAR model: the cited value, else the reported Tmax
 * inverted through `inversion`. Throws, naming `resolver`, when the route block
 * carries neither.
 */
export function resolveKaLinear(
  absorption: AbsorptionBlock,
  compound: Compound,
  route: DataRoute,
  resolver: string,
  inversion: TmaxInversion,
  derived: DerivedNote[],
  warnings: DeriveWarning[],
): number {
  const stated = statedKa(absorption);
  if (stated !== undefined) return stated;

  if (absorption?.tmax && absorption.tmax.value !== null) {
    const tmaxH = time.toCanonical(absorption.tmax.value, absorption.tmax.unit);
    const ka = inversion.invert(tmaxH);
    derived.push({
      parameter: 'ka',
      note: `ka = ${fmt(ka)} 1/h estimated from Tmax ${fmt(absorption.tmax.value)} ${absorption.tmax.unit} and ${inversion.against}`,
    });
    const flipFlop = inversion.flipFlop(ka, tmaxH);
    if (flipFlop) warnings.push({ parameter: 'ka', message: flipFlop });
    return ka;
  }

  throw new Error(
    `${resolver}: ${route} route for "${compound.id}" needs either ka or tmax to determine absorption`,
  );
}
