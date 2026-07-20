import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import { appliesFirstPass, bioavailabilityLabel, engineRouteOf } from '../../src/data/derive.ts';
import { PeakNote } from '../../src/ui/App.tsx';
import { ModelAssumptionsNote } from '../../src/ui/components/ModelAssumptionsNote.tsx';
import { buildCurve, routeOptions, type DoseSchedule } from '../../src/ui/curve.ts';

/**
 * The rectal route (handoff §12, "more routes") — the third clinical route to ride
 * the engine's first-order input, after `oral` and `im`.
 *
 * Like those, it adds NO engine math, so there is no new closed form to prove. What
 * is new is that it makes the shared-input-type gap NON-BINARY. `im` established
 * that sharing an engine route does not mean sharing a clinical fact: oral carries
 * first pass, an injection does not. Rectal shows the fact was never a boolean —
 * rectal venous drainage is split, so it carries PART of one. The three meanings of
 * `F` now on screen are the teaching content, and every bug this route can have
 * lives in the gap between them:
 *
 *  1. the magnitude check, which `npm test` is otherwise blind to (CLAUDE.md's
 *     standing trap), against Cloyd 1998's reported rectal Cmax;
 *  2. the counter-intuitive result — HIGHER exposure, LOWER peak than oral at the
 *     same dose — which is the honest answer to "is rectal better?" and which a
 *     naive reading of F alone gets backwards;
 *  3. the on-screen prose must explain neither an injection's F nor a tablet's —
 *     the route-ternary fallthrough that has now shipped twice (docs/HISTORY.md);
 *  4. rectal is offered only by a compound carrying rectal data, never by
 *     borrowing oral's.
 */

const compounds = loadAllCompounds();
const diazepam = compounds.find((c) => c.id === 'diazepam');

/** mg/L → ng/mL. */
const MG_PER_L_TO_NG_PER_ML = 1000;

const single = (amount: number): DoseSchedule => ({ amount, count: 1, interval: 0, adHoc: [] });

describe('engineRouteOf — the clinical→input-type mapping', () => {
  it('resolves rectal onto the engine first-order (oral) input', () => {
    expect(engineRouteOf('rectal')).toBe('oral');
  });

  it('now maps three clinical routes onto one engine input, and they stay distinct', () => {
    expect(engineRouteOf('oral')).toBe('oral');
    expect(engineRouteOf('im')).toBe('oral');
    expect(engineRouteOf('rectal')).toBe('oral');
    // …while each keeps its own name for the quantity F denotes.
    expect(bioavailabilityLabel('oral')).toBe('oral bioavailability F');
    expect(bioavailabilityLabel('im')).toBe('intramuscular bioavailability F');
    expect(bioavailabilityLabel('rectal')).toBe('rectal bioavailability F');
  });
});

describe('appliesFirstPass — the one place the partition is an approximation', () => {
  it('is false for rectal, which is a modelling choice and not a claim of no bypass', () => {
    // Documented in derive.ts: rectal drainage is split, so part of a rectal dose
    // genuinely does form metabolite pre-systemically. `false` is chosen because
    // `ffp` needs a FRACTION and no source quantifies the split — and it is harmless
    // today only because no shipped compound pairs `rectal` with `ffp`.
    expect(appliesFirstPass('rectal')).toBe(false);
    expect(appliesFirstPass('oral')).toBe(true);
  });

  it('no shipped compound pairs a rectal route with a first-pass metabolite', () => {
    // The condition under which the approximation above is harmless. If this ever
    // fails, the fix is a quantified split, NOT flipping the boolean.
    for (const c of compounds) {
      if (!c.routes.rectal) continue;
      for (const m of c.metabolites ?? []) {
        expect(m.firstPassFraction).toBeUndefined();
      }
    }
  });
});

describe('diazepam rectal — the magnitude check the suite is otherwise blind to', () => {
  it('reproduces Cloyd 1998 Cmax within one reported SD', () => {
    if (!diazepam) throw new Error('diazepam compound missing');
    // Cloyd 1998 (Epilepsia 39:520-526), 15 mg rectal gel in 20 healthy volunteers:
    // second maximum 447 ± 91.1 ng/mL at ~70 min. The model runs under it because
    // the STORED Tmax is the label's 1.5 h, slower than Cloyd's ~1.17 h, and a
    // slower first-order input peaks later and lower. Tmax was taken from the source
    // before the curve was built; the height was left where it landed.
    const curve = buildCurve({ compound: diazepam, route: 'rectal', schedule: single(15) });
    const modelled = curve.peak.c * MG_PER_L_TO_NG_PER_ML;
    expect(modelled).toBeGreaterThan(447 - 91.1);
    expect(modelled).toBeLessThan(447 + 91.1);
  });

  it('peaks at the label Tmax, not at either of Cloyd two maxima', () => {
    if (!diazepam) throw new Error('diazepam compound missing');
    // A single first-order ka has exactly one maximum. Pinning it to the label's
    // summary is the documented simplification; asserting it here stops a future
    // edit from quietly re-pointing Tmax at one of the raw peaks.
    const curve = buildCurve({ compound: diazepam, route: 'rectal', schedule: single(15) });
    expect(curve.peak.t).toBeCloseTo(1.5, 2);
  });
});

