/**
 * The provenance shapes every resolver returns alongside its parameters, and the
 * options they all take.
 */

/** One thing the derivation computed rather than read from a source. */
export interface DerivedNote {
  /** Which resolved parameter this concerns: 'vd' | 'ke' | 'ka' | 'F'. */
  parameter: string;
  /** Human-readable description of what was derived and how. */
  note: string;
}

/** A caution the UI should surface alongside the curve. */
export interface DeriveWarning {
  parameter: string;
  message: string;
}

/** Options controlling derivation. */
export interface DeriveOptions {
  /** Illustrative reference subject weight (kg) for scaling per-kg Vd / CL. */
  weightKg?: number;
}
