/**
 * Synthetic compound fixtures for the data-layer tests.
 *
 * These use clean ROUND numbers, NOT any shipped compound's real values — the
 * derivation math must be proven against analytic oracles, never coupled to
 * whether acetaminophen's t½ happens to be 2.5 h (handoff §10; advisor note).
 * Each call returns a fresh object so a test can mutate it freely.
 */

/** A minimal valid raw compound (IV bolus only) ready to mutate per-test. */
export function baseRawCompound(): Record<string, unknown> {
  return {
    id: 'testdrug',
    schemaVersion: 1,
    names: { usan: 'Testdrug' },
    model: 'one_compartment_first_order',
    linear: true,
    disposition: {
      halfLife: { value: 4, unit: 'h', derived: false, sourceRef: 'ref' },
      vd: { value: 0.5, unit: 'L/kg', derived: false, sourceRef: 'ref' },
    },
    routes: {
      iv_bolus: {
        available: true,
        F: { value: 1, unit: 'fraction', derived: false, sourceRef: 'definition' },
      },
    },
    sources: { ref: { type: 'test', title: 'Synthetic test source' } },
    notes: 'synthetic fixture — not a real compound',
  };
}
