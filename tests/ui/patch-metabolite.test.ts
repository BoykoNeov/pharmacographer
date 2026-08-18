import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import type { Compound } from '../../src/data/schema.ts';
import { buildCurve, type DoseSchedule } from '../../src/ui/curve.ts';

/**
 * A metabolite formed under a PATCH is formed at the patch's rate, not from a
 * bolus.
 *
 * Found by grepping route ternaries while consolidating the peak copy into
 * `src/ui/peak.ts`, and it is the `fRangeOral` defect again in a new place: the
 * gate admitting a compound to the metabolite branch asks the ENGINE route
 * (`iv_bolus || oral || iv_infusion`), which a patch passes — `engineRouteOf(
 * 'transdermal')` is `iv_infusion` — while the chain choosing the formation model
 * then asked the CLINICAL route and found no match. A transdermal parent with a
 * metabolite therefore fell through to `metaboliteConcentrationCurve`, the
 * IV-BOLUS model: the entire wear-period dose arriving instantaneously at t = 0.
 *
 * Latent, not live: clonidine is the only patch in the set and declares no
 * metabolites, so nothing on screen was ever wrong. It is pinned anyway, because
 * the day a second patch ships is exactly the day nobody is looking at this line
 * — and the failure is a plausible-looking curve, not a crash.
 *
 * The discriminator is TIMING, and it is stark. Under the bolus model formation
 * is driven by a parent that is at its maximum at t = 0 and only falls, so the
 * metabolite peaks in the first hours. Under the correct zero-order model the
 * parent climbs toward `Css` across the whole 168 h wear, so the metabolite peaks
 * at the very end. No tolerance argument is needed to tell those apart.
 */

const clonidine = loadAllCompounds().find((c) => c.id === 'clonidine');

/**
 * Clonidine plus a synthetic metabolite. Synthetic on purpose — the point is the
 * route plumbing, and inventing plausible-looking numbers for a REAL clonidine
 * metabolite would put an uncited parameter in the repo to test a code path
 * (docs/DATA_GUIDE.md: never ship a number you cannot source). Nothing here
 * reaches a compound file or the screen.
 */
function withSyntheticMetabolite(parent: Compound): Compound {
  return {
    ...parent,
    metabolites: [
      {
        id: 'test-metabolite',
        name: 'Synthetic test metabolite',
        active: false,
        fractionFormed: {
          value: 50,
          unit: 'percent',
          derived: true,
          sourceRef: 'definition',
          conditions: 'Illustrative only — a test fixture, not a curated parameter.',
        },
        vd: {
          value: 1,
          unit: 'L/kg',
          derived: true,
          sourceRef: 'definition',
          conditions: 'Illustrative only — a test fixture, not a curated parameter.',
        },
        halfLife: {
          value: 6,
          unit: 'h',
          derived: true,
          sourceRef: 'definition',
          conditions: 'Illustrative only — a test fixture, not a curated parameter.',
        },
      },
    ],
  } as Compound;
}

describe('a transdermal parent forms its metabolite at the patch rate', () => {
  const schedule: DoseSchedule = { amount: 0.7, count: 1, interval: 0, adHoc: [] };

  it('draws a metabolite line at all (the engine-route gate admits a patch)', () => {
    const curve = buildCurve({
      compound: withSyntheticMetabolite(clonidine!),
      route: 'transdermal',
      schedule,
    });
    expect(curve.metabolites).toHaveLength(1);
  });

  it('peaks near the end of wear, not in the first hours like a bolus would', () => {
    const curve = buildCurve({
      compound: withSyntheticMetabolite(clonidine!),
      route: 'transdermal',
      schedule,
    });
    const metabolite = curve.metabolites![0]!;
    // The parent climbs toward Css for the whole wear period, so its metabolite
    // does too. Under the bolus model this landed in the first few hours of 168.
    expect(metabolite.peak.t).toBeGreaterThan(curve.horizonH * 0.9);
  });

  it('rises monotonically — a bolus-formed metabolite would rise then fall', () => {
    const curve = buildCurve({
      compound: withSyntheticMetabolite(clonidine!),
      route: 'transdermal',
      schedule,
    });
    const points = curve.metabolites![0]!.points;
    // Sampled coarsely: the claim is the SHAPE, and a grid-adjacent wobble at the
    // 1e-15 level is not a turning point.
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.c, `metabolite fell at t=${points[i]!.t} h`).toBeGreaterThanOrEqual(
        points[i - 1]!.c - 1e-12,
      );
    }
  });
});
