/**
 * The route vocabulary seam: which engine input type computes each clinical
 * route, whether a route carries first pass, which absorption block a route
 * reads, how its bioavailability is named, and a patch's zero-order input.
 */

import type { Route } from '../../engine/types.ts';
import { massRate, time } from '../../engine/units.ts';
import type { Compound, DataRoute } from '../schema.ts';

/**
 * Map a clinical {@link DataRoute} onto the engine INPUT TYPE that computes it
 * (handoff §12). Two routes move, in opposite directions: `transdermal` is a
 * zero-order input, which is precisely what the engine's `iv_infusion` already is;
 * `im` is a first-order input from a depot, which is precisely what the engine's
 * `oral` already is. Neither needs an engine change — see {@link DataRoute} for why
 * the engine's union deliberately stays narrower than the data's.
 *
 * The two vocabularies are NOT interchangeable for the user, only for the math: the
 * honesty UI must still say "absorbed through skin" or "injected into muscle", never
 * "intravenous" or "swallowed", and the caller keeps the DataRoute for labelling.
 * This function is the one place they meet.
 *
 * READ {@link appliesFirstPass} BEFORE TREATING A MAPPED ROUTE AS ITS TARGET. Sharing
 * an input type is a claim about the SHAPE of the input, not about everything that
 * happens on the way in. `im` and `oral` are both first-order, and only one of them
 * passes through gut wall and portal liver first.
 */
export function engineRouteOf(route: DataRoute): Route {
  if (route === 'transdermal') return 'iv_infusion';
  if (route === 'im' || route === 'sc' || route === 'rectal') return 'oral';
  return route;
}

/**
 * Whether a clinical route's dose crosses gut wall and portal liver before reaching
 * the systemic circulation — i.e. whether a metabolite's pre-systemic
 * `firstPassFraction` (`ffp`) term applies to it.
 *
 * ONLY `oral` does. This exists because {@link engineRouteOf} maps the injected depot
 * routes (`im`, `sc`) onto the engine's `oral`, and the engine — correctly — keys on
 * input type and cannot tell a needle from a tablet. Left unstripped, an injected curve
 * for a compound carrying `ffp` would draw a first-pass metabolite peak off a dose that
 * never met a hepatocyte before reaching the blood: silently wrong, and invisible to the
 * typechecker, since the routes have identical types. No shipped compound currently pairs
 * `ffp` with an injected route (morphine has `ffp` but defers IM on the `F·D/V` ceiling
 * test; sumatriptan ships `sc` but no metabolite), so this guards a trap rather than
 * fixing a live bug — the same posture as the unused `mixed` branch of
 * `HalfLifeAxisRegime`. Note that `sc` needed no new branch here, only a wider `im` one:
 * both are injections, so both bypass first pass for the same reason.
 *
 * `rectal` RETURNS FALSE, AND THAT IS AN APPROXIMATION RATHER THAN A FACT — the one
 * place this function stops being a clean partition (see {@link RectalRouteSchema}).
 * Rectal drainage is split between the portal and systemic circulations, so part of a
 * rectal dose genuinely does form metabolite pre-systemically. `false` is chosen over
 * `true` because `ffp` needs a FRACTION, and no source quantifies the split: `true`
 * would apply oral's whole `ffp` to a route that only partly earns it, which overstates
 * by an unknown amount, while `false` understates by an amount bounded by the same
 * unknown. What makes the approximation tolerable rather than merely convenient is
 * that a rectal `F` is stored as an EMPIRICAL, lumped number — the pre-systemic loss is
 * already inside it, so the parent curve is right either way, and only a metabolite's
 * pre-systemic FORMATION is at stake. No shipped compound pairs `rectal` with `ffp`
 * (diazepam is the only rectal compound and nordiazepam fails the first-pass timing
 * screen outright), so, like the IM case above, this guards a trap. A compound that
 * ever needs both wants a quantified split, not a flipped boolean.
 *
 * The stripping happens HERE, in the data layer, and not in the engine, because
 * "an injection bypasses first pass" is a clinical fact about routes of
 * administration, which the engine is required not to know (handoff §4).
 */
