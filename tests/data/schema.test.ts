import { describe, expect, it } from 'vitest';
import { CompoundSchema } from '../../src/data/schema.ts';
import dataGuide from '../../docs/DATA_GUIDE.md?raw';
import { baseRawCompound, baseRawTwoCompCompound } from './_fixtures.ts';

/**
 * The schema is a guardrail, not a formality (handoff §8): it must reject the
 * specific dishonest/typo shapes the compound files could drift into — unknown
 * keys, dangling source references, missing disposition, ranges that don't
 * contain their value, and a linear/nonlinear contradiction.
 */
describe('CompoundSchema validation', () => {
  it('accepts a minimal valid compound', () => {
    expect(CompoundSchema.safeParse(baseRawCompound()).success).toBe(true);
  });

  it('rejects unknown keys (strictObject catches typos)', () => {
    const raw = baseRawCompound();
    raw.halfLife = { value: 4 }; // misplaced: should live under disposition
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a sourceRef that is neither a source key nor a sentinel', () => {
    const raw = baseRawCompound();
    (raw.disposition as { halfLife: { sourceRef: string } }).halfLife.sourceRef = 'nonexistent';
    const result = CompoundSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /sourceRef/.test(i.message))).toBe(true);
    }
  });

  it('accepts the recognised sourceRef sentinels (definition, derived_from_tmax, derived_from_clearance)', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = {
      value: 35,
      unit: 'L',
      derived: true,
      sourceRef: 'derived_from_clearance',
    };
    (raw.routes as Record<string, Record<string, unknown>>).oral = {
      available: true,
      F: { value: 0.5, unit: 'fraction', derived: false, sourceRef: 'definition' },
      ka: { value: 1.0, unit: '1/h', derived: true, sourceRef: 'derived_from_tmax' },
    };
    expect(CompoundSchema.safeParse(raw).success).toBe(true);
  });

  it('rejects a missing required disposition parameter (vd)', () => {
    const raw = baseRawCompound();
    delete (raw.disposition as Record<string, unknown>).vd;
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a null value for a required parameter (halfLife)', () => {
    const raw = baseRawCompound();
    (raw.disposition as { halfLife: { value: number | null } }).halfLife.value = null;
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a value outside its declared range', () => {
    const raw = baseRawCompound();
    (raw.disposition as { halfLife: unknown }).halfLife = {
      value: 9,
      range: [1, 3],
      unit: 'h',
      derived: false,
      sourceRef: 'ref',
    };
    const result = CompoundSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /within range/.test(i.message))).toBe(true);
    }
  });

  it('rejects a disordered range [high, low]', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).halfLife = {
      value: 2,
      range: [3, 1],
      unit: 'h',
      derived: false,
      sourceRef: 'ref',
    };
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects an unknown unit for a parameter', () => {
    const raw = baseRawCompound();
    (raw.disposition as { halfLife: { unit: string } }).halfLife.unit = 'fortnights';
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects flags.nonlinear that contradicts linear', () => {
    const raw = baseRawCompound();
    raw.linear = true;
    raw.flags = { nonlinear: true }; // contradiction: must be the negation
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('accepts a consistent flags.nonlinear (negation of linear)', () => {
    const raw = baseRawCompound();
    raw.linear = true;
    raw.flags = { nonlinear: false };
    expect(CompoundSchema.safeParse(raw).success).toBe(true);
  });

  it('requires at least one human-facing name', () => {
    const raw = baseRawCompound();
    raw.names = {};
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });
});

/**
 * The metabolites slot is now a typed `MetaboliteSchema` (handoff §12): each
 * entry carries its own provenance-bearing fractionFormed / vd / halfLife, and
 * its sourceRefs must resolve into the same compound-level bibliography as every
 * other parameter. An omitted/empty array must stay valid (parent-only compound).
 */
