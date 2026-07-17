import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import { engineRouteOf, resolveTransdermalInput } from '../../src/data/derive.ts';
import { PeakNote } from '../../src/ui/App.tsx';
import { buildCurve, routeOptions, type DoseSchedule } from '../../src/ui/curve.ts';

/**
 * The transdermal route (handoff §12, "more routes").
 *
 * A patch introduces NO new engine math — it is a zero-order input, which is what
 * the engine's `iv_infusion` already is — so there is no new closed form to prove
 * here. What this file pins instead is the three things that ARE new and that
 * nothing else can see:
 *
 *  1. the plateau is right, against the analytic oracle `Css = R0/CL` AND against
 *     the number the product label independently reports (the magnitude check that
 *     `npm test` is otherwise blind to — CLAUDE.md's standing trap);
 *  2. the patch window ends at patch-off, so the post-removal decline — the one
 *     part of a patch curve this model gets WRONG — is never drawn;
 *  3. a patch is offered only by a compound that actually has one.
 *
 * (1) matters most: for a zero-order input the steady state is `R0/CL` and depends
 * on clearance ALONE, not on Vd — so it is a genuinely free check on the data file,
 * not a restatement of it.
 */

const compounds = loadAllCompounds();
const clonidine = compounds.find((c) => c.id === 'clonidine');

/** mg/L → ng/mL (both are ×10⁻⁶ apart: 1 mg/L = 1000 ng/mL). */
const MG_PER_L_TO_NG_PER_ML = 1000;

/** A single patch application at t = 0. */
const singlePatch = (amount: number): DoseSchedule => ({ amount, count: 1, interval: 0, adHoc: [] });

describe('engineRouteOf — the clinical→input-type mapping', () => {
  it('resolves transdermal onto the engine zero-order (infusion) input', () => {
    expect(engineRouteOf('transdermal')).toBe('iv_infusion');
  });

  it('leaves every route that IS an engine input type untouched', () => {
    expect(engineRouteOf('oral')).toBe('oral');
    expect(engineRouteOf('iv_bolus')).toBe('iv_bolus');
    expect(engineRouteOf('iv_infusion')).toBe('iv_infusion');
  });
});

