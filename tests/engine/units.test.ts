import { describe, expect, it } from 'vitest';
import {
  REFERENCE_WEIGHT_KG,
  absoluteVdFromPerKg,
  clearance,
  concentration,
  mass,
  rateConstant,
  time,
  volume,
} from '../../src/engine/units.ts';

const REL_TOL = 1e-12;

/** Asserts a → canonical → back to a is the identity (within fp tolerance). */
function expectRoundTrip<U extends string>(
  conv: {
    toCanonical: (v: number, u: U) => number;
    fromCanonical: (v: number, u: U) => number;
    units: U[];
  },
  sample = 12.5,
) {
  for (const unit of conv.units) {
    const canonical = conv.toCanonical(sample, unit);
    const back = conv.fromCanonical(canonical, unit);
    expect(back).toBeCloseTo(sample, 12);
  }
}

describe('units round-trips', () => {
  it('mass round-trips through canonical mg', () => expectRoundTrip(mass));
  it('concentration round-trips through canonical mg/L', () => expectRoundTrip(concentration));
  it('time round-trips through canonical h', () => expectRoundTrip(time));
  it('volume round-trips through canonical L', () => expectRoundTrip(volume));
  it('rateConstant round-trips through canonical 1/h', () => expectRoundTrip(rateConstant));
  it('clearance round-trips through canonical L/h', () => expectRoundTrip(clearance));
});

describe('canonical concentration equivalences (handoff §6)', () => {
  it('mg/L ≡ µg/mL ≡ ng/µL (factor 1)', () => {
    expect(concentration.toCanonical(5, 'mg/L')).toBe(5);
    expect(concentration.toCanonical(5, 'µg/mL')).toBe(5);
    expect(concentration.toCanonical(5, 'ng/µL')).toBe(5);
  });

  it('ng/mL ≡ µg/L = 1e-3 mg/L', () => {
    expect(concentration.toCanonical(1000, 'ng/mL')).toBeCloseTo(1, REL_TOL);
    expect(concentration.toCanonical(1000, 'µg/L')).toBeCloseTo(1, REL_TOL);
  });
});

describe('time conversions', () => {
  it('60 min = 1 h', () => expect(time.toCanonical(60, 'min')).toBeCloseTo(1, REL_TOL));
  it('1 day = 24 h', () => expect(time.toCanonical(1, 'day')).toBe(24));
});

describe('rate constant conversions', () => {
  it('1/min = 60 1/h', () => expect(rateConstant.toCanonical(1, '1/min')).toBe(60));
});

describe('clearance conversions', () => {
  it('1 mL/min = 0.06 L/h', () =>
    expect(clearance.toCanonical(1, 'mL/min')).toBeCloseTo(0.06, REL_TOL));
});

describe('Vd scaling (L/kg → absolute L)', () => {
  it('uses the 70 kg illustrative reference subject by default', () => {
    expect(REFERENCE_WEIGHT_KG).toBe(70);
    expect(absoluteVdFromPerKg(0.95)).toBeCloseTo(66.5, REL_TOL);
  });

  it('accepts an explicit weight override', () => {
    expect(absoluteVdFromPerKg(1, 50)).toBe(50);
  });
});