describe('higher exposure, lower peak — the result a naive reading of F gets backwards', () => {
  const aucOf = (points: readonly { t: number; c: number }[]) => {
    let auc = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      if (!prev || !cur) continue;
      auc += ((cur.c + prev.c) / 2) * (cur.t - prev.t);
    }
    return auc;
  };

  it('rectal AUC exceeds oral AUC by exactly the ratio of their F values', () => {
    if (!diazepam) throw new Error('diazepam compound missing');
    // AUC = F·D/CL, so at equal dose the ratio is F_rectal/F_oral and NOTHING else —
    // independent of Vc, of ka, and of how many compartments the model has. This is
    // a self-consistency check on the plumbing (see the compound notes): it proves F
    // is applied cleanly on the new route and that the route does not touch clearance.
    const rectal = buildCurve({ compound: diazepam, route: 'rectal', schedule: single(15) });
    const oral = buildCurve({ compound: diazepam, route: 'oral', schedule: single(15) });
    const fRectal = diazepam.routes.rectal?.F?.value;
    const fOral = diazepam.routes.oral?.F?.value;
    if (!fRectal || !fOral) throw new Error('expected both F values to be stored');
    expect(aucOf(rectal.points) / aucOf(oral.points)).toBeCloseTo(fRectal / fOral, 2);
  });

  it('yet the rectal PEAK is lower than the oral one at the same dose', () => {
    if (!diazepam) throw new Error('diazepam compound missing');
    // The teaching point, and the reason Cmax and AUC are not interchangeable: more
    // of the dose gets in (F 0.904 vs 0.75) but it gets in more slowly (the two
    // Tmaxes, 1.5 h vs 1 h), and a first-order input spreads a larger delivered
    // fraction over more time. "Better bioavailability" and "higher concentration"
    // come apart here.
    const rectal = buildCurve({ compound: diazepam, route: 'rectal', schedule: single(15) });
    const oral = buildCurve({ compound: diazepam, route: 'oral', schedule: single(15) });
    expect(rectal.peak.c).toBeLessThan(oral.peak.c);
    expect(rectal.peak.t).toBeGreaterThan(oral.peak.t);
  });
});

describe('the rectal route is offered only where it is real', () => {
  it('diazepam offers rectal, and it is both derivable and marked available', () => {
    if (!diazepam) throw new Error('diazepam compound missing');
    const rectal = routeOptions(diazepam).find((o) => o.route === 'rectal');
    expect(rectal?.derivable).toBe(true);
    expect(rectal?.available).toBe(true);
  });

  it('an oral compound does NOT inherit a rectal route from its oral data', () => {
    // `oral`, `im` and `rectal` have identical types, so a fallback to `routes.oral`
    // would typecheck and would plot a confident curve for a suppository nobody has
    // data for.
    const oralOnly = compounds.find((c) => c.routes.oral && !c.routes.rectal);
    if (!oralOnly) throw new Error('expected at least one compound without rectal data');
    const rectal = routeOptions(oralOnly).find((o) => o.route === 'rectal');
    expect(rectal?.derivable).toBe(false);
    expect(rectal?.available).toBe(false);
  });
});

describe('ModelAssumptionsNote — the absorption bullet is a claim about the ROUTE', () => {
  // This panel printed one fixed line, "Oral input is a single exponential", under
  // every curve. Under a patch that named the wrong KIND of absorption (a patch is
  // zero-order); under the IV routes it asserted an absorption step that does not
  // exist. Nothing caught it because nothing asserted on it — so these do.
  const render = (route: 'rectal' | 'oral' | 'im' | 'transdermal' | 'iv_bolus') =>
    renderToStaticMarkup(
      <ModelAssumptionsNote model="two_compartment_first_order" route={route} />,
    );

  it('names the rectal mucosa, and admits what a single exponential cannot show', () => {
    const html = render('rectal');
    expect(html).toContain('First-order absorption');
    expect(html).toMatch(/rectal mucosa/);
    expect(html).not.toMatch(/Oral input/);
  });

  it('calls a patch zero-order, not first-order', () => {
    const html = render('transdermal');
    expect(html).toContain('Zero-order input');
    expect(html).not.toContain('First-order absorption');
    expect(html).not.toMatch(/Oral input/);
  });

  it('asserts no absorption step at all for an IV bolus', () => {
    const html = render('iv_bolus');
    expect(html).not.toContain('absorption');
    expect(html).not.toMatch(/Oral input/);
  });

  it('still says the oral thing under an oral curve', () => {
    expect(render('oral')).toMatch(/Oral input is a single/);
    expect(render('im')).toMatch(/muscle depot/);
  });
});

describe('PeakNote — a suppository is explained as neither a tablet nor an injection', () => {
  const render = (route: 'rectal' | 'oral' | 'im') =>
    renderToStaticMarkup(<PeakNote route={route} schedule={single(15)} />);

  it('names the rectal mucosa and the split venous drainage', () => {
    const html = render('rectal');
    expect(html).toContain('rectal dose');
    expect(html).toMatch(/rectal mucosa/);
    expect(html).toMatch(/portal/);
  });

  it('does not fall through to the oral sentence — the twice-shipped bug', () => {
    expect(render('rectal')).not.toContain('An oral dose rises');
    expect(render('oral')).toContain('An oral dose rises');
  });

  it('does not borrow the IM claim that F carries no first-pass loss', () => {
    // The specific false sentence this route could most easily inherit. Rectal
    // recovers PART of first pass; saying it carries none would be the IM copy
    // pasted onto a route that does not earn it.
    const html = render('rectal');
    expect(html).not.toMatch(/absorption completeness/);
    expect(html).not.toMatch(/carries no first-pass loss/);
    expect(render('im')).toMatch(/absorption completeness/);
  });

  it('states the bypass as partial, and ties its size to hepatic extraction', () => {
    // Written for ANY rectal compound, not for diazepam: route-keyed copy binds
    // every future compound on the route, so a number here would become a lie on
    // the next one.
    const html = render('rectal');
    expect(html).toMatch(/some, but not all/);
    expect(html).not.toMatch(/\b90(\.4)?%/);
  });
});
