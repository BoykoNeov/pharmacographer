import { describe, expect, it } from 'vitest';
import { deriveMetaboliteParams, deriveParams } from '../../src/data/derive.ts';
import { parseCompound } from '../../src/data/loader.ts';
import {
  citedSources,
  metaboliteProvenanceEntries,
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

/**
 * baseRawCompound + a single active metabolite. A distinct `metasrc` source
 * cites the metabolite parameters so the bibliography test can prove a
 * metabolite-only citation reaches the panel. Formation fraction is a PERCENT
 * and Vd is per-kg so the derivation emits the `fractionFormed` and `vdM` notes.
 */
function metaboliteRawCompound(): Record<string, unknown> {
  const raw = baseRawCompound();
  (raw.sources as Record<string, unknown>).metasrc = { type: 'test', title: 'Metabolite source' };
  raw.metabolites = [
    {
      id: 'testmeta',
      name: 'Testmetabolite',
      active: true,
      fractionFormed: { value: 50, unit: 'percent', derived: false, sourceRef: 'metasrc' },
      vd: { value: 0.5, unit: 'L/kg', derived: true, sourceRef: 'metasrc' },
      halfLife: { value: 8, unit: 'h', derived: false, sourceRef: 'ref' },
    },
  ];
  return raw;
}

describe('metaboliteProvenanceEntries', () => {
  it('returns a group per plotted metabolite with fractionFormed, vd, half-life rows', () => {
    const compound = parseCompound(metaboliteRawCompound());
    const groups = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived: [] }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Testmetabolite');
    expect(groups[0]?.active).toBe(true);
    expect(groups[0]?.rows.map((r) => r.key)).toEqual(['fractionFormed', 'vd', 'halfLife']);
  });

  it('surfaces an optional first-pass fraction row so its citation reaches the panel', () => {
    // A first-pass fraction is a sourced parameter; the honesty gate ("is ffp for THIS
    // metabolite citable?") only means anything if the citation actually renders.
    const raw = metaboliteRawCompound();
    (raw.sources as Record<string, unknown>).fpsrc = { type: 'test', title: 'First-pass source' };
    (raw.metabolites as Record<string, unknown>[])[0]!.firstPassFraction = {
      value: 30,
      unit: 'percent',
      derived: false,
      sourceRef: 'fpsrc',
    };
    const compound = parseCompound(raw);
    const [group] = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived: [] }]);
    // The ffp row appears (right after fm), carrying its own citation.
    expect(group?.rows.map((r) => r.key)).toEqual(['fractionFormed', 'firstPassFraction', 'vd', 'halfLife']);
    const fpRow = group?.rows.find((r) => r.key === 'firstPassFraction');
    expect(fpRow?.label).toMatch(/first-pass/i);
    expect(fpRow?.source.kind === 'source' && fpRow.source.ref).toBe('fpsrc');
    // And its percent→fraction derivation groups under the ffp row (silent-contract check).
    const { derived } = deriveMetaboliteParams(compound.metabolites![0]!, 0.1);
    const [grouped] = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived }]);
    expect(
      grouped?.rows.find((r) => r.key === 'firstPassFraction')?.derivations.some((n) => /%/.test(n)),
    ).toBe(true);
  });

  it('is empty when no metabolite was plotted (route-truthful)', () => {
    // A compound that declares a metabolite but whose curve drew none (e.g. an IV
    // infusion) passes an empty plotted list — no metabolite rows appear.
    const compound = parseCompound(metaboliteRawCompound());
    expect(metaboliteProvenanceEntries(compound, [])).toEqual([]);
    // …and a compound with no metabolites at all yields nothing regardless.
    expect(metaboliteProvenanceEntries(parseCompound(baseRawCompound()), [])).toEqual([]);
  });

  it('classifies the metabolite rows (measured fm, curator-derived Vd)', () => {
    const compound = parseCompound(metaboliteRawCompound());
    const [group] = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived: [] }]);
    expect(group?.rows.find((r) => r.key === 'fractionFormed')?.provenance).toBe('measured');
    expect(group?.rows.find((r) => r.key === 'vd')?.provenance).toBe('derived');
  });

  it('groups each metabolite derivation under its input row (keM under half-life)', () => {
    // Drive a REAL derivation so this test breaks if derive.ts renames a note
    // parameter (the 'vdM'/'keM'/'fractionFormed' strings are a silent contract).
    const compound = parseCompound(metaboliteRawCompound());
    const meta = compound.metabolites![0]!;
    const { derived } = deriveMetaboliteParams(meta, 0.1 /* arbitrary positive parent ke */);
    const [group] = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived }]);
    const rows = group!.rows;

    // keM = ln2/t½ has no row of its own — it attaches to the half-life row.
    expect(rows.find((r) => r.key === 'halfLife')?.derivations.some((n) => /ke = ln2/.test(n))).toBe(true);
    // per-kg Vd scaling attaches to the vd row.
    expect(rows.find((r) => r.key === 'vd')?.derivations.some((n) => /scaled/.test(n))).toBe(true);
    // percent → fraction normalisation attaches to the fractionFormed row.
    expect(rows.find((r) => r.key === 'fractionFormed')?.derivations.some((n) => /%/.test(n))).toBe(true);
    // and keM never surfaces as a bare row.
    expect(rows.map((r) => r.key)).not.toContain('keM');
  });

  it('lists a metabolite-only citation in the shared bibliography', () => {
    const compound = parseCompound(metaboliteRawCompound());
    const parentRows = provenanceEntries(compound, 'iv_bolus');
    const groups = metaboliteProvenanceEntries(compound, [{ id: 'testmeta', derived: [] }]);
    // The parent rows cite only `ref`; `metasrc` reaches the panel via the
    // metabolite rows, exactly the source that was previously surfaced nowhere.
    expect(citedSources(parentRows).map((c) => c.ref)).not.toContain('metasrc');
    const cited = citedSources([...parentRows, ...groups.flatMap((g) => g.rows)]);
    expect(cited.map((c) => c.ref)).toContain('metasrc');
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
