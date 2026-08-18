import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds } from '../../src/data/loader.ts';
import { DATA_ROUTES, type DataRoute } from '../../src/data/schema.ts';
import { PeakNote } from '../../src/ui/App.tsx';
import { buildCurve, routeOptions, type DoseSchedule } from '../../src/ui/curve.ts';
import { PEAK_SEMANTICS, peakSemanticsFor, type PeakSemantics } from '../../src/ui/peak.ts';

/**
 * "Does this curve have a peak, or does it just end?" — one question, which five
 * surfaces used to answer separately with five copies of `route === 'transdermal'`.
 * All five were correct; the defect was that correctness had to be re-achieved in
 * five places. That exact shape has shipped wrong THREE times in this project
 * (transdermal `PeakNote`, rectal `ModelAssumptionsNote`, subcutaneous `PeakNote`),
 * every time invisible to the whole suite because prose is not typed.
 *
 * `src/ui/peak.ts` now answers it once. This file pins the three things that make
 * the class of bug actually impossible rather than merely tidied:
 *
 *  1. **Exhaustiveness** — every `DataRoute` has an entry, so a new route cannot
 *     inherit one. (The compiler enforces this; the runtime check catches a route
 *     added to `DATA_ROUTES` without the `Record` being widened in the same commit.)
 *  2. **Internal consistency** — no `peak` route may utter "End of wear", and no
 *     `end_of_input` route may utter "Cmax" or "Tmax", ANYWHERE in its strings.
 *     Because every surface now renders these strings and adds none of its own,
 *     checking the strings checks all five surfaces at once.
 *  3. **Agreement with the actual curve** — the strongest of the three, and the one
 *     that turns the classification from an assertion into a checked fact. Every
 *     compound is built on every derivable route, and `end_of_input` must hold of
 *     exactly those curves still climbing when the plot stops. A route whose copy
 *     says "peaks" over a curve that never turns over now FAILS, instead of being
 *     found by someone launching the app.
 */

const compounds = loadAllCompounds();

/** The regimes {@link PeakSemantics.meaning} may be asked for. */
const REGIMES = ['elimination_limited', 'absorption_limited', 'mixed'] as const;

/** Every string a route's semantics can put on screen, flattened for inspection. */
function allStrings(semantics: PeakSemantics): string[] {
  return [
    semantics.heading,
    semantics.markerPrefix,
    semantics.opener,
    semantics.measuredNoun,
    semantics.captionClause('1.23 mg/L', '4.5'),
    ...REGIMES.map((regime) => semantics.meaning(regime)),
  ];
}

