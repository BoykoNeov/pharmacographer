/**
 * Helpers the linear resolvers share: number formatting for notes, the
 * model↔linearity gate, and per-kg scaling of volumes and clearances.
 */

import {
  absoluteVdFromPerKg,
  clearance as clearanceConverter,
  type ClearanceUnit,
} from '../../engine/units.ts';
import { NONLINEAR_MODELS, type Compound } from '../schema.ts';
import type { DerivedNote } from './types.ts';

/** Trim a computed number to a readable precision for notes/messages. */
export function fmt(x: number): string {
  return Number(x.toPrecision(4)).toString();
}

/**
 * The compound's linear `disposition` block, or a thrown error.
 *
 * `disposition` is schema-optional ONLY because a Michaelis–Menten compound has
 * no half-life to state and carries `dispositionMM` instead; every linear model
 * requires it, and the schema enforces that. So a linear resolver arriving here
 * without one means the object skipped validation — a programming error worth a
 * clear message rather than a `TypeError` deep in a converter.
 */
export function requireDisposition(compound: Compound): NonNullable<Compound['disposition']> {
  const disposition = compound.disposition;
  if (!disposition) {
    throw new Error(
      `"${compound.id}" (model "${compound.model}") has no disposition block; only a Michaelis–Menten compound may omit one, and it is resolved by deriveParamsMM`,
    );
  }
  return disposition;
}

/**
 * Guard the model↔linearity contract at the derivation boundary, for a resolver
 * that can only handle LINEAR kinetics.
 *
 * The reject is on the MODEL, not on `linear`: `linear: false` no longer means
 * "excluded" (Michaelis–Menten compounds are nonlinear and ship — see
 * {@link NONLINEAR_MODELS}), it means "superposition is invalid", which is
 * decided by the model. So the model check comes first and names the resolver
 * that CAN handle the compound; the `linear` check that follows catches only the
 * contradictory case — a linear model whose file claims superposition is invalid
 * — which the schema also rejects, but which a hand-built object could reach.
 */
export function assertLinearModel(
  compound: Compound,
  expected: Compound['model'],
  resolver: string,
): void {
  if (compound.model !== expected) {
    const handler = NONLINEAR_MODELS.has(compound.model)
      ? 'deriveParamsMM'
      : 'deriveParams / deriveParams2c / deriveParams3c';
    throw new Error(
      `${resolver}: "${compound.id}" uses model "${compound.model}"; this resolver handles only ${expected}. Use ${handler} (handoff §12).`,
    );
  }
  if (!compound.linear) {
    throw new Error(
      `${resolver}: "${compound.id}" is marked linear: false, which contradicts its model "${expected}" — linear kinetics are a property of that model. Superposition is the only mechanism the linear engine has, so a genuinely nonlinear compound must declare a nonlinear model and be resolved by deriveParamsMM (handoff §8, §12).`,
    );
  }
}

/** Resolve a volume parameter to absolute litres, noting any per-kg scaling. */
export function resolveVolumeParam(
  param: { value: number; unit: string },
  label: string,
  key: string,
  weightKg: number,
  derived: DerivedNote[],
): number {
  if (param.unit === 'L/kg') {
    const absolute = absoluteVdFromPerKg(param.value, weightKg);
    derived.push({
      parameter: key,
      note: `${label} ${fmt(param.value)} L/kg scaled to ${fmt(absolute)} L using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }
  return param.value; // already absolute litres
}

/** Resolve a clearance parameter to absolute L/h, noting any per-kg scaling. */
export function resolveClearanceParam(
  param: { value: number; unit: string },
  label: string,
  key: string,
  weightKg: number,
  derived: DerivedNote[],
): number {
  if (param.unit === 'L/h/kg') {
    const absolute = param.value * weightKg;
    derived.push({
      parameter: key,
      note: `${label} ${fmt(param.value)} L/h/kg scaled to ${fmt(absolute)} L/h using the ${weightKg} kg illustrative reference subject`,
    });
    return absolute;
  }
  // Every non-per-kg schema clearance unit is an engine ClearanceUnit.
  return clearanceConverter.toCanonical(param.value, param.unit as ClearanceUnit);
}
