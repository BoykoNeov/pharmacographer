/**
 * Metabolite helpers shared by every linear curve builder.
 */

import { appliesFirstPass } from '../../data/derive.ts';
import type { DataRoute } from '../../data/schema.ts';
import type { MetaboliteDisposition } from '../../engine/types.ts';

/**
 * Drop a metabolite's pre-systemic `firstPassFraction` on any route that does not
 * actually pass through gut wall and portal liver — which, of the two routes the
 * engine computes as `oral`, means IM.
 *
 * This is the guard the layering makes necessary. The engine is handed an ENGINE
 * route and applies `ffp` on its `oral` path; it cannot distinguish a needle from a
 * tablet, and must not be taught to (handoff §4). So the DataRoute-aware layer strips
 * the term before the engine sees it, using `appliesFirstPass` — the clinical fact —
 * from the data layer rather than a route literal spelled out here.
 *
 * Nothing ships that exercises this today (no compound pairs `ffp` with an IM route),
 * which is exactly why it is written down: an IM curve drawing a gut-derived
 * metabolite would look entirely plausible and no test would see it.
 */
export function stripFirstPassUnlessOral<T extends { params: MetaboliteDisposition }>(
  route: DataRoute,
  derivation: T,
): T {
  if (appliesFirstPass(route)) return derivation;
  const params = { ...derivation.params };
  delete params.firstPassFraction;
  return { ...derivation, params };
}

/**
 * The em-dash suffix that labels a metabolite by its pharmacological status —
 * the SINGLE source of truth shared by the chart legend and the provenance panel
 * so the two wordings can never drift (they were previously duplicated string
 * literals). Returns the tag alone (no name, no leading space); callers prepend
 * the metabolite name.
 */
export function metaboliteTag(active: boolean): string {
  return active ? '— active metabolite' : '— metabolite';
}
