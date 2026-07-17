import { describe, expect, it } from 'vitest';
import { applyPhenotype, defaultPhenotypeId, deriveParams } from '../../src/data/derive.ts';
import { loadAllCompounds, parseCompound } from '../../src/data/loader.ts';
import { singleDoseAuc } from '../../src/engine/pk.ts';
import { baseRawCompound } from './_fixtures.ts';

/**
 * Phenotype presets (§12, "variability beyond half-life").
 *
 * The oracles here are closed-form, per CLAUDE.md — never snapshots. The two that
 * carry the feature are ratios that fall out of the analytic AUC identities, and
 * they point in OPPOSITE directions, which is the whole teaching payoff:
 *
 *   parent AUC   = F·D/(ke·Vd)          → slow/fast = t½_slow/t½_fast = 3.6/2.4 = 1.5
 *   NAPA AUC     = fm·F·D/(k_m·Vd_m)    → slow/fast = fm_slow/fm_fast = 23.6/47.2 = 0.5
 *
 * The metabolite one is the sharper of the two: its AUC is INDEPENDENT of the
 * parent's disposition (the Σcoef_λ/λ = D/CL identity cancels it), so even though
 * the slow phenotype also slows the parent, NAPA's exposure ratio is set by fm
 * alone. Slow acetylator ⇒ more parent, less metabolite.
 */

const procainamide = () => {
  const c = loadAllCompounds().find((x) => x.id === 'procainamide');
  if (!c) throw new Error('procainamide not found');
  return c;
};

describe('applyPhenotype — the identity default', () => {
  it('opens on the first preset, which is the fast acetylator', () => {
    expect(defaultPhenotypeId(procainamide())).toBe('fast-acetylator');
  });

  it('returns the SAME object for the default preset — the base compound is the default phenotype', () => {
    const c = procainamide();
    // Not toEqual: the default must be the base by construction (nothing applied),
    // which is what makes "presets did not change the shipped curve" provable
    // rather than a thing we re-derive and hope matches.
    expect(applyPhenotype(c, 'fast-acetylator')).toBe(c);
    expect(applyPhenotype(c)).toBe(c);
  });

  it('leaves a compound with no phenotypes block untouched', () => {
    const c = parseCompound(baseRawCompound());
    expect(applyPhenotype(c, undefined)).toBe(c);
    expect(defaultPhenotypeId(c)).toBeUndefined();
  });

  it('throws on an unknown phenotype id rather than silently falling back', () => {
    expect(() => applyPhenotype(procainamide(), 'ultrarapid')).toThrow(/not a phenotype/);
  });
});

describe('applyPhenotype — the slow preset swaps half-life and fm ATOMICALLY', () => {
  it('re-anchors both parameters together, and nothing else', () => {
    const fast = procainamide();
    const slow = applyPhenotype(fast, 'slow-acetylator');

    expect(fast.disposition?.halfLife.value).toBe(2.4);
    expect(slow.disposition?.halfLife.value).toBe(3.6);
    expect(fast.metabolites?.[0]?.fractionFormed.value).toBe(47.2);
    expect(slow.metabolites?.[0]?.fractionFormed.value).toBe(23.6);

    // Vd is acetylator-INDEPENDENT (Lima 1979), as is NAPA's own disposition —
    // a preset must not quietly move a parameter the polymorphism doesn't touch.
    expect(slow.disposition?.vd).toEqual(fast.disposition?.vd);
    expect(slow.metabolites?.[0]?.vd).toEqual(fast.metabolites?.[0]?.vd);
    expect(slow.metabolites?.[0]?.halfLife).toEqual(fast.metabolites?.[0]?.halfLife);
    expect(slow.routes).toEqual(fast.routes);

    // The mixed state — one phenotype's half-life with the other's fm — is what
    // this feature exists to make unreachable. Both moved, or neither did.
    expect(slow.disposition?.halfLife.value).not.toBe(fast.disposition?.halfLife.value);
    expect(slow.metabolites?.[0]?.fractionFormed.value).not.toBe(
      fast.metabolites?.[0]?.fractionFormed.value,
    );
  });

  it('keeps each phenotype variability band INSIDE its own phenotype', () => {
    // The documented catch: if a band spanned both phenotypes, the slider would
    // reach a half-life the pinned fm contradicts.
    const fastRange = procainamide().disposition?.halfLife.range;
    const slowRange = applyPhenotype(procainamide(), 'slow-acetylator').disposition?.halfLife.range;
    expect(fastRange).toEqual([1.7, 3.1]);
    expect(slowRange).toEqual([2.6, 4.6]);
    // Fast's band must never reach the slow POINT value, and vice versa.
    expect(fastRange![1]).toBeLessThan(3.6);
    expect(slowRange![0]).toBeGreaterThan(2.4);
  });
});

