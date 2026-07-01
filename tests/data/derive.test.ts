import { describe, expect, it } from 'vitest';
import {
  KE_CROSSCHECK_REL_TOL,
  deriveMetaboliteParams,
  deriveParams,
  kaFromTmax,
} from '../../src/data/derive.ts';
import type { Metabolite } from '../../src/data/schema.ts';
import { parseCompound } from '../../src/data/loader.ts';
import { timeToPeak } from '../../src/engine/pk.ts';
import { REFERENCE_WEIGHT_KG } from '../../src/engine/units.ts';
import { baseRawCompound } from './_fixtures.ts';

/**
 * Derivation is validated against analytic oracles, not against any shipped
 * compound's numbers (handoff §10): ke = ln2/t½ and CL/Vd, Vd scaling by the
 * reference weight, and ka recovered from a Tmax then round-tripped back through
 * `timeToPeak`. The linearity gate (CLAUDE.md carry-forward) is asserted to throw.
 */

const ORAL_F_DEFINITION = {
  value: 1,
  unit: 'fraction',
  derived: false,
  sourceRef: 'definition',
};

describe('deriveParams — ke and Vd', () => {
  it('derives ke = ln2/t½ when no clearance is given, and scales Vd L/kg → L', () => {
    // t½ = 4 h, Vd = 0.5 L/kg.
    const compound = parseCompound(baseRawCompound());
    const { params, derived } = deriveParams(compound, 'iv_bolus');

    expect(params.ke).toBeCloseTo(Math.LN2 / 4, 12);
    expect(params.vd).toBeCloseTo(0.5 * REFERENCE_WEIGHT_KG, 12); // 35 L

    expect(derived.some((d) => d.parameter === 'vd' && /reference subject/.test(d.note))).toBe(true);
    expect(derived.some((d) => d.parameter === 'ke' && /ln2/.test(d.note))).toBe(true);
  });

  it('honours an absolute Vd in L without scaling', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = {
      value: 12,
      unit: 'L',
      derived: false,
      sourceRef: 'ref',
    };
    const { params, derived } = deriveParams(parseCompound(raw), 'iv_bolus');
    expect(params.vd).toBe(12);
    expect(derived.some((d) => d.parameter === 'vd')).toBe(false); // nothing to scale
  });

  it('prefers ke = CL/Vd when clearance is present, consistent with t½ (no warning)', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = { value: 10, unit: 'L', derived: false, sourceRef: 'ref' };
    (raw.disposition as Record<string, unknown>).clearance = { value: 2, unit: 'L/h', derived: false, sourceRef: 'ref' };
    (raw.disposition as { halfLife: { value: number } }).halfLife.value = Math.LN2 / 0.2; // ke ≈ 0.2 both ways
    const { params, warnings } = deriveParams(parseCompound(raw), 'iv_bolus');
    expect(params.ke).toBeCloseTo(0.2, 12); // CL/Vd = 2/10
    expect(warnings.some((w) => w.parameter === 'ke')).toBe(false);
  });

  it('warns when ke from clearance and ke from half-life disagree, and uses CL/Vd', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = { value: 10, unit: 'L', derived: false, sourceRef: 'ref' };
    (raw.disposition as Record<string, unknown>).clearance = { value: 2, unit: 'L/h', derived: false, sourceRef: 'ref' };
    (raw.disposition as { halfLife: { value: number } }).halfLife.value = 10; // ke ≈ 0.069, far from 0.2
    const { params, warnings } = deriveParams(parseCompound(raw), 'iv_bolus');
    expect(params.ke).toBeCloseTo(0.2, 12);
    expect(warnings.some((w) => w.parameter === 'ke')).toBe(true);
  });

  it('ke from CL/Vd is weight-independent (per-kg CL and per-kg Vd cancel)', () => {
    const raw = baseRawCompound();
    // Vd 0.5 L/kg, CL 0.1 L/h/kg ⇒ ke = 0.1/0.5 = 0.2 regardless of weight.
    (raw.disposition as Record<string, unknown>).clearance = { value: 0.1, unit: 'L/h/kg', derived: false, sourceRef: 'ref' };
    (raw.disposition as { halfLife: { value: number } }).halfLife.value = Math.LN2 / 0.2;
    const a = deriveParams(parseCompound(raw), 'iv_bolus', { weightKg: 50 });
    const b = deriveParams(parseCompound(raw), 'iv_bolus', { weightKg: 90 });
    expect(a.params.ke).toBeCloseTo(0.2, 12);
    expect(b.params.ke).toBeCloseTo(0.2, 12);
  });
});