describe('PEAK_SEMANTICS — the question is answered once, for every route', () => {
  it('has an entry for every DataRoute', () => {
    for (const route of DATA_ROUTES) {
      expect(PEAK_SEMANTICS[route], `no peak semantics for route ${route}`).toBeDefined();
      expect(peakSemanticsFor(route)).toBe(PEAK_SEMANTICS[route]);
    }
    // Nothing extra, either: a stale entry for a removed route is dead copy that
    // would read as supported.
    expect(Object.keys(PEAK_SEMANTICS).sort()).toEqual([...DATA_ROUTES].sort());
  });

  it('gives every route a non-empty sentence in every regime', () => {
    for (const route of DATA_ROUTES) {
      for (const text of allStrings(peakSemanticsFor(route))) {
        expect(text.length, `empty peak string on ${route}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('a route may not contradict its own kind', () => {
  it('never says "End of wear" about a curve that peaks', () => {
    for (const route of DATA_ROUTES) {
      const semantics = peakSemanticsFor(route);
      if (semantics.kind !== 'peak') continue;
      for (const text of allStrings(semantics)) {
        expect(text, `peaking route ${route} borrowed the patch wording`).not.toMatch(
          /end of wear/i,
        );
      }
    }
  });

  /**
   * The transdermal defect in its general form. A curve that never turns over has
   * no Cmax and no Tmax — those words name quantities that do not exist for it, so
   * no surface may print them, whatever the route is called.
   */
  it('never names a Cmax or a Tmax on a curve that only ends', () => {
    for (const route of DATA_ROUTES) {
      const semantics = peakSemanticsFor(route);
      if (semantics.kind !== 'end_of_input') continue;
      for (const text of allStrings(semantics)) {
        expect(text, `${route} claims a peak it does not have`).not.toMatch(/Cmax|Tmax/);
      }
    }
  });

  it('says something about a peak on every route that has one', () => {
    for (const route of DATA_ROUTES) {
      const semantics = peakSemanticsFor(route);
      if (semantics.kind !== 'peak') continue;
      expect(semantics.heading).toBe('Cmax / Tmax');
      // Each peaking route explains its OWN peak — the strings are shared, the
      // explanation is not. A duplicated sentence would mean a route inherited one.
      expect(semantics.meaning('elimination_limited')).toMatch(/peak|Tmax/);
    }
  });

  it('gives no two routes the same explanation', () => {
    const seen = new Map<string, DataRoute>();
    for (const route of DATA_ROUTES) {
      const sentence = peakSemanticsFor(route).meaning('elimination_limited');
      const prior = seen.get(sentence);
      expect(prior, `${route} and ${prior} share one explanation`).toBeUndefined();
      seen.set(sentence, route);
    }
  });
});

/**
 * THE GUARD THAT MAKES THIS MORE THAN A REFACTOR.
 *
 * `kind` is a claim about the SHAPE of the plotted curve, so it is checked against
 * the plotted curve rather than against a comment. A curve "just ends" when its
 * marked point sits on the last sample of the grid AND the curve is still climbing
 * there; anything else turned over inside the window and has a real peak.
 *
 * Only the transdermal path can produce the former today, and structurally so:
 * `curveHorizon` gives an infusion `infusionDuration + 5·t½` of tail, so its peak
 * (at infusion end) is always well inside the window, while `buildCurve` truncates
 * a patch's horizon at the wear duration exactly. That is a fact about the code,
 * not a coincidence of the current data — but it is the sort of fact that changes
 * quietly, which is why it is asserted over the whole set rather than argued.
 */
describe('kind agrees with the curve it describes', () => {
  const singleDose = (amount: number): DoseSchedule => ({
    amount,
    count: 1,
    interval: 0,
    adHoc: [],
  });

  const cases: { id: string; route: DataRoute; endsWhileRising: boolean }[] = [];
  for (const compound of compounds) {
    for (const option of routeOptions(compound)) {
      if (!option.derivable) continue;
      const curve = buildCurve({
        compound,
        route: option.route,
        schedule: singleDose(compound.illustrativeDoseMg ?? 500),
        infusionDuration: 1,
      });
      const points = curve.points;
      const last = points[points.length - 1]!;
      const previous = points[points.length - 2]!;
      const atRightEdge = curve.peak.t >= curve.horizonH * (1 - 1e-9);
      cases.push({
        id: compound.id,
        route: option.route,
        endsWhileRising: atRightEdge && last.c > previous.c,
      });
    }
  }

  it('covers the whole shipped set (a silent zero here would prove nothing)', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it('marks end_of_input exactly where the curve is still climbing at the plot edge', () => {
    for (const { id, route, endsWhileRising } of cases) {
      const kind = peakSemanticsFor(route).kind;
      expect(
        kind === 'end_of_input',
        `${id} on ${route}: curve ${endsWhileRising ? 'never turns over' : 'peaks'} but is described as "${kind}"`,
      ).toBe(endsWhileRising);
    }
  });
});

/**
 * The surfaces render what they are handed and decide nothing. Checked on the note
 * because it is the only one that is plain SSR-able text; the chart's two surfaces
 * (toolbar button, marker label) interpolate `heading` and `markerPrefix` with no
 * branch left in them, and the caption calls `captionClause`.
 */
describe('PeakNote renders its route’s semantics rather than restating them', () => {
  const schedule: DoseSchedule = { amount: 10, count: 1, interval: 0, adHoc: [] };

  for (const route of DATA_ROUTES) {
    const semantics = peakSemanticsFor(route);

    it(`carries the resolved heading, opener, explanation and noun for ${route}`, () => {
      const html = renderToStaticMarkup(<PeakNote route={route} schedule={schedule} />);
      expect(html).toContain(semantics.heading);
      expect(html).toContain(semantics.meaning('elimination_limited'));
      expect(html).toContain(`not a measured ${semantics.measuredNoun} from any study`);
    });

    it(`keeps ${route} clear of the other kind’s vocabulary`, () => {
      const html = renderToStaticMarkup(<PeakNote route={route} schedule={schedule} />);
      if (semantics.kind === 'end_of_input') {
        expect(html).not.toMatch(/Cmax|Tmax/);
      } else {
        expect(html).not.toMatch(/end of wear/i);
      }
    });
  }

  /**
   * The regime branch survives the move into `peak.ts` — under flip-flop the oral
   * sentence must stop naming elimination as the cause of the falling limb (the
   * rate-limiting-step screen, `docs/DATA_GUIDE.md`).
   */
  it('still switches the oral explanation under flip-flop kinetics', () => {
    const ordinary = renderToStaticMarkup(
      <PeakNote route="oral" schedule={schedule} halfLifeRegime="elimination_limited" />,
    );
    const flipFlop = renderToStaticMarkup(
      <PeakNote route="oral" schedule={schedule} halfLifeRegime="absorption_limited" />,
    );
    expect(ordinary).toMatch(/falls as it is eliminated/);
    expect(flipFlop).not.toMatch(/falls as it is eliminated/);
    expect(flipFlop).toMatch(/ABSORPTION rate/);
  });
});