describe('the phenotype split — closed-form AUC oracles', () => {
  const DOSE_MG = 750; // the Wierzchowiecki single oral dose

  it('parent exposure rises by exactly the half-life ratio (1.5x)', () => {
    const fast = deriveParams(procainamide(), 'oral').params;
    const slow = deriveParams(applyPhenotype(procainamide(), 'slow-acetylator'), 'oral').params;

    const ratio = singleDoseAuc(slow, DOSE_MG) / singleDoseAuc(fast, DOSE_MG);
    expect(ratio).toBeCloseTo(3.6 / 2.4, 6); // = 1.5
  });

  it('metabolite exposure FALLS by exactly the fm ratio (0.5x), independent of the parent slowing', () => {
    // AUC_m = fm·F·D/(k_m·Vd_m). k_m and Vd_m are phenotype-independent, so the
    // ratio is fm alone — the parent's changed half-life cancels out entirely.
    const fastFm = procainamide().metabolites![0]!.fractionFormed.value;
    const slowFm = applyPhenotype(procainamide(), 'slow-acetylator').metabolites![0]!.fractionFormed
      .value;
    expect(slowFm / fastFm).toBeCloseTo(0.5, 6);
  });

  it('moves parent and metabolite in OPPOSITE directions', () => {
    // The teaching payoff, asserted rather than admired: "slow metaboliser = more
    // drug" is only half the story once the metabolite is active.
    const fast = procainamide();
    const slow = applyPhenotype(fast, 'slow-acetylator');
    const parentUp =
      singleDoseAuc(deriveParams(slow, 'oral').params, DOSE_MG) >
      singleDoseAuc(deriveParams(fast, 'oral').params, DOSE_MG);
    const metaboliteDown =
      slow.metabolites![0]!.fractionFormed.value < fast.metabolites![0]!.fractionFormed.value;
    expect(parentUp && metaboliteDown).toBe(true);
  });
});

describe('every shipped compound still derives under its default phenotype', () => {
  it('applying the default phenotype changes no compound that ships', () => {
    for (const c of loadAllCompounds()) {
      expect(applyPhenotype(c, defaultPhenotypeId(c))).toBe(c);
    }
  });
});

/**
 * The schema guards. Each of these encodes a way a curator could produce a file
 * that validates, derives, renders — and lies. They use synthetic round numbers,
 * not procainamide's, per the fixtures' convention.
 */
describe('schema guards on phenotype presets', () => {
  const withPhenotypes = (presets: unknown[], extra: Record<string, unknown> = {}) => {
    const raw = baseRawCompound();
    raw.variability = {
      geneticFactors: ['TEST1'],
      phenotypes: { factor: 'TEST1', presets },
    };
    Object.assign(raw, extra);
    return raw;
  };
  const slowish = (overrides: unknown) => ({
    id: 'variant',
    label: 'Variant',
    description: 'A synthetic contrasting phenotype.',
    overrides,
  });
  const defaultPreset = (overrides: unknown = {}) => ({
    id: 'wild-type',
    label: 'Wild type',
    description: 'A synthetic default phenotype.',
    overrides,
  });
  const halfLifeOverride = {
    halfLife: { value: 8, unit: 'h', derived: false, sourceRef: 'ref' },
  };

  it('accepts the identity-default shape', () => {
    expect(() =>
      parseCompound(withPhenotypes([defaultPreset(), slowish(halfLifeOverride)])),
    ).not.toThrow();
  });

  it('rejects a first preset that overrides anything — the default must BE the base', () => {
    expect(() =>
      parseCompound(withPhenotypes([defaultPreset(halfLifeOverride), slowish(halfLifeOverride)])),
    ).toThrow(/first phenotype preset .* must carry no overrides/);
  });

  it('rejects a non-default preset that overrides nothing — a choice that changes no curve', () => {
    expect(() => parseCompound(withPhenotypes([defaultPreset(), slowish({})]))).toThrow(
      /overrides nothing/,
    );
  });

  it('rejects a lone preset — one phenotype is not a contrast', () => {
    expect(() => parseCompound(withPhenotypes([defaultPreset()]))).toThrow();
  });

  it('rejects a factor missing from geneticFactors', () => {
    const raw = baseRawCompound();
    raw.variability = {
      geneticFactors: ['SOMETHING_ELSE'],
      phenotypes: { factor: 'TEST1', presets: [defaultPreset(), slowish(halfLifeOverride)] },
    };
    expect(() => parseCompound(raw)).toThrow(/not listed in variability.geneticFactors/);
  });

  it('rejects an fm override naming a metabolite the compound does not have', () => {
    expect(() =>
      parseCompound(
        withPhenotypes([
          defaultPreset(),
          slowish({
            fractionFormed: [
              {
                metaboliteId: 'ghost',
                param: { value: 10, unit: 'percent', derived: false, sourceRef: 'ref' },
              },
            ],
          }),
        ]),
      ),
    ).toThrow(/not a metabolite of this compound/);
  });

  it('rejects an unresolvable sourceRef inside an override', () => {
    expect(() =>
      parseCompound(
        withPhenotypes([
          defaultPreset(),
          slowish({ halfLife: { value: 8, unit: 'h', derived: false, sourceRef: 'nope' } }),
        ]),
      ),
    ).toThrow(/resolves to neither a key in sources nor a recognised sentinel/);
  });

  it('rejects duplicate preset ids', () => {
    expect(() =>
      parseCompound(
        withPhenotypes([defaultPreset(), { ...slowish(halfLifeOverride), id: 'wild-type' }]),
      ),
    ).toThrow(/duplicate phenotype preset id/);
  });

  it('rejects a half-life override when a stored clearance would silently win', () => {
    // resolveKe prefers a stored CL over half-life, so this override would be
    // discarded and the curve would not move — the failure mode no test can see.
    const raw = withPhenotypes([defaultPreset(), slowish(halfLifeOverride)]);
    (raw.disposition as Record<string, unknown>).clearance = {
      value: 6,
      unit: 'L/h',
      derived: false,
      sourceRef: 'ref',
    };
    expect(() => parseCompound(raw)).toThrow(/TAKES PRECEDENCE|silently ignored/);
  });
});
