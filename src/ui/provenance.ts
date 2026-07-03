/**
 * Provenance model for the honesty UI (handoff §1, §8, §13 Phase 5).
 *
 * "Every line on the graph must answer three questions: where did this number
 * come from, was it measured or computed, and under what conditions." This
 * module turns a validated {@link Compound} plus the current route into the
 * ordered, display-ready rows the {@link ProvenancePanel} renders. It is kept
 * out of the React component (like {@link routeOptions} in `curve.ts`) so the
 * row-selection logic can be reasoned about and unit-tested on its own.
 *
 * Two ORTHOGONAL axes of "measured vs derived" meet here (this is the whole
 * point of the phase, so it is worth stating precisely):
 *
 *   Axis 1 — was the *source value* measured or curator-computed? This is the
 *     per-parameter `derived` flag plus the `derived_from_*` sentinel
 *     sourceRefs. It drives the badge and the citation.
 *   Axis 2 — did `derive.ts` transform the value to feed the engine? This is
 *     the runtime {@link DerivedNote} list on the curve (Vd L/kg → L scaling,
 *     ke from t½ or CL/Vd, ka from Tmax). It is grouped IN UNDER its axis-1
 *     input rather than shown as a second disjoint table.
 *
 * The subtle case: **`ke` has no raw parameter** — it exists only on axis 2,
 * computed from a measured half-life (or CL/Vd). So the source rows show
 * half-life (and clearance, when used), never a bare "ke measurement"; the ke
 * derivation is attached to the row it was computed from.
 *
 * UI layer: may import data (`schema`, the `Compound`) and the sibling glue
 * (`derive` types). No engine, no React here.
 */

import type { DerivedNote } from '../data/derive.ts';
import type { Compound, CompoundParameter, CompoundSource } from '../data/schema.ts';
import { SOURCE_REF_SENTINELS } from '../data/schema.ts';
import type { Route } from '../engine/types.ts';

/**
 * The measured-vs-derived classification of a source value (axis 1).
 *   - `measured`   — read from a source as reported.
 *   - `derived`    — the curator computed it (flagged `derived`, or a
 *                    `derived_from_*` sentinel sourceRef).
 *   - `definition` — true by definition (e.g. IV bioavailability F = 1).
 */
export type Provenance = 'measured' | 'derived' | 'definition';

/** Human labels for the {@link Provenance} badge. */
export const PROVENANCE_LABELS: Record<Provenance, string> = {
  measured: 'Measured',
  derived: 'Curator-derived',
  definition: 'By definition',
};

/** A `sourceRef` resolved to either a literature entry or a sentinel meaning. */
export type ResolvedSource =
  | { kind: 'source'; ref: string; source: CompoundSource }
  | { kind: 'sentinel'; ref: string; label: string }
  | { kind: 'none' };

/** Human meanings for the non-bibliographic `sourceRef` sentinels (schema §8). */
const SENTINEL_LABELS: Record<(typeof SOURCE_REF_SENTINELS)[number], string> = {
  definition: 'True by definition',
  derived_from_tmax: 'Estimated from a reported Tmax',
  derived_from_clearance: 'Computed from clearance and half-life',
};

/** One parameter as shown in the provenance panel. */
export interface ProvenanceRow {
  /** Stable key: 'vd' | 'halfLife' | 'clearance' | 'F' | 'ka' | 'tmax'. */
  key: string;
  /** Human label, e.g. "Elimination half-life (t½)". */
  label: string;
  /** The raw provenance-carrying parameter (value, unit, range, conditions). */
  param: CompoundParameter;
  /** Axis-1 classification for the badge. */
  provenance: Provenance;
  /** The resolved citation (literature source or sentinel meaning). */
  source: ResolvedSource;
  /** Axis-2 runtime derivations computed FROM this row, grouped in. */
  derivations: string[];
}

/** Human labels for each row key. */
const ROW_LABELS: Record<string, string> = {
  vd: 'Volume of distribution (Vd)',
  halfLife: 'Elimination half-life (t½)',
  clearance: 'Clearance (CL)',
  F: 'Bioavailability (F)',
  ka: 'Absorption rate constant (ka)',
  tmax: 'Time to peak (Tmax)',
  fractionFormed: 'Fraction formed (fm)',
};

