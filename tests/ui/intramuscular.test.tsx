import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import { appliesFirstPass, engineRouteOf } from '../../src/data/derive.ts';
import { PeakNote } from '../../src/ui/App.tsx';
import { buildCurve, routeOptions, type DoseSchedule } from '../../src/ui/curve.ts';
import type { Compound } from '../../src/data/schema.ts';

/**
 * The intramuscular route (handoff §12, "more routes") — the mirror of
 * `transdermal.test.tsx`.
 *
 * Like a patch, an IM depot adds NO engine math: it is a first-order input, which
 * the engine's `oral` route already is. So there is no new closed form to prove.
 * What is new — and what nothing else in the suite can see — is that IM SHARES an
 * engine input type with oral while differing from it clinically, and every bug
 * this route can have lives in that gap:
 *
 *  1. the magnitude check, which `npm test` is otherwise blind to (CLAUDE.md's
 *     standing trap) — and which matters more here than on any previous route,
 *     because IM is the first route whose peak is an OBSERVABLE reported number,
 *     so it is the first real test of ketamine's central volume;
 *  2. the pre-systemic first-pass term must NOT ride an injection, even though the
 *     engine computes IM through the same code path as a swallowed tablet;
 *  3. the on-screen prose must not explain an injection as a tablet — the
 *     route-ternary fallthrough that shipped a patch described as an oral dose
 *     (docs/HISTORY.md), which had 522 green tests and a happy typechecker;
 *  4. IM is offered only by a compound that actually carries IM data, and never
 *     by borrowing oral's.
 */

const compounds = loadAllCompounds();
const ketamine = compounds.find((c) => c.id === 'ketamine');
const morphine = compounds.find((c) => c.id === 'morphine');

/** mg/L → ng/mL. */
const MG_PER_L_TO_NG_PER_ML = 1000;

const single = (amount: number): DoseSchedule => ({ amount, count: 1, interval: 0, adHoc: [] });

describe('engineRouteOf — the clinical→input-type mapping', () => {
  it('resolves im onto the engine first-order (oral) input', () => {
    expect(engineRouteOf('im')).toBe('oral');
  });

  it('leaves transdermal on the zero-order input — the two mappings are independent', () => {
    expect(engineRouteOf('transdermal')).toBe('iv_infusion');
  });
});

describe('appliesFirstPass — what sharing an input type does NOT share', () => {
  it('is true for oral only: an injection crosses neither gut wall nor portal liver', () => {
    expect(appliesFirstPass('oral')).toBe(true);
    expect(appliesFirstPass('im')).toBe(false);
    expect(appliesFirstPass('iv_bolus')).toBe(false);
    expect(appliesFirstPass('transdermal')).toBe(false);
  });
});

describe('ketamine IM — the magnitude check the suite is otherwise blind to', () => {
  it('reproduces reported Cmax across a 12-fold dose range', () => {
    if (!ketamine) throw new Error('ketamine compound missing');
    // Ananyev & Myers 2026 (Eur J Drug Metab Pharmacokinet 51:347-358), adult IM.
    // Their series is linear at ~328 ng/mL per mg/kg; the 1.0 mg/kg point is the
    // low outlier within their own data, which is why the tolerance is stated per
    // dose rather than as one number.
    const reported: Array<[number, number, number]> = [
      // [mg/kg, reported Cmax ng/mL, allowed relative gap]
      [0.5, 189, 0.25],
      [1.0, 297, 0.3],
      [6.0, 1970, 0.25],
    ];
    for (const [mgPerKg, cmaxNgPerMl, tol] of reported) {
      const curve = buildCurve({
        compound: ketamine,
        route: 'im',
        schedule: single(mgPerKg * 70),
      });
      const modelled = curve.peak.c * MG_PER_L_TO_NG_PER_ML;
      expect(Math.abs(modelled - cmaxNgPerMl) / cmaxNgPerMl).toBeLessThan(tol);
    }
  });

  it('peaks inside the reported 10–30 min Tmax window', () => {
    if (!ketamine) throw new Error('ketamine compound missing');
    const curve = buildCurve({ compound: ketamine, route: 'im', schedule: single(70) });
    expect(curve.peak.t * 60).toBeGreaterThan(10);
    expect(curve.peak.t * 60).toBeLessThan(30);
  });

  it('is not flip-flop and not near the distribution eigenvalue', () => {
    if (!ketamine) throw new Error('ketamine compound missing');
    const curve = buildCurve({ compound: ketamine, route: 'im', schedule: single(70) });
    if (curve.model !== 'two_compartment_first_order') {
      throw new Error('ketamine is expected to be two-compartment');
    }
    // ka must clear BOTH rates: below β it would be flip-flop (the tail would be
    // absorption, not elimination); near α the near-equal-rates guard would be
    // doing the work and the peak amplitude would be fragile.
    const beta = Math.LN2 / curve.terminalHalfLifeH;
    const alpha = Math.LN2 / curve.distributionHalfLifeH;
    expect(curve.params.ka ?? 0).toBeGreaterThan(4 * beta);
    expect(curve.params.ka ?? 0).toBeGreaterThan(1.5 * alpha);
  });

  it('draws the norketamine line, formed systemically as on IV', () => {
    if (!ketamine) throw new Error('ketamine compound missing');
    const curve = buildCurve({ compound: ketamine, route: 'im', schedule: single(70) });
    expect(curve.metabolites?.length).toBe(1);
  });
});

