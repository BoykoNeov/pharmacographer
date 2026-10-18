/**
 * Which clinical routes the picker offers for a compound, and which of them the
 * engine can actually plot from that compound's data.
 */

import { absorptionRouteOf, engineRouteOf, resolveTransdermalInput } from '../../data/derive.ts';
import type { Compound, DataRoute } from '../../data/schema.ts';

/**
 * Routes the picker offers, in presentation order. These are CLINICAL routes
 * ({@link DataRoute}), which is a wider vocabulary than the engine's input types:
 * `transdermal` resolves onto the engine's zero-order `iv_infusion` and `im` onto
 * the engine's first-order `oral`, both via `engineRouteOf`, so the engine never
 * learns what a patch or a needle is (handoff §4, §12).
 */
export const ENGINE_ROUTES: readonly DataRoute[] = [
  'oral',
  'im',
  'sc',
  'rectal',
  'iv_bolus',
  'iv_infusion',
  'transdermal',
];

/** Human-facing route names. */
export const ROUTE_LABELS: Record<DataRoute, string> = {
  oral: 'Oral',
  im: 'Intramuscular',
  sc: 'Subcutaneous',
  rectal: 'Rectal',
  iv_bolus: 'IV bolus',
  iv_infusion: 'IV infusion',
  transdermal: 'Transdermal patch',
};

/** A route as offered in the UI, with whether the engine can plot it. */
export interface RouteOption {
  route: DataRoute;
  label: string;
  /**
   * The engine can produce a curve for this route from the compound's data.
   * IV routes need only disposition (always present); `oral` additionally needs
   * an absorption constant (ka) or a Tmax to derive one from.
   */
  derivable: boolean;
  /**
   * The compound marks this route as having route-specific data. A derivable but
   * not-available route still plots, but the curve is inferred from disposition
   * only (handoff §1, §10) — the UI flags that.
   */
  available: boolean;
  /** If not derivable, why — for a disabled-option title. */
  reason?: string;
}

/**
 * Whether `compound`'s first-order route (`oral` or `im`) carries enough to derive
 * absorption. Both are read through `absorptionRouteOf` rather than reaching for
 * `routes.oral`, so adding a first-order route cannot silently inherit oral's data
 * — or, worse, oral's absence of it.
 */
function hasAbsorptionData(compound: Compound, route: DataRoute): boolean {
  const block = absorptionRouteOf(compound, route);
  if (!block) return false;
  return (block.ka?.value ?? null) !== null || (block.tmax?.value ?? null) !== null;
}

/** The route options for a compound, in {@link ENGINE_ROUTES} order. */
export function routeOptions(compound: Compound): RouteOption[] {
  return ENGINE_ROUTES.map((route) => {
    const label = ROUTE_LABELS[route];
    if (engineRouteOf(route) === 'oral') {
      // Every first-order route needs its OWN absorption data. None may fall back to
      // the oral block: they have different ka (a depot is not a gut, a rectal mucosa
      // is neither) and different F (oral's is net of a full first pass, an injected
      // depot's of none, rectal's of a partial one).
      //
      // ASKED STRUCTURALLY, not as a route literal. This was `route === 'oral' ||
      // route === 'im' || route === 'rectal'` until `sc` shipped, and a literal list
      // is the same silent-coverage-hole shape that `DATA_ROUTES` and
      // `BIOAVAILABILITY_LABELS` were both rewritten to close: `sc` would have fallen
      // past this arm to the disposition-only default and been offered as derivable on
      // every compound in the set, with no absorption data and no test objecting.
      // `engineRouteOf` already knows which routes are first-order; ask it.
      const derivable = hasAbsorptionData(compound, route);
      return {
        route,
        label,
        derivable,
        available: compound.routes[route]?.available ?? false,
        reason: derivable
          ? undefined
          : `No ${ROUTE_LABELS[route].toLowerCase()} absorption data (ka or Tmax) in this compound file`,
      };
    }
    if (route === 'transdermal') {
      // Unlike the IV routes, a patch is NOT derivable from disposition alone: its
      // whole input is the product's delivery rate and wear period, which only a
      // compound carrying a `transdermal` block has. Without this, every compound
      // would offer a patch it has no data for.
      const derivable = resolveTransdermalInput(compound) !== undefined;
      return {
        route,
        label,
        derivable,
        available: compound.routes.transdermal?.available ?? false,
        reason: derivable
          ? undefined
          : 'No transdermal product data (delivery rate and wear duration) in this compound file',
      };
    }
    // IV routes only need disposition (Vd + ke), which every compound has.
    return { route, label, derivable: true, available: compound.routes[route]?.available ?? false };
  });
}

/**
 * A sensible route to select when a compound is first shown: the first route
 * that is both derivable and marked available; failing that, the first derivable
 * one (every compound has at least `iv_bolus`). Used to reset the route when the
 * user switches compounds so a stale, non-derivable route never sticks.
 */
export function defaultRoute(compound: Compound): DataRoute {
  const options = routeOptions(compound);
  const preferred =
    options.find((o) => o.derivable && o.available) ?? options.find((o) => o.derivable);
  return preferred?.route ?? 'iv_bolus';
}