/** Resolve a `sourceRef` against the compound's `sources` map and the sentinels. */
export function resolveSource(compound: Compound, sourceRef: string | null): ResolvedSource {
  if (sourceRef === null) return { kind: 'none' };
  const source = compound.sources[sourceRef];
  if (source) return { kind: 'source', ref: sourceRef, source };
  if (sourceRef in SENTINEL_LABELS) {
    return { kind: 'sentinel', ref: sourceRef, label: SENTINEL_LABELS[sourceRef as keyof typeof SENTINEL_LABELS] };
  }
  // Validation guarantees this is unreachable, but resolve gracefully rather than throw.
  return { kind: 'sentinel', ref: sourceRef, label: sourceRef };
}

/** Axis-1: classify a source value as measured, curator-derived, or definitional. */
function classify(param: CompoundParameter): Provenance {
  if (param.sourceRef === 'definition') return 'definition';
  if (param.derived) return 'derived';
  if (param.sourceRef === 'derived_from_tmax' || param.sourceRef === 'derived_from_clearance') {
    return 'derived';
  }
  return 'measured';
}

/**
 * Which row a runtime {@link DerivedNote} (axis 2) belongs under, given which
 * rows are present. `ke` has no row of its own, so it attaches to whichever
 * input it was computed from: clearance (`ke = CL/Vd`) when clearance is shown,
 * otherwise half-life (`ke = ln2/t½`). `ka` attaches to the Tmax row when it was
 * inverted from a Tmax; the assumed-`F` note has no row (F is only shown when the
 * file provides it) and is surfaced as a caution instead.
 */
function derivationTargetKey(noteParameter: string, present: ReadonlySet<string>): string | undefined {
  switch (noteParameter) {
    case 'vd':
      return 'vd';
    case 'ke':
      return present.has('clearance') ? 'clearance' : 'halfLife';
    case 'ka':
      return present.has('tmax') ? 'tmax' : present.has('ka') ? 'ka' : undefined;
    default:
      return undefined; // e.g. an assumed-F note with no F row.
  }
}

/** Build one row from a parameter, ready for {@link attachDerivations}. */
function makeRow(key: string, param: CompoundParameter, compound: Compound): ProvenanceRow {
  return {
    key,
    label: ROW_LABELS[key] ?? key,
    param,
    provenance: classify(param),
    source: resolveSource(compound, param.sourceRef),
    derivations: [],
  };
}

/**
 * The provenance rows for the parameters that actually fed THIS curve, in
 * display order (disposition first, then absorption). Route-truthful: IV routes
 * show disposition only; `oral` adds the absorption parameters. Clearance is
 * shown whenever the file supplies it, because `derive.ts` uses it (and
 * cross-checks it against the half-life) — hiding it would misrepresent the
 * computation. Runtime derivations are grouped under their input row.
 */
export function provenanceEntries(
  compound: Compound,
  route: Route,
  derivedNotes: readonly DerivedNote[] = [],
): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [];

  // ── Disposition (route-independent) ──────────────────────────────────────
  rows.push(makeRow('vd', compound.disposition.vd, compound));
  rows.push(makeRow('halfLife', compound.disposition.halfLife, compound));
  const clearance = compound.disposition.clearance;
  if (clearance && clearance.value !== null) {
    rows.push(makeRow('clearance', clearance, compound));
  }

  // ── Absorption (oral only) ───────────────────────────────────────────────
  if (route === 'oral') {
    const oral = compound.routes.oral;
    if (oral?.F) rows.push(makeRow('F', oral.F, compound));
    // derive.ts prefers a measured ka; otherwise it inverts a reported Tmax.
    if (oral?.ka && oral.ka.value !== null) {
      rows.push(makeRow('ka', oral.ka, compound));
    } else if (oral?.tmax && oral.tmax.value !== null) {
      rows.push(makeRow('tmax', oral.tmax, compound));
    }
  }

  // ── Group axis-2 derivations under their axis-1 input ─────────────────────
  const present = new Set(rows.map((r) => r.key));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const note of derivedNotes) {
    const key = derivationTargetKey(note.parameter, present);
    if (key === undefined) continue;
    byKey.get(key)?.derivations.push(note.note);
  }

  return rows;
}