describe('clonidine — the first transdermal compound', () => {
  it('is bundled and carries a transdermal route', () => {
    expect(clonidine).toBeDefined();
    expect(clonidine!.routes.transdermal?.available).toBe(true);
  });

  it('resolves the patch input to canonical units (0.1 mg/day over 7 days)', () => {
    const patch = resolveTransdermalInput(clonidine!);
    expect(patch).toBeDefined();
    // 0.1 mg/day → mg/h
    expect(patch!.rateMgPerH).toBeCloseTo(0.1 / 24, 10);
    // 7 days → h
    expect(patch!.wearDurationH).toBeCloseTo(168, 10);
    // total delivered over one wear period
    expect(patch!.doseMg).toBeCloseTo(0.7, 10);
  });

  /**
   * THE MAGNITUDE CHECK. Catapres-TTS-1 delivers 0.1 mg/day and the label reports
   * a mean steady-state plasma concentration of ~0.4 ng/mL. The model is handed the
   * delivery rate and the clearance; the 0.4 is never given to it, so reproducing
   * it is a real test of the data file rather than a tautology.
   *
   * This is also the regression guard for the double-count trap: applying the
   * label's separately-reported "absolute bioavailability approximately 60%" on top
   * of the delivered rate would land at ~0.24 ng/mL — a plausible-looking curve that
   * only this assertion can tell apart from the right one.
   */
  it('reaches the label-reported steady state of ~0.4 ng/mL (TTS-1)', () => {
    const patch = resolveTransdermalInput(clonidine!)!;
    const result = buildCurve({
      compound: clonidine!,
      route: 'transdermal',
      schedule: singlePatch(patch.doseMg),
    });

    // The plateau: the last point of a 7-day wear is at steady state (the ~12.9 h
    // half-life has had ~13 half-lives to equilibrate).
    const plateauNgPerMl = result.points.at(-1)!.c * MG_PER_L_TO_NG_PER_ML;
    expect(plateauNgPerMl).toBeGreaterThan(0.36);
    expect(plateauNgPerMl).toBeLessThan(0.44);

    // …and it agrees with the analytic oracle Css = R0/CL, which depends on
    // clearance alone. CL = 177 mL/min = 10.62 L/h.
    const clLPerH = 177 * (60 / 1000);
    const cssOracle = (patch.rateMgPerH / clLPerH) * MG_PER_L_TO_NG_PER_ML;
    expect(cssOracle).toBeCloseTo(0.392, 3);
    expect(plateauNgPerMl).toBeCloseTo(cssOracle, 2);
  });

  /**
   * THE APPROACH, not just the plateau — this is where Vd re-enters (ke = CL/Vz).
   * The label: "Steady-state clonidine plasma levels are obtained within 3 days"
   * and therapeutic levels "achieved 2 to 3 days after initial application".
   */
  it('approaches that plateau on the label-reported timescale (~90% by 2 days)', () => {
    const patch = resolveTransdermalInput(clonidine!)!;
    const result = buildCurve({
      compound: clonidine!,
      route: 'transdermal',
      schedule: singlePatch(patch.doseMg),
    });
    const plateau = result.points.at(-1)!.c;

    const at = (hours: number) =>
      result.points.reduce((best, p) =>
        Math.abs(p.t - hours) < Math.abs(best.t - hours) ? p : best,
      ).c;

    // Rising, not instantaneous: a patch is not a bolus.
    expect(at(0)).toBeCloseTo(0, 10);
    expect(at(48) / plateau).toBeGreaterThan(0.85);
    expect(at(48) / plateau).toBeLessThan(0.95);
    // At steady state by ~3 days, as the label reports.
    expect(at(72) / plateau).toBeGreaterThan(0.97);
  });

  /**
   * THE HONESTY GUARD, and the reason clonidine could ship when nicotine and
   * fentanyl could not. Clonidine HAS a skin depot: the label says that after
   * removal, levels "persist for about 8 hours and then decline slowly", at an
   * apparent ~20 h half-life — LONGER than clonidine's own 12–16 h, because the
   * drug is still being absorbed. A rectangular window switched off at removal
   * would draw that decline on the wrong rate constant.
   *
   * So the window ends AT patch-off and the compound is worn for all of it. If a
   * future change re-introduces the generic "+5 half-lives" tail here, this fails —
   * which is the point, because on screen that tail would look perfectly plausible.
   */
  it('ends the plotted window at patch-off, never drawing the post-removal decline', () => {
    const patch = resolveTransdermalInput(clonidine!)!;
    const result = buildCurve({
      compound: clonidine!,
      route: 'transdermal',
      schedule: singlePatch(patch.doseMg),
    });

    const lastT = result.points.at(-1)!.t;
    expect(lastT).toBeCloseTo(patch.wearDurationH, 6);
    // Nothing is sampled beyond the wear period.
    expect(result.points.every((p) => p.t <= patch.wearDurationH + 1e-9)).toBe(true);
    // And the curve is still RISING at the right edge (monotone to the end) — it
    // never turns over, because nothing is ever taken off.
    const tail = result.points.slice(-5);
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]!.c).toBeGreaterThanOrEqual(tail[i - 1]!.c - 1e-12);
    }
  });
});

/**
 * THE OPENING-DOSE GUARD — the number that has to agree with itself.
 *
 * A patch's magnitude does NOT come from its `deliveryRate`: `buildCurve` takes the
 * rate from the SCHEDULE, as `R0 = amount / wearDuration`, so what the chart opens at
 * is the dose App puts in the box. App only overrides the typed dose when a compound
 * declares `illustrativeDoseMg` (otherwise the user's number is kept) — so for a patch
 * that field is not cosmetic, it is load-bearing:
 *
 *  - if it is ABSENT, switching from a 500 mg compound plots the patch at 500/168 =
 *    2.98 mg/h — the right shape at ~700× the right concentration;
 *  - if it DISAGREES with `deliveryRate × wearDuration` (they are the same quantity
 *    written twice), the chart opens at a rate the compound's own data denies.
 *
 * Neither is visible: both render a perfectly plausible plateau. So the duplication is
 * pinned here rather than trusted.
 */