describe('kaFromTmax — inversion of the oral Tmax relationship', () => {
  it('recovers ka from a Tmax computed for a known ka (ka > ke)', () => {
    const ke = 0.2;
    const ka = 1.3;
    const tmax = Math.log(ka / ke) / (ka - ke);
    expect(kaFromTmax(tmax, ke)).toBeCloseTo(ka, 8);
  });

  it('recovers ka in the flip-flop region (ka < ke, Tmax > 1/ke)', () => {
    const ke = 0.2;
    const ka = 0.05;
    const tmax = Math.log(ka / ke) / (ka - ke);
    expect(tmax).toBeGreaterThan(1 / ke);
    expect(kaFromTmax(tmax, ke)).toBeCloseTo(ka, 8);
  });

  it('returns ka = ke at the boundary Tmax = 1/ke', () => {
    const ke = 0.3;
    expect(kaFromTmax(1 / ke, ke)).toBeCloseTo(ke, 8);
  });
});

describe('deriveParams — oral absorption (ka, F)', () => {
  /** Build a valid oral compound raw with the given oral route block. */
  function oralRaw(oral: Record<string, unknown>): Record<string, unknown> {
    const raw = baseRawCompound();
    (raw.routes as Record<string, unknown>).oral = { available: true, ...oral };
    return raw;
  }

  it('estimates ka from Tmax and round-trips back through timeToPeak', () => {
    const raw = oralRaw({
      F: ORAL_F_DEFINITION,
      tmax: { value: 2, unit: 'h', derived: false, sourceRef: 'ref' },
    });
    const { params, derived } = deriveParams(parseCompound(raw), 'oral');
    expect(params.ka).toBeDefined();
    // The whole point: deriving ka from Tmax = 2 h must reproduce Tmax = 2 h.
    expect(timeToPeak(params)).toBeCloseTo(2, 6);
    expect(derived.some((d) => d.parameter === 'ka' && /Tmax/.test(d.note))).toBe(true);
  });

  it('uses a measured ka directly (converting its unit) without deriving', () => {
    const raw = oralRaw({
      F: ORAL_F_DEFINITION,
      ka: { value: 60, unit: '1/day', derived: false, sourceRef: 'ref' }, // 60/day = 2.5/h
    });
    const { params, derived } = deriveParams(parseCompound(raw), 'oral');
    expect(params.ka).toBeCloseTo(2.5, 12);
    expect(derived.some((d) => d.parameter === 'ka')).toBe(false);
  });

  it('warns about flip-flop kinetics when Tmax exceeds 1/ke', () => {
    // t½ = 4 h ⇒ ke ≈ 0.173 ⇒ 1/ke ≈ 5.77 h; Tmax = 8 h forces ka < ke.
    const raw = oralRaw({
      F: ORAL_F_DEFINITION,
      tmax: { value: 8, unit: 'h', derived: false, sourceRef: 'ref' },
    });
    const { params, warnings } = deriveParams(parseCompound(raw), 'oral');
    expect(params.ka!).toBeLessThan(params.ke);
    expect(warnings.some((w) => w.parameter === 'ka' && /flip-flop/.test(w.message))).toBe(true);
  });

  it('converts F given as a percent to a fraction', () => {
    const raw = oralRaw({
      F: { value: 80, unit: 'percent', derived: false, sourceRef: 'ref' },
      ka: { value: 1, unit: '1/h', derived: false, sourceRef: 'ref' },
    });
    expect(deriveParams(parseCompound(raw), 'oral').params.F).toBeCloseTo(0.8, 12);
  });

  it('assumes F = 1 with a warning when F is not provided', () => {
    const raw = oralRaw({ ka: { value: 1, unit: '1/h', derived: false, sourceRef: 'ref' } });
    const { params, warnings } = deriveParams(parseCompound(raw), 'oral');
    expect(params.F).toBe(1);
    expect(warnings.some((w) => w.parameter === 'F')).toBe(true);
  });

  it('throws for an oral curve with neither ka nor tmax', () => {
    const raw = oralRaw({ F: ORAL_F_DEFINITION });
    expect(() => deriveParams(parseCompound(raw), 'oral')).toThrow(/ka or tmax/);
  });
});

