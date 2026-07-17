/**
 * Units policy (handoff §6).
 *
 * PK is a unit minefield (mg vs mg/kg, L vs L/kg, ng/mL vs µg/L, h vs min).
 * Rule: pick ONE canonical internal system and convert only at the edges —
 * input parsing and display. Never scatter conversion literals through the
 * codebase; every factor lives here.
 *
 * Canonical internal units:
 *   amount/dose ........ mg
 *   volume (Vd) ........ L
 *   concentration ...... mg/L   (≡ µg/mL ≡ ng/µL)
 *   time ............... h
 *   rate constant ...... 1/h
 *   clearance .......... L/h
 *   infusion rate ...... mg/h
 *
 * This module is pure: no I/O, no UI, no data imports.
 */

/**
 * Illustrative reference subject weight (kg), used to turn a literature Vd given
 * in L/kg into the absolute L the engine needs.
 *
 * This is an EDUCATIONAL ASSUMPTION, not a patient weight. The UI must always
 * label it as an illustrative reference subject and never frame it as
 * "your weight" or use it to produce a per-patient dose (handoff §1, §6).
 */
export const REFERENCE_WEIGHT_KG = 70;

/** Build a bidirectional converter from a table of "canonical units per 1 unit". */
function makeConverter<U extends string>(factors: Record<U, number>) {
  return {
    /** Convert a value expressed in `unit` into canonical units. */
    toCanonical: (value: number, unit: U): number => value * factors[unit],
    /** Convert a canonical value into `unit` for display. */
    fromCanonical: (value: number, unit: U): number => value / factors[unit],
    /** The unit names this converter understands. */
    units: Object.keys(factors) as U[],
  };
}

/** Mass / dose amount. Canonical: mg. */
export type MassUnit = 'mg' | 'g' | 'kg' | 'µg' | 'ug' | 'mcg' | 'ng';
export const mass = makeConverter<MassUnit>({
  mg: 1,
  g: 1_000,
  kg: 1_000_000,
  µg: 1e-3,
  ug: 1e-3,
  mcg: 1e-3,
  ng: 1e-6,
});

/** Concentration. Canonical: mg/L (≡ µg/mL ≡ ng/µL). */
export type ConcentrationUnit =
  | 'mg/L'
  | 'µg/mL'
  | 'ug/mL'
  | 'mcg/mL'
  | 'ng/µL'
  | 'mg/mL'
  | 'g/L'
  | 'µg/L'
  | 'ug/L'
  | 'ng/mL'
  | 'ng/L';
export const concentration = makeConverter<ConcentrationUnit>({
  'mg/L': 1,
  'µg/mL': 1,
  'ug/mL': 1,
  'mcg/mL': 1,
  'ng/µL': 1,
  'mg/mL': 1_000,
  'g/L': 1_000,
  'µg/L': 1e-3,
  'ug/L': 1e-3,
  'ng/mL': 1e-3,
  'ng/L': 1e-6,
});

/** Time. Canonical: h. */
export type TimeUnit = 'h' | 'hr' | 'hour' | 'min' | 'minute' | 's' | 'sec' | 'day' | 'd' | 'wk';
export const time = makeConverter<TimeUnit>({
  h: 1,
  hr: 1,
  hour: 1,
  min: 1 / 60,
  minute: 1 / 60,
  s: 1 / 3600,
  sec: 1 / 3600,
  day: 24,
  d: 24,
  wk: 168,
});

/** Volume of distribution (absolute). Canonical: L. */
export type VolumeUnit = 'L' | 'mL' | 'dL' | 'µL' | 'uL';
export const volume = makeConverter<VolumeUnit>({
  L: 1,
  mL: 1e-3,
  dL: 0.1,
  µL: 1e-6,
  uL: 1e-6,
});

/** First-order rate constant (ka, ke). Canonical: 1/h. */
export type RateConstantUnit = '1/h' | '1/min' | '1/day' | '1/d';
export const rateConstant = makeConverter<RateConstantUnit>({
  '1/h': 1,
  '1/min': 60,
  '1/day': 1 / 24,
  '1/d': 1 / 24,
});

/** Clearance. Canonical: L/h. */
export type ClearanceUnit = 'L/h' | 'L/min' | 'mL/min' | 'mL/h' | 'L/day';
export const clearance = makeConverter<ClearanceUnit>({
  'L/h': 1,
  'L/min': 60,
  'mL/min': 0.06,
  'mL/h': 1e-3,
  'L/day': 1 / 24,
});

/**
 * Mass rate — an amount of drug per unit time. Canonical: mg/h. Covers an
 * infusion rate `R0` and the Michaelis–Menten `Vmax` (the ceiling on how fast the
 * body can eliminate a saturable drug), which the literature commonly reports per
 * day: phenytoin's Vmax is usually printed as mg/kg/day (the per-kg forms are a
 * DATA-layer concept scaled against the reference subject during derivation — the
 * engine only ever sees absolute mg/h).
 */
export type MassRateUnit = 'mg/h' | 'g/h' | 'mg/min' | 'mg/day' | 'g/day';
export const massRate = makeConverter<MassRateUnit>({
  'mg/h': 1,
  'g/h': 1_000,
  'mg/min': 60,
  'mg/day': 1 / 24,
  'g/day': 1_000 / 24,
});

/**
 * Concentration rate — a concentration change per unit time. Canonical: mg/L/h.
 *
 * Needed because a saturable drug's `Vmax` is often reported NOT as a mass rate
 * but as the slope of its zero-order decline, `Vmax/Vd`. Ethanol is the standard
 * case: every clinical and forensic source gives its elimination rate as ~15–20
 * mg/dL/h (the "β60"), because blood-alcohol is measured in mg/dL (or g/dL — the
 * "0.08%" convention). Storing that citable number verbatim and multiplying by Vd
 * during derivation keeps the provenance honest; pre-converting it offline would
 * hide the arithmetic from the reader (docs/DATA_GUIDE.md).
 */
export type ConcentrationRateUnit = 'mg/L/h' | 'g/L/h' | 'mg/dL/h' | 'g/dL/h';
export const concentrationRate = makeConverter<ConcentrationRateUnit>({
  'mg/L/h': 1,
  'g/L/h': 1_000,
  // 1 dL = 0.1 L, so a per-dL concentration is ten times the per-L number.
  'mg/dL/h': 10,
  'g/dL/h': 10_000,
});

/**
 * Scale a volume of distribution given in L/kg to absolute litres using the
 * (illustrative) reference subject weight. Sources usually report Vd as L/kg,
 * but a concentration needs absolute Vd in L (handoff §6).
 */
export function absoluteVdFromPerKg(
  vdPerKg: number,
  weightKg: number = REFERENCE_WEIGHT_KG,
): number {
  return vdPerKg * weightKg;
}