describe('a patch opens at the dose its own data implies', () => {
  const patches = compounds.filter((c) => c.routes.transdermal !== undefined);

  it('there is at least one patch compound to check', () => {
    expect(patches.length).toBeGreaterThan(0);
  });

  for (const compound of patches) {
    it(`${compound.id}: illustrativeDoseMg = deliveryRate × wearDuration`, () => {
      const patch = resolveTransdermalInput(compound)!;
      expect(compound.illustrativeDoseMg).toBeDefined();
      expect(compound.illustrativeDoseMg!).toBeCloseTo(patch.doseMg, 9);
    });
  }
});

/**
 * THE FALLTHROUGH GUARD. `PeakNote`'s route explanation is a ternary chain, and
 * `transdermal` originally fell through its `else` and told the viewer a patch
 * "rises as it is absorbed and falls as it is eliminated; the peak (Tmax) is where
 * those balance" — the ORAL story, on a curve that never falls at all. Every test
 * passed and the typechecker was satisfied: a new route silently inherits the last
 * branch. Only launching the app showed it.
 *
 * So the copy gets pinned. A patch has no peak, and nothing here may say it does.
 */
describe('PeakNote — a patch is not described as peaking', () => {
  const schedule: DoseSchedule = { amount: 0.7, count: 1, interval: 0, adHoc: [] };
  const html = renderToStaticMarkup(<PeakNote route="transdermal" schedule={schedule} />);

  it('does not claim a Tmax, or reuse the oral absorption/elimination story', () => {
    expect(html).not.toMatch(/Tmax/);
    expect(html).not.toMatch(/rises as it is absorbed/);
    expect(html).not.toMatch(/Cmax/);
  });

  it('explains the plateau and what the marker actually is', () => {
    expect(html).toMatch(/End of wear/);
    expect(html).toMatch(/no peak/);
    expect(html).toMatch(/Css = R0\/CL/);
    // The plateau is set by clearance alone — the point of a zero-order input.
    expect(html).toMatch(/clearance alone/);
  });

  /**
   * The other routes must be untouched: this fix must not have "fixed" them into
   * the patch branch, which is the mirror-image of the bug it repairs.
   */
  it('leaves the peaking routes still describing a peak', () => {
    for (const route of ['oral', 'iv_bolus', 'iv_infusion'] as const) {
      const other = renderToStaticMarkup(<PeakNote route={route} schedule={schedule} />);
      expect(other).toMatch(/Cmax \/ Tmax/);
      expect(other).not.toMatch(/End of wear/);
    }
  });
});

describe('routeOptions — a patch is offered only where there is one', () => {
  it('marks transdermal derivable for clonidine', () => {
    const option = routeOptions(clonidine!).find((o) => o.route === 'transdermal');
    expect(option?.derivable).toBe(true);
    expect(option?.available).toBe(true);
    expect(option?.label).toBe('Transdermal patch');
  });

  /**
   * The IV routes are derivable from disposition alone, so they are offered for
   * every compound. A patch must NOT inherit that: without product data there is no
   * input to plot, and offering it would invent one.
   */
  it('marks transdermal NOT derivable for every compound without patch data', () => {
    const others = compounds.filter((c) => c.routes.transdermal === undefined);
    expect(others.length).toBeGreaterThan(0);
    for (const compound of others) {
      const option = routeOptions(compound).find((o) => o.route === 'transdermal');
      expect(option?.derivable).toBe(false);
      expect(option?.reason).toMatch(/No transdermal product data/);
    }
  });
});