describe('MetaboliteSchema validation', () => {
  /** A valid metabolite whose sourceRefs point at baseRawCompound's `ref` source. */
  function validMetabolite(): Record<string, unknown> {
    return {
      id: 'testmetabolite',
      name: 'Testmetabolite',
      active: true,
      fractionFormed: { value: 0.6, unit: 'fraction', derived: false, sourceRef: 'ref' },
      vd: { value: 1.2, unit: 'L/kg', derived: false, sourceRef: 'ref' },
      halfLife: { value: 30, unit: 'h', derived: false, sourceRef: 'ref' },
    };
  }

  it('accepts a compound with a valid metabolite', () => {
    const raw = baseRawCompound();
    raw.metabolites = [validMetabolite()];
    expect(CompoundSchema.safeParse(raw).success).toBe(true);
  });

  it('keeps an omitted or empty metabolites array valid (parent-only)', () => {
    const omitted = baseRawCompound();
    expect(CompoundSchema.safeParse(omitted).success).toBe(true);
    const empty = baseRawCompound();
    empty.metabolites = [];
    expect(CompoundSchema.safeParse(empty).success).toBe(true);
  });

  it('rejects a metabolite sourceRef that resolves to nothing', () => {
    const raw = baseRawCompound();
    const m = validMetabolite();
    (m.halfLife as { sourceRef: string }).sourceRef = 'nonexistent';
    raw.metabolites = [m];
    const result = CompoundSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /sourceRef/.test(i.message))).toBe(true);
    }
  });

  it('rejects an unknown key inside a metabolite (strictObject)', () => {
    const raw = baseRawCompound();
    const m = validMetabolite();
    m.clearance = { value: 1 }; // not a metabolite field
    raw.metabolites = [m];
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a metabolite missing a required parameter (fractionFormed)', () => {
    const raw = baseRawCompound();
    const m = validMetabolite();
    delete m.fractionFormed;
    raw.metabolites = [m];
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });
});

/**
 * Two-compartment compounds (handoff §12) must carry a `disposition2c` block iff
 * the model is `two_compartment_first_order`, with its four parameters' sourceRefs
 * resolving into the same bibliography as every other parameter.
 */
describe('Disposition2cSchema validation', () => {
  it('accepts a valid two-compartment compound', () => {
    expect(CompoundSchema.safeParse(baseRawTwoCompCompound()).success).toBe(true);
  });

  it('rejects a 2-comp compound missing its disposition2c block', () => {
    const raw = baseRawTwoCompCompound();
    delete raw.disposition2c;
    const result = CompoundSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /disposition2c/.test(i.message))).toBe(true);
    }
  });

  it('rejects a disposition2c block on a one-compartment compound (ignored block)', () => {
    const raw = baseRawCompound();
    raw.disposition2c = (baseRawTwoCompCompound() as { disposition2c: unknown }).disposition2c;
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects a dangling sourceRef inside disposition2c', () => {
    const raw = baseRawTwoCompCompound();
    (raw.disposition2c as { clearance: { sourceRef: string } }).clearance.sourceRef = 'nonexistent';
    const result = CompoundSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /sourceRef/.test(i.message))).toBe(true);
    }
  });

  it('rejects an unknown key inside disposition2c (strictObject)', () => {
    const raw = baseRawTwoCompCompound();
    (raw.disposition2c as Record<string, unknown>).k12 = { value: 1 }; // not a stored field
    expect(CompoundSchema.safeParse(raw).success).toBe(false);
  });
});

/**
 * The DATA_GUIDE abbreviated example is what curators copy from; if the schema
 * and the doc drift apart, contributors get bad guidance. Parse the actual
 * fenced JSON block out of the markdown and validate it, so they can't.
 */
describe('docs/DATA_GUIDE.md example stays valid', () => {
  it('the abbreviated JSON example parses and validates against the schema', () => {
    const match = dataGuide.match(/```json\n([\s\S]*?)```/);
    expect(match, 'DATA_GUIDE.md must contain a ```json example block').not.toBeNull();
    const example = JSON.parse(match![1]!);
    const result = CompoundSchema.safeParse(example);
    if (!result.success) {
      throw new Error(`DATA_GUIDE example failed schema:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.data.id).toBe('acetaminophen');
  });
});
