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

/**
 * A minimal valid raw TWO-COMPARTMENT compound (handoff §12) ready to mutate
 * per-test. Clean round numbers in ABSOLUTE units so the derivation is easy to
 * check: CL = 5 L/h, Vc = 10 L, Q = 10 L/h, Vp = 20 L. Still carries the
 * one-compartment `disposition` block (terminal t½ + Vss) alongside, as a real
 * 2-comp compound would, for the caption/provenance rows.
 */
export function baseRawTwoCompCompound(): Record<string, unknown> {
  return {
    id: 'testdrug2c',
    schemaVersion: 1,
    names: { usan: 'Testdrug2C' },
    model: 'two_compartment_first_order',
    linear: true,
    disposition: {
      halfLife: { value: 5.17, unit: 'h', derived: true, sourceRef: 'ref' },
      vd: { value: 30, unit: 'L', derived: true, sourceRef: 'ref' },
    },
    disposition2c: {
      clearance: { value: 5, unit: 'L/h', derived: false, sourceRef: 'ref' },
      centralVd: { value: 10, unit: 'L', derived: false, sourceRef: 'ref' },
      interCompartmentalClearance: { value: 10, unit: 'L/h', derived: false, sourceRef: 'ref' },
      peripheralVd: { value: 20, unit: 'L', derived: false, sourceRef: 'ref' },
    },
    routes: {
      iv_bolus: {
        available: true,
        F: { value: 1, unit: 'fraction', derived: false, sourceRef: 'definition' },
      },
    },
    sources: { ref: { type: 'test', title: 'Synthetic test source' } },
    notes: 'synthetic 2-compartment fixture — not a real compound',
  };
}

/**
 * A minimal valid raw THREE-COMPARTMENT compound (handoff §12, Stage B) ready to
 * mutate per-test. Clean round numbers in ABSOLUTE units: CL = 5 L/h, Vc = 10 L,
 * Q2 = 10 L/h, Vp2 = 20 L, Q3 = 2 L/h, Vp3 = 40 L. Carries the one-compartment
 * `disposition` block (terminal t½ + Vss) alongside, as a real 3-comp compound would.
 */
export function baseRawThreeCompCompound(): Record<string, unknown> {
  return {
    id: 'testdrug3c',
    schemaVersion: 1,
    names: { usan: 'Testdrug3C' },
    model: 'three_compartment_first_order',
    linear: true,
    disposition: {
      halfLife: { value: 10, unit: 'h', derived: true, sourceRef: 'ref' },
      vd: { value: 70, unit: 'L', derived: true, sourceRef: 'ref' },
    },
    disposition3c: {
      clearance: { value: 5, unit: 'L/h', derived: false, sourceRef: 'ref' },
      centralVd: { value: 10, unit: 'L', derived: false, sourceRef: 'ref' },
      interCompartmentalClearance2: { value: 10, unit: 'L/h', derived: false, sourceRef: 'ref' },
      peripheralVd2: { value: 20, unit: 'L', derived: false, sourceRef: 'ref' },
      interCompartmentalClearance3: { value: 2, unit: 'L/h', derived: false, sourceRef: 'ref' },
      peripheralVd3: { value: 40, unit: 'L', derived: false, sourceRef: 'ref' },
    },
    routes: {
      iv_bolus: {
        available: true,
        F: { value: 1, unit: 'fraction', derived: false, sourceRef: 'definition' },
      },
    },
    sources: { ref: { type: 'test', title: 'Synthetic test source' } },
    notes: 'synthetic 3-compartment fixture — not a real compound',
  };
}
