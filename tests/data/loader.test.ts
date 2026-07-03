import { describe, expect, it } from 'vitest';
import { loadAllCompounds, parseCompound } from '../../src/data/loader.ts';
import { deriveParams, deriveParams2c, deriveParams3c } from '../../src/data/derive.ts';
import type { Route } from '../../src/engine/types.ts';
import { baseRawCompound } from './_fixtures.ts';

describe('parseCompound', () => {
  it('returns a typed compound for valid input', () => {
    const compound = parseCompound(baseRawCompound());
    expect(compound.id).toBe('testdrug');
    expect(compound.disposition.halfLife.value).toBe(4);
  });

  it('throws a readable, prefixed error for invalid input', () => {
    expect(() => parseCompound({ id: 'x' })).toThrow(/Invalid compound/);
  });
});

/**
 * The integration guard: every compound that actually ships must validate AND
 * derive without throwing for each route it declares available — this is the
 * "validate the derivation layer against the engine" requirement (handoff §13
 * Phase 3). With no compounds bundled yet it is vacuously true; it becomes the
 * real safety net the moment a seed compound lands.
 */
describe('loadAllCompounds — every bundled compound is valid and derivable', () => {
  const compounds = loadAllCompounds();
  const routes: Route[] = ['iv_bolus', 'oral', 'iv_infusion'];

  it('returns an array', () => {
    expect(Array.isArray(compounds)).toBe(true);
  });

  it('is sorted by display name', () => {
    const names = compounds.map((c) => c.names.inn ?? c.names.usan ?? c.id);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  for (const compound of compounds) {
    describe(compound.id, () => {
      const twoComp = compound.model === 'two_compartment_first_order';
      const threeComp = compound.model === 'three_compartment_first_order';
      for (const route of routes) {
        const available = compound.routes[route]?.available;
        if (!available) continue;
        it(`derives engine params for the available ${route} route`, () => {
          if (threeComp) {
            // Model-aware dispatch (handoff §12, Stage B): a 3-comp compound resolves
            // CL/Vc/Q2/Vp2/Q3/Vp3 (IV routes only — oral 3-comp derivation is deferred).
            const { params } = deriveParams3c(compound, route);
            for (const v of [params.vc, params.cl, params.q2, params.vp2, params.q3, params.vp3]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThan(0);
            }
            return;
          }
          if (twoComp) {
            // Model-aware dispatch (handoff §12): a 2-comp compound resolves CL/Vc/Q/Vp
            // (plus ka for oral — a tri-exponential parent).
            const { params } = deriveParams2c(compound, route);
            for (const v of [params.vc, params.cl, params.q, params.vp]) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThan(0);
            }
            if (route === 'oral') {
              expect(params.ka).toBeDefined();
              expect(params.ka! > 0).toBe(true);
            }
            return;
          }
          const { params } = deriveParams(compound, route);
          expect(Number.isFinite(params.vd)).toBe(true);
          expect(params.vd).toBeGreaterThan(0);
          expect(Number.isFinite(params.ke)).toBe(true);
          expect(params.ke).toBeGreaterThan(0);
          if (route === 'oral') {
            expect(params.ka).toBeDefined();
            expect(params.ka! > 0).toBe(true);
          }
        });
      }
    });
  }
});
