// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ConcentrationChart } from '../../src/ui/components/ConcentrationChart.tsx';
import type { CurvePoint, MetaboliteCurve } from '../../src/ui/curve.ts';

/**
 * Per-metabolite line show/hide chips (this feature). Every metabolite line is
 * individually toggleable; the control is chart-local display state, so these SSR
 * tests pin the INITIAL (default) contract — a chip per declared metabolite, all
 * visible (aria-pressed="true") on first render — which is the load-bearing part
 * (default-on, one chip each). The hide-on-click interaction itself is a client
 * state change verified by running the app (jsdom SSR can't fire the click), the
 * same posture as the metabolite `<Line>` rows (Playwright-verified).
 */
function point(t: number, c: number): CurvePoint {
  return { t, c };
}

function fakeMetabolite(id: string, name: string, active: boolean): MetaboliteCurve {
  const points = [point(0, 0), point(1, 2), point(2, 1.2), point(4, 0.4)];
  return { id, name, active, points, peak: point(1, 2), derived: [], warnings: [] };
}

const parentPoints: CurvePoint[] = [point(0, 5), point(1, 3), point(2, 1.8), point(4, 0.6)];

function render(metabolites: MetaboliteCurve[]) {
  return renderToStaticMarkup(
    <ConcentrationChart
      points={parentPoints}
      metabolites={metabolites}
      parentName="Parent"
      horizonH={4}
      peak={point(0, 5)}
      concUnit="mg/L"
      onConcUnitChange={() => {}}
    />,
  );
}

describe('metabolite line visibility toggles', () => {
  it('renders one chip per metabolite, all visible by default', () => {
    const html = render([
      fakeMetabolite('m3g', 'Morphine-3-glucuronide (M3G)', false),
      fakeMetabolite('m6g', 'Morphine-6-glucuronide (M6G)', true),
    ]);
    // The toggle group and a chip per metabolite are present.
    expect(html).toContain('aria-label="Metabolite lines"');
    expect(html).toContain('Morphine-3-glucuronide (M3G)');
    expect(html).toContain('Morphine-6-glucuronide (M6G)');
    // Default is all-visible: both chips carry the --active class (pressed), and no
    // chip renders in the inactive (hidden) state (class="metab-toggle" without --active).
    expect(html.match(/metab-toggle--active/g)).toHaveLength(2);
    expect(html).not.toContain('class="metab-toggle"');
    // The active/inactive status rides in the chip tooltip, shared with the legend wording.
    expect(html).toContain('— active metabolite');
    expect(html).toContain('— metabolite');
  });

  it('shows no metabolite toggle group when the compound has none', () => {
    const html = render([]);
    expect(html).not.toContain('aria-label="Metabolite lines"');
    expect(html).not.toContain('metab-toggle');
  });
});

/**
 * The interaction itself: clicking a chip toggles ONLY that metabolite's line.
 * Recharts renders no SVG in a zero-size jsdom container, so the observable is the
 * chip state (which gates the `visibleSeries.map(<Line>)` render) plus that the
 * OTHER chip is untouched — the "one by one" contract.
 */
describe('toggling a metabolite chip hides only that line', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it('flips the clicked chip to hidden and leaves the sibling visible', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ConcentrationChart
          points={parentPoints}
          metabolites={[
            fakeMetabolite('m3g', 'Morphine-3-glucuronide (M3G)', false),
            fakeMetabolite('m6g', 'Morphine-6-glucuronide (M6G)', true),
          ]}
          parentName="Parent"
          horizonH={4}
          peak={point(0, 5)}
          concUnit="mg/L"
          onConcUnitChange={() => {}}
        />,
      );
    });

    const chip = (id: string) =>
      [...container!.querySelectorAll<HTMLButtonElement>('.metab-toggle')].find((b) =>
        b.title.startsWith(id),
      )!;

    // Both start visible (pressed + active class).
    expect(chip('Morphine-3').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Morphine-6').getAttribute('aria-pressed')).toBe('true');

    // Hide M3G.
    act(() => {
      chip('Morphine-3').click();
    });
    expect(chip('Morphine-3').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Morphine-3').className).not.toContain('metab-toggle--active');
    // M6G is untouched — one metabolite toggled at a time.
    expect(chip('Morphine-6').getAttribute('aria-pressed')).toBe('true');

    // Clicking again restores it.
    act(() => {
      chip('Morphine-3').click();
    });
    expect(chip('Morphine-3').getAttribute('aria-pressed')).toBe('true');

    act(() => root.unmount());
  });
});
