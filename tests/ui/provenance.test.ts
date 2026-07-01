import { describe, expect, it } from 'vitest';
import { deriveParams } from '../../src/data/derive.ts';
import { parseCompound } from '../../src/data/loader.ts';
import {
  citedSources,
  provenanceEntries,
  resolveSource,
} from '../../src/ui/provenance.ts';
import { baseRawCompound } from '../data/_fixtures.ts';

/**
 * The provenance model is where the honesty UI reads its rows. These tests pin
 * the two things that make it honest: it shows exactly the parameters that fed
 * THIS curve (route-truthful), and it groups each runtime derivation under the
 * measured input it was computed from — crucially, `ke` never appears as a
 * measurement (it has no raw parameter). Synthetic round-number fixtures only.
 */

/** baseRawCompound + an available oral route with a reported Tmax. */
function oralRawCompound(): Record<string, unknown> {
  const raw = baseRawCompound();
  (raw.routes as Record<string, unknown>).oral = {
    available: true,
    F: { value: 80, unit: 'percent', derived: false, sourceRef: 'ref' },
    tmax: { value: 1.5, unit: 'h', derived: false, sourceRef: 'ref' },
  };
  return raw;
}

describe('provenanceEntries — route-truthful rows', () => {
  it('shows disposition only for an IV route (no absorption rows)', () => {
    const compound = parseCompound(baseRawCompound());
    const keys = provenanceEntries(compound, 'iv_bolus').map((r) => r.key);
    expect(keys).toEqual(['vd', 'halfLife']);
  });

  it('adds F and the Tmax row for the oral route', () => {
    const compound = parseCompound(oralRawCompound());
    const keys = provenanceEntries(compound, 'oral').map((r) => r.key);
    expect(keys).toEqual(['vd', 'halfLife', 'F', 'tmax']);
  });

  it('does not show oral absorption rows when the IV route is selected', () => {
    const compound = parseCompound(oralRawCompound());
    const keys = provenanceEntries(compound, 'iv_bolus').map((r) => r.key);
    expect(keys).not.toContain('F');
    expect(keys).not.toContain('tmax');
  });

  it('shows both clearance AND half-life when clearance is present', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = { value: 10, unit: 'L', derived: false, sourceRef: 'ref' };
    (raw.disposition as Record<string, unknown>).clearance = { value: 2, unit: 'L/h', derived: false, sourceRef: 'ref' };
    const compound = parseCompound(raw);
    const keys = provenanceEntries(compound, 'iv_bolus').map((r) => r.key);
    expect(keys).toEqual(['vd', 'halfLife', 'clearance']);
  });

  it('never shows a bare "ke" row — ke is only ever a derivation', () => {
    const compound = parseCompound(oralRawCompound());
    const keys = provenanceEntries(compound, 'oral').map((r) => r.key);
    expect(keys).not.toContain('ke');
  });

  it('prefers a measured ka row over Tmax when both are present', () => {
    const raw = oralRawCompound();
    (raw.routes as { oral: Record<string, unknown> }).oral.ka = {
      value: 0.9,
      unit: '1/h',
      derived: false,
      sourceRef: 'ref',
    };
    const keys = provenanceEntries(parseCompound(raw), 'oral').map((r) => r.key);
    expect(keys).toContain('ka');
    expect(keys).not.toContain('tmax');
  });
});

describe('provenanceEntries — axis-1 classification (badge)', () => {
  it('flags a plain sourced value as measured', () => {
    const rows = provenanceEntries(parseCompound(baseRawCompound()), 'iv_bolus');
    expect(rows.find((r) => r.key === 'vd')?.provenance).toBe('measured');
  });

  it('flags a derived: true value as curator-derived', () => {
    const raw = baseRawCompound();
    (raw.disposition as { vd: { derived: boolean } }).vd.derived = true;
    const rows = provenanceEntries(parseCompound(raw), 'iv_bolus');
    expect(rows.find((r) => r.key === 'vd')?.provenance).toBe('derived');
  });

  it('flags an F = 1 with the definition sentinel as by-definition', () => {
    const raw = oralRawCompound();
    (raw.routes as { oral: Record<string, unknown> }).oral.F = {
      value: 1,
      unit: 'fraction',
      derived: false,
      sourceRef: 'definition',
    };
    const rows = provenanceEntries(parseCompound(raw), 'oral');
    expect(rows.find((r) => r.key === 'F')?.provenance).toBe('definition');
  });

  it('treats a derived_from_tmax sentinel as curator-derived', () => {
    const raw = oralRawCompound();
    (raw.routes as { oral: { tmax: { sourceRef: string } } }).oral.tmax.sourceRef = 'derived_from_tmax';
    const rows = provenanceEntries(parseCompound(raw), 'oral');
    expect(rows.find((r) => r.key === 'tmax')?.provenance).toBe('derived');
  });
});

