/**
 * Plain-language "what am I looking at" prose for the selected compound.
 *
 * Two pieces, deliberately placed on OPPOSITE sides of the chart to satisfy a
 * hard layout requirement — switching compounds must not make the chart jump up
 * or down:
 *
 *  - {@link CompoundAbout} (the required `description`) renders ABOVE the chart in
 *    a FIXED-HEIGHT box. Because the box height never changes with content, the
 *    chart's top edge stays anchored no matter which compound is selected. The
 *    `description` is length-capped in the schema so it fits without scrolling in
 *    the common case; an unusually long one scrolls inside the box rather than
 *    growing it.
 *  - {@link CompoundMetabolism} (the optional `metabolism` narrative + each
 *    metabolite's blurb) renders BELOW the chart, where unbounded growth is
 *    harmless — it only pushes content that is already beneath the chart.
 *
 * Both are presentational: they read straight off the validated {@link Compound}.
 */

import type { Compound } from '../../data/schema.ts';

/**
 * The required one/two-sentence blurb (what the compound is + what it is used
 * for). Rendered in a fixed-height box above the chart so the chart never jumps
 * when the compound changes.
 */
export function CompoundAbout({ compound }: { compound: Compound }) {
  return (
    <div className="about" aria-label="About this compound">
      <p className="about__text">{compound.description}</p>
    </div>
  );
}

/**
 * The optional metabolism narrative plus a short line per metabolite (name,
 * active/inactive tag, and its own blurb). Renders nothing if the compound has
 * neither a `metabolism` note nor any metabolite with a `description`. Placed
 * below the chart so it may be as long as the story needs.
 */
export function CompoundMetabolism({ compound }: { compound: Compound }) {
  const metaboliteBlurbs = (compound.metabolites ?? []).filter((m) => m.description);
  if (!compound.metabolism && metaboliteBlurbs.length === 0) return null;

  return (
    <section className="metabolism" aria-label="Metabolism and metabolites">
      <h2 className="metabolism__title">Metabolism &amp; metabolites</h2>
      {compound.metabolism && <p className="metabolism__text">{compound.metabolism}</p>}
      {metaboliteBlurbs.length > 0 && (
        <ul className="metabolism__list">
          {metaboliteBlurbs.map((m) => (
            <li key={m.id} className="metabolism__item">
              <span className="metabolism__name">{m.name}</span>{' '}
              <span className="metabolism__tag">
                {m.active ? 'active metabolite' : 'metabolite'}
              </span>
              <span className="metabolism__desc"> — {m.description}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
