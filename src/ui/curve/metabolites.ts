/**
 * Metabolite helpers shared by every linear curve builder.
 *
 * The three linear builders draw metabolites the same way — which ones, what
 * route-dependent terms to strip, which formation model each input type uses —
 * and differ only in how they describe the parent. So they each hand over a
 * {@link MetaboliteParent} and the rest is answered once, here. It was answered
 * three times, in step, before; see `src/ui/peak.ts` for the same consolidation
 * one level up.
 */

import {
  appliesFirstPass,
  deriveMetaboliteDisposition,
  type DerivedMetaboliteDisposition,
} from '../../data/derive.ts';
import type { Compound, DataRoute } from '../../data/schema.ts';
import {
  infusionMetaboliteConcentrationCurve,
  oralMetaboliteConcentrationCurve,
} from '../../engine/metabolite.ts';
import type { DoseEvent, ExpMode, MetaboliteDisposition, Route } from '../../engine/types.ts';
import { findPeak } from './grid.ts';
import { DEFAULT_INFUSION_DURATION_H } from './schedule.ts';
import type { MetaboliteCurve } from './types.ts';

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

/** A metabolite's derived disposition, paired with the declaration it came from. */
export type MetaboliteDerivation = DerivedMetaboliteDisposition & {
  meta: NonNullable<Compound['metabolites']>[number];
};

/**
 * Derive every declared metabolite for `route`, with the route's pre-systemic term
 * already stripped. Derived UP FRONT, before the grid exists, because a long-lived
 * metabolite (`keM` below the parent's slowest rate) must extend the horizon or it
 * is clipped mid-decay.
 *
 * Every engine input type forms metabolites, so there is no route gate. (One stood
 * here, listing `iv_bolus`, `oral` and `iv_infusion` — all three members of the
 * engine's `Route` union, so it admitted everything and only looked like a filter.)
 * An MM parent never reaches this: its builder does not call it.
 */
export function deriveMetabolites(
  compound: Compound,
  route: DataRoute,
  weightKg: number | undefined,
): MetaboliteDerivation[] {
  return (compound.metabolites ?? []).map((m) => ({
    meta: m,
    ...stripFirstPassUnlessOral(route, deriveMetaboliteDisposition(m, { weightKg })),
  }));
}

/**
 * What metabolite formation needs to know about the parent curve it is drawn
 * under. Formation follows the parent the reader SEES, so these are the plotted
 * parameters — slider overrides included — not the compound's nominals.
 */
export interface MetaboliteParent {
  /** The parent's disposition as unit-dose modes, `Σ coef·e^(−rate·t)` for 1 mg. */
  unitModes: ExpMode[];
  /** Parent clearance, L/h. */
  cl: number;
  /** Absorption rate constant, 1/h — read on the engine `oral` path only. */
  ka?: number;
  /** Bioavailable fraction — read on the engine `oral` path only. */
  F?: number;
  /** Zero-order input window, h — read on the engine `iv_infusion` path only. */
  infusionDuration?: number;
  /**
   * The IV-bolus formation model. The one input type each disposition model's
   * engine writes for itself rather than through the shared mode convolution.
   */
  ivBolus: (meta: MetaboliteDisposition, doses: DoseEvent[], times: number[]) => number[];
}

/**
 * Evaluate each metabolite over the parent's grid and schedule, or `undefined`
 * when the compound declares none (the chart draws no metabolite rows at all).
 *
 * The formation model is chosen by ENGINE route, in an exhaustive `Record`. Each
 * builder used to choose it with its own `oral ? … : iv_infusion ? … : bolus`
 * chain, and that chain was once wrong in all three copies at once: it asked the
 * CLINICAL route `route === 'iv_infusion'`, so a patch — which rides the engine's
 * infusion path — would have had its metabolite drawn with the IV-bolus model, the
 * whole wear-period dose arriving at t = 0. Latent, because clonidine declares no
 * metabolites; found by grepping route ternaries. An IM parent forms its metabolite
 * through the same first-order convolution as an oral one — what differs is the
 * pre-systemic term, already stripped by {@link stripFirstPassUnlessOral}.
 */
export function metaboliteCurves(
  derivations: MetaboliteDerivation[],
  engineRoute: Route,
  parent: MetaboliteParent,
  doses: DoseEvent[],
  times: number[],
): MetaboliteCurve[] | undefined {
  if (derivations.length === 0) return undefined;
  return derivations.map(({ meta, params: mp, derived, warnings }) => {
    const formation: Record<Route, () => number[]> = {
      oral: () =>
        oralMetaboliteConcentrationCurve(
          parent.unitModes,
          parent.cl,
          parent.ka ?? 0,
          parent.F ?? 1,
          mp,
          doses,
          times,
        ),
      iv_infusion: () =>
        infusionMetaboliteConcentrationCurve(
          parent.unitModes,
          parent.cl,
          mp,
          doses,
          parent.infusionDuration ?? DEFAULT_INFUSION_DURATION_H,
          times,
        ),
      iv_bolus: () => parent.ivBolus(mp, doses, times),
    };
    const c = formation[engineRoute]();
    const points = times.map((t, i) => ({ t, c: c[i] ?? 0 }));
    return {
      id: meta.id,
      name: meta.name,
      active: meta.active,
      points,
      peak: findPeak(points),
      derived,
      warnings,
    };
  });
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