describe('provenanceEntries — axis-2 derivation grouping', () => {
  it('attaches the ke = ln2/t½ note to half-life (no clearance)', () => {
    const compound = parseCompound(baseRawCompound());
    const { derived } = deriveParams(compound, 'iv_bolus');
    const rows = provenanceEntries(compound, 'iv_bolus', derived);

    const halfLife = rows.find((r) => r.key === 'halfLife');
    expect(halfLife?.derivations.some((n) => /ke = ln2/.test(n))).toBe(true);
    // and Vd scaling attaches to the vd row
    expect(rows.find((r) => r.key === 'vd')?.derivations.some((n) => /scaled/.test(n))).toBe(true);
  });

  it('attaches the ke = CL/Vd note to clearance when clearance is present', () => {
    const raw = baseRawCompound();
    (raw.disposition as Record<string, unknown>).vd = { value: 10, unit: 'L', derived: false, sourceRef: 'ref' };
    (raw.disposition as Record<string, unknown>).clearance = { value: 2, unit: 'L/h', derived: false, sourceRef: 'ref' };
    (raw.disposition as { halfLife: { value: number } }).halfLife.value = Math.LN2 / 0.2;
    const compound = parseCompound(raw);
    const { derived } = deriveParams(compound, 'iv_bolus');
    const rows = provenanceEntries(compound, 'iv_bolus', derived);

    expect(rows.find((r) => r.key === 'clearance')?.derivations.some((n) => /CL\/Vd/.test(n))).toBe(true);
    expect(rows.find((r) => r.key === 'halfLife')?.derivations.some((n) => /CL\/Vd/.test(n))).toBe(false);
  });

  it('attaches the ka-from-Tmax note to the Tmax row', () => {
    const compound = parseCompound(oralRawCompound());
    const { derived } = deriveParams(compound, 'oral');
    const rows = provenanceEntries(compound, 'oral', derived);
    expect(rows.find((r) => r.key === 'tmax')?.derivations.some((n) => /ka =/.test(n))).toBe(true);
  });

  it('drops a derivation note with no matching row (e.g. assumed F)', () => {
    // An oral route with no F provided: derive assumes F=1 and emits an F note,
    // but there is no F row to hang it on — it must not appear in any row.
    const raw = oralRawCompound();
    delete (raw.routes as { oral: Record<string, unknown> }).oral.F;
    const compound = parseCompound(raw);
    const { derived } = deriveParams(compound, 'oral');
    const rows = provenanceEntries(compound, 'oral', derived);
    const allNotes = rows.flatMap((r) => r.derivations).join(' ');
    expect(allNotes).not.toMatch(/F assumed/);
  });
});

describe('resolveSource and citedSources', () => {
  it('resolves a real sourceRef to its literature entry', () => {
    const compound = parseCompound(baseRawCompound());
    const resolved = resolveSource(compound, 'ref');
    expect(resolved).toEqual({
      kind: 'source',
      ref: 'ref',
      source: { type: 'test', title: 'Synthetic test source' },
    });
  });

  it('resolves the definition sentinel to a label', () => {
    const compound = parseCompound(baseRawCompound());
    const resolved = resolveSource(compound, 'definition');
    expect(resolved.kind).toBe('sentinel');
  });

  it('returns kind none for a null sourceRef', () => {
    const compound = parseCompound(baseRawCompound());
    expect(resolveSource(compound, null)).toEqual({ kind: 'none' });
  });

  it('lists each cited literature source once, in first-seen order', () => {
    const compound = parseCompound(oralRawCompound());
    const rows = provenanceEntries(compound, 'oral');
    const cited = citedSources(rows);
    expect(cited.map((c) => c.ref)).toEqual(['ref']); // deduped; sentinels excluded
  });
});