/**
 * The minimal shape of a plotted metabolite curve that
 * {@link metaboliteProvenanceEntries} needs: its `id` (to join back to the raw
 * {@link Compound.metabolites} entry for the provenance-carrying parameters) and
 * the axis-2 {@link DerivedNote}s the metabolite derivation computed. Structural
 * on purpose — a `MetaboliteCurve` from `curve.ts` is assignable, so this module
 * need not import the UI curve type.
 */
export interface PlottedMetabolite {
  id: string;
  derived: readonly DerivedNote[];
}

/** A metabolite's provenance rows, grouped under its name for the panel. */
export interface MetaboliteProvenanceGroup {
  /** Metabolite id (stable React key). */
  id: string;
  /** Human-facing name for the group heading. */
  name: string;
  /** Whether the metabolite is pharmacologically active (mirrors the chart legend). */
  active: boolean;
  /** The metabolite's own provenance rows: fraction formed, Vd, half-life. */
  rows: ProvenanceRow[];
}

/**
 * Which metabolite row a runtime {@link DerivedNote} (axis 2) belongs under. The
 * metabolite derivation (`derive.ts` `deriveMetaboliteDisposition`) emits notes
 * keyed `vdM` (per-kg Vd scaling), `keM` (`ke = ln2/t½`) and `fractionFormed`
 * (percent → fraction). Like the parent's `ke`, the metabolite's `keM` has no row
 * of its own, so it attaches to the half-life it was computed from.
 */
function metaboliteDerivationTargetKey(noteParameter: string): string | undefined {
  switch (noteParameter) {
    case 'vdM':
      return 'vd';
    case 'keM':
      return 'halfLife';
    case 'fractionFormed':
      return 'fractionFormed';
    default:
      return undefined;
  }
}

/**
 * The provenance rows for each metabolite that was actually PLOTTED for this
 * curve, grouped by metabolite. Route-truthful in the same way as
 * {@link provenanceEntries}: the caller passes the built metabolite curves (which
 * exist only for an IV-bolus parent), so a route that draws no metabolite line
 * shows no metabolite rows. Each group's rows carry the metabolite's OWN
 * disposition — fraction formed, Vd, half-life — with the same measured-vs-derived
 * badge and citation machinery as the parent, and the metabolite's runtime
 * derivations grouped under their input row. The raw provenance-carrying
 * parameters are read from `compound.metabolites` (joined by `id`); the axis-2
 * notes come from the plotted curve.
 */
export function metaboliteProvenanceEntries(
  compound: Compound,
  plotted: readonly PlottedMetabolite[] = [],
): MetaboliteProvenanceGroup[] {
  const byId = new Map((compound.metabolites ?? []).map((m) => [m.id, m]));
  const groups: MetaboliteProvenanceGroup[] = [];
  for (const { id, derived } of plotted) {
    const meta = byId.get(id);
    if (!meta) continue; // plotted but not declared — shouldn't happen; skip defensively.

    const rows: ProvenanceRow[] = [
      makeRow('fractionFormed', meta.fractionFormed, compound),
      makeRow('vd', meta.vd, compound),
      makeRow('halfLife', meta.halfLife, compound),
    ];

    // Group axis-2 derivations under their axis-1 input row.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const note of derived) {
      const key = metaboliteDerivationTargetKey(note.parameter);
      if (key === undefined) continue;
      byKey.get(key)?.derivations.push(note.note);
    }

    groups.push({ id: meta.id, name: meta.name, active: meta.active, rows });
  }
  return groups;
}

/** The distinct literature sources cited by `rows`, in first-seen order. */
export function citedSources(rows: readonly ProvenanceRow[]): { ref: string; source: CompoundSource }[] {
  const seen = new Set<string>();
  const out: { ref: string; source: CompoundSource }[] = [];
  for (const row of rows) {
    if (row.source.kind === 'source' && !seen.has(row.source.ref)) {
      seen.add(row.source.ref);
      out.push({ ref: row.source.ref, source: row.source.source });
    }
  }
  return out;
}
