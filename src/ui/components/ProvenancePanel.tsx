/**
 * ProvenancePanel — where every number on the graph comes clean (handoff §1, §8,
 * §13 Phase 5). For each parameter that fed the current curve it shows the value
 * (and reported range), a measured-vs-curator-derived badge, the citation, the
 * conditions the value holds under, and — indented — what `derive.ts` computed
 * FROM it to feed the model. A Sources bibliography lists the cited literature.
 *
 * Presentational only: all row selection and classification lives in the pure
 * {@link provenanceEntries} helper so this file just formats.
 */

import type { DerivedNote } from '../../data/derive.ts';
import type { Compound, CompoundParameter } from '../../data/schema.ts';
import type { Route } from '../../engine/types.ts';
import { fmtNum } from '../curve.ts';
import {
  citedSources,
  metaboliteProvenanceEntries,
  PROVENANCE_LABELS,
  provenanceEntries,
  type PlottedMetabolite,
  type Provenance,
  type ProvenanceRow,
  type ResolvedSource,
} from '../provenance.ts';

interface ProvenancePanelProps {
  compound: Compound;
  route: Route;
  /** Runtime derivations from the curve build, grouped under their input row. */
  derived: DerivedNote[];
  /**
   * The metabolite curves actually plotted for this curve (IV-bolus parent only).
   * Their own provenance rows are shown, grouped per metabolite. Undefined/empty
   * when no metabolite line is drawn, so the panel stays in sync with the chart.
   */
  metabolites?: PlottedMetabolite[];
}

/** Format a value with its unit and, if present, the reported range. */
function formatValue(param: CompoundParameter): string {
  if (param.value === null) return `— ${param.unit}`;
  const point = `${fmtNum(param.value)} ${param.unit}`;
  if (param.range) return `${point} (range ${fmtNum(param.range[0])}–${fmtNum(param.range[1])})`;
  return point;
}

/** One-line citation text for a resolved source. */
function citationText(source: ResolvedSource): string {
  switch (source.kind) {
    case 'source':
      return source.source.title;
    case 'sentinel':
      return source.label;
    case 'none':
      return 'No source recorded';
  }
}

const BADGE_MODIFIER: Record<Provenance, string> = {
  measured: 'badge--measured',
  derived: 'badge--derived',
  definition: 'badge--definition',
};

function ProvenanceRowItem({ row }: { row: ProvenanceRow }) {
  return (
    <li className="prov__row">
      <div className="prov__head">
        <span className="prov__name">{row.label}</span>
        <span className={`badge ${BADGE_MODIFIER[row.provenance]}`}>
          {PROVENANCE_LABELS[row.provenance]}
        </span>
      </div>
      <div className="prov__value">{formatValue(row.param)}</div>
      <div className="prov__source">{citationText(row.source)}</div>
      {row.param.conditions && <div className="prov__conditions">{row.param.conditions}</div>}
      {row.derivations.map((note, i) => (
        <div key={i} className="prov__derivation">
          → {note}
        </div>
      ))}
    </li>
  );
}

export function ProvenancePanel({ compound, route, derived, metabolites = [] }: ProvenancePanelProps) {
  const rows = provenanceEntries(compound, route, derived);
  const metaboliteGroups = metaboliteProvenanceEntries(compound, metabolites);
  // Bibliography spans parent AND metabolite rows, so metabolite-only citations
  // (e.g. the formation-fraction and metabolite-Vd sources) are listed too.
  const sources = citedSources([...rows, ...metaboliteGroups.flatMap((g) => g.rows)]);

  return (
    <section className="panel prov" aria-label="Provenance">
      <h2 className="prov__title">Where these numbers come from</h2>
      <ul className="prov__rows">
        {rows.map((row) => (
          <ProvenanceRowItem key={row.key} row={row} />
        ))}
      </ul>

      {metaboliteGroups.map((group) => (
        <div key={group.id} className="prov__meta-group">
          <h3 className="prov__meta-title">
            {group.name}{' '}
            <span className="prov__meta-tag">
              {group.active ? '— active metabolite' : '— metabolite'}
            </span>
          </h3>
          <ul className="prov__rows">
            {group.rows.map((row) => (
              <ProvenanceRowItem key={`${group.id}-${row.key}`} row={row} />
            ))}
          </ul>
        </div>
      ))}

      {sources.length > 0 && (
        <>
          <h3 className="prov__subtitle">Sources</h3>
          <ul className="prov__sources">
            {sources.map(({ ref, source }) => (
              <li key={ref} className="prov__source-item">
                <span className="prov__source-type">{source.type}</span> — {source.title}
                {source.url && (
                  <>
                    {' '}
                    <a className="prov__source-link" href={source.url} target="_blank" rel="noreferrer">
                      link
                    </a>
                  </>
                )}
                {source.accessed && <span className="prov__source-accessed"> (accessed {source.accessed})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
