/**
 * Display formatting: significant figures, percentages, and the chart's
 * concentration-unit toggle. All curve math stays in canonical mg/L.
 */

import { concentration } from '../../engine/units.ts';

/** Format a number to `sig` significant figures, trimming trailing zeros. */
export function fmtNum(x: number, sig = 3): string {
  if (!Number.isFinite(x)) return '—';
  return Number(x.toPrecision(sig)).toString();
}

/**
 * Format a fraction in [0, 1] as a percentage. Bioavailability is stored and
 * computed as a fraction (canonical) but is universally READ as a percent — "F
 * 29%" is the form every label and paper states, and "0.292" invites the reader
 * to wonder what it is a fraction of.
 */
export function fmtPercent(fraction: number, sig = 3): string {
  return `${fmtNum(fraction * 100, sig)}%`;
}

/**
 * Concentration display units offered by the chart's unit toggle (handoff §15
 * #6). All curve math stays in canonical mg/L; these are display-only. The three
 * chosen units differ by powers of ten (µg/mL ≡ mg/L; ng/mL = mg/L × 1000), a
 * deliberate teaching point — switching mg/L ↔ µg/mL must not move the number.
 */
export const CONCENTRATION_UNITS = ['mg/L', 'µg/mL', 'ng/mL'] as const;
export type ConcentrationDisplayUnit = (typeof CONCENTRATION_UNITS)[number];

/**
 * Convert a canonical mg/L concentration into a chosen display unit. Because
 * every offered unit is a power-of-ten factor, decade ticks generated in mg/L
 * remain decade ticks after conversion — the chart relies on this to keep its
 * semi-log gridlines round in any unit.
 */
export function toDisplayConcentration(mgPerL: number, unit: ConcentrationDisplayUnit): number {
  return concentration.fromCanonical(mgPerL, unit);
}