describe('first-pass must not ride an injection', () => {
  /**
   * The sharp oracle. Morphine carries `ffp` (pre-systemic glucuronidation) and is
   * the only compound that does at scale. Give it a synthetic IM route with F and
   * ka set EQUAL to its oral ones: the two routes then hand the engine identical
   * parameters, so the PARENT curves must coincide exactly — and any difference in
   * the METABOLITE curves can only be the first-pass term.
   *
   * Morphine does not ship an IM route (it defers on the `F·D/V` ceiling test), so
   * this is a constructed compound, deliberately. It pins the guard rather than a
   * shipped curve, because the guard is what a future IM compound with `ffp` will
   * silently depend on.
   */
  const withSyntheticIm = (base: Compound): Compound => ({
    ...base,
    routes: {
      ...base.routes,
      im: {
        available: true,
        F: base.routes.oral?.F,
        ka: base.routes.oral?.ka,
        tmax: base.routes.oral?.tmax,
      },
    },
  });

  it('gives an IM parent curve identical to oral when F and ka match', () => {
    if (!morphine) throw new Error('morphine compound missing');
    const c = withSyntheticIm(morphine);
    const oral = buildCurve({ compound: c, route: 'oral', schedule: single(30) });
    const im = buildCurve({ compound: c, route: 'im', schedule: single(30) });
    expect(im.peak.c).toBeCloseTo(oral.peak.c, 12);
    expect(im.peak.t).toBeCloseTo(oral.peak.t, 12);
  });

  it('but a STRICTLY LOWER metabolite exposure — the pre-systemic term is gone', () => {
    if (!morphine) throw new Error('morphine compound missing');
    const c = withSyntheticIm(morphine);
    const oral = buildCurve({ compound: c, route: 'oral', schedule: single(30) });
    const im = buildCurve({ compound: c, route: 'im', schedule: single(30) });
    const peakOf = (curve: typeof oral, id: string) =>
      Math.max(...(curve.metabolites?.find((m) => m.id === id)?.points ?? []).map((p) => p.c), 0);
    const m3gId = morphine.metabolites?.[0]?.id;
    if (!m3gId) throw new Error('morphine M3G metabolite missing');
    // Identical parent, identical fm, identical Vd_m — so if the injection still
    // carried gut/hepatic first-pass mass these would be equal. They must not be.
    expect(peakOf(im, m3gId)).toBeLessThan(peakOf(oral, m3gId) * 0.9);
    expect(peakOf(im, m3gId)).toBeGreaterThan(0);
  });
});

describe('the IM route is offered only where it is real', () => {
  it('ketamine offers IM, and it is both derivable and marked available', () => {
    if (!ketamine) throw new Error('ketamine compound missing');
    const im = routeOptions(ketamine).find((o) => o.route === 'im');
    expect(im?.derivable).toBe(true);
    expect(im?.available).toBe(true);
  });

  it('an oral-only compound does NOT inherit an IM route from its oral data', () => {
    // The failure this guards is quiet: `oral` and `im` have identical types, so a
    // fallback to `routes.oral` would typecheck and would plot a confident curve
    // for an injection nobody has data for.
    const oralOnly = compounds.find((c) => c.routes.oral && !c.routes.im);
    if (!oralOnly) throw new Error('expected at least one oral-only compound');
    const im = routeOptions(oralOnly).find((o) => o.route === 'im');
    expect(im?.derivable).toBe(false);
    expect(im?.available).toBe(false);
  });
});

describe('PeakNote — an injection is not explained as a tablet', () => {
  const render = (route: 'im' | 'oral') =>
    renderToStaticMarkup(<PeakNote route={route} schedule={single(70)} />);

  it('names the muscle depot, not the gut', () => {
    const html = render('im');
    expect(html).toContain('intramuscular dose');
    expect(html).toContain('muscle depot');
  });

  it('does not fall through to the oral sentence', () => {
    // The exact fallthrough that shipped a patch described as an oral dose.
    expect(render('im')).not.toContain('An oral dose rises');
    expect(render('oral')).toContain('An oral dose rises');
  });

  it('says an IM F carries no first-pass loss — the whole point of the route', () => {
    const html = render('im');
    expect(html).toMatch(/first-pass/);
    expect(html).toMatch(/absorption completeness/);
  });
});