export function appliesFirstPass(route: DataRoute): boolean {
  return route === 'oral';
}

/**
 * The absorption parameters (`F`, `ka`, `tmax`) for whichever first-order route is
 * being derived. `oral` and `im` share this shape deliberately (see `ImRouteSchema`),
 * so every absorption derivation reads them through here rather than reaching for
 * `compound.routes.oral` — which is what silently gave an IM curve no absorption at
 * all in the first cut of this route.
 *
 * Returns `undefined` for any route that is not a first-order input.
 */
export function absorptionRouteOf(
  compound: Compound,
  route: DataRoute,
):
  | Compound['routes']['oral']
  | Compound['routes']['im']
  | Compound['routes']['sc']
  | Compound['routes']['rectal'] {
  if (route === 'oral') return compound.routes.oral;
  if (route === 'im') return compound.routes.im;
  if (route === 'sc') return compound.routes.sc;
  if (route === 'rectal') return compound.routes.rectal;
  return undefined;
}

/**
 * How to name this route's bioavailability in a warning or provenance row. An IM
 * `F` is absorption completeness; an oral `F` additionally carries first-pass loss;
 * a rectal `F` carries part of one. Calling both "oral bioavailability" under an
 * injection is the route-ternary fallthrough that shipped a patch explained as a
 * tablet (see `docs/HISTORY.md`), which is why this is a lookup and not a ternary
 * chain — a route added to {@link DataRoute} without a name here fails to compile
 * instead of silently inheriting the last branch.
 */
const BIOAVAILABILITY_LABELS: Record<DataRoute, string> = {
  oral: 'oral bioavailability F',
  im: 'intramuscular bioavailability F',
  sc: 'subcutaneous bioavailability F',
  rectal: 'rectal bioavailability F',
  // Unreachable: every call site sits inside an `engineRouteOf(route) === 'oral'`
  // guard, so only the three first-order routes above can arrive here. Named anyway
  // because the Record is exhaustive by type — that exhaustiveness is the point, and
  // a plausible-looking 'oral bioavailability F' in these three slots would be a
  // false string waiting for the day a caller moves.
  iv_bolus: 'bioavailability F',
  iv_infusion: 'bioavailability F',
  transdermal: 'bioavailability F',
};

export function bioavailabilityLabel(route: DataRoute): string {
  return BIOAVAILABILITY_LABELS[route];
}

/** A patch's zero-order input, resolved to canonical units. */
export interface TransdermalInput {
  /** Systemic delivery rate `R0`, mg/h — already systemic; see the schema. */
  rateMgPerH: number;
  /** Wear duration, h — the zero-order window. */
  wearDurationH: number;
  /** Total delivered over one wear period, mg (`R0 · wearDuration`). */
  doseMg: number;
}

/**
 * Resolve a compound's `transdermal` route to its canonical zero-order input.
 * Returns `undefined` for a compound with no patch, so callers can fall back.
 *
 * The engine's infusion driver is parameterised by a DOSE over a DURATION, while
 * a patch label states a RATE over a wear period; this converts between them
 * (`dose = R0 · wearDuration`), which is the whole of the transdermal route's
 * arithmetic. There is deliberately no `F` term — the schema forbids one, because
 * a stated delivered rate is already the systemic input and multiplying by the
 * separately-reported "absolute bioavailability" would double-count it.
 */
export function resolveTransdermalInput(compound: Compound): TransdermalInput | undefined {
  const td = compound.routes.transdermal;
  if (!td || td.deliveryRate.value === null || td.wearDuration.value === null) return undefined;

  const rateMgPerH = massRate.toCanonical(td.deliveryRate.value, td.deliveryRate.unit);
  const wearDurationH = time.toCanonical(td.wearDuration.value, td.wearDuration.unit);
  return { rateMgPerH, wearDurationH, doseMg: rateMgPerH * wearDurationH };
}