describe('deriveParams — gates and warnings', () => {
  it('throws for a nonlinear compound (the linearity gate)', () => {
    const raw = baseRawCompound();
    raw.linear = false;
    expect(() => deriveParams(parseCompound(raw), 'iv_bolus')).toThrow(/nonlinear|linear/i);
  });

  it('warns that an unavailable route is inferred, not measured', () => {
    const raw = baseRawCompound();
    (raw.routes as { iv_bolus: { available: boolean } }).iv_bolus.available = false;
    const { warnings } = deriveParams(parseCompound(raw), 'iv_bolus');
    expect(warnings.some((w) => w.parameter === 'route' && /inferred/.test(w.message))).toBe(true);
  });

  it('warns for a route the compound does not declare at all', () => {
    // base has no iv_infusion entry → inferred route warning.
    const { warnings } = deriveParams(parseCompound(baseRawCompound()), 'iv_infusion');
    expect(warnings.some((w) => w.parameter === 'route')).toBe(true);
  });
});

describe('deriveMetaboliteParams — metabolite disposition', () => {
  /** Parse a compound carrying one metabolite and return that validated metabolite. */
  function metaboliteFrom(overrides: Record<string, unknown> = {}): Metabolite {
    const raw = baseRawCompound();
    raw.metabolites = [
      {
        id: 'testmetabolite',
        name: 'Testmetabolite',
        active: true,
        fractionFormed: { value: 0.6, unit: 'fraction', derived: false, sourceRef: 'ref' },
        vd: { value: 1.0, unit: 'L/kg', derived: false, sourceRef: 'ref' },
        halfLife: { value: 20, unit: 'h', derived: false, sourceRef: 'ref' },
        ...overrides,
      },
    ];
    return parseCompound(raw).metabolites![0]!;
  }

  it('derives keM = ln2/t½, scales Vd L/kg → L, and threads the parent ke', () => {
    const parentKe = 0.5;
    const { params, derived } = deriveMetaboliteParams(metaboliteFrom(), parentKe);
    expect(params.keM).toBeCloseTo(Math.LN2 / 20, 12);
    expect(params.vdM).toBeCloseTo(1.0 * REFERENCE_WEIGHT_KG, 12); // 70 L
    expect(params.keParent).toBe(parentKe);
    expect(params.fractionFormed).toBe(0.6);
    expect(derived.some((d) => d.parameter === 'vdM' && /reference subject/.test(d.note))).toBe(true);
    expect(derived.some((d) => d.parameter === 'keM' && /ln2/.test(d.note))).toBe(true);
  });

  it('honours an absolute metabolite Vd in L without scaling', () => {
    const m = metaboliteFrom({ vd: { value: 15, unit: 'L', derived: false, sourceRef: 'ref' } });
    const { params, derived } = deriveMetaboliteParams(m, 0.5);
    expect(params.vdM).toBe(15);
    expect(derived.some((d) => d.parameter === 'vdM')).toBe(false);
  });

  it('normalises a formation fraction given as a percent', () => {
    const m = metaboliteFrom({
      fractionFormed: { value: 45, unit: 'percent', derived: false, sourceRef: 'ref' },
    });
    expect(deriveMetaboliteParams(m, 0.5).params.fractionFormed).toBeCloseTo(0.45, 12);
  });

  it('warns when the formation fraction is outside (0, 1]', () => {
    const m = metaboliteFrom({
      fractionFormed: { value: 1.4, unit: 'fraction', derived: false, sourceRef: 'ref' },
    });
    const { warnings } = deriveMetaboliteParams(m, 0.5);
    expect(warnings.some((w) => w.parameter === 'fractionFormed')).toBe(true);
  });

  it('throws when the parent ke is not positive', () => {
    expect(() => deriveMetaboliteParams(metaboliteFrom(), 0)).toThrow(/parentKe/);
  });
});

// Referenced so the exported tolerance constant is covered as part of the contract.
describe('KE_CROSSCHECK_REL_TOL', () => {
  it('is a sensible positive fraction', () => {
    expect(KE_CROSSCHECK_REL_TOL).toBeGreaterThan(0);
    expect(KE_CROSSCHECK_REL_TOL).toBeLessThan(1);
  });
});
