import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds, parseCompound } from '../../src/data/loader.ts';
import { App } from '../../src/ui/App.tsx';
import { CompoundAbout, CompoundMetabolism } from '../../src/ui/components/CompoundInfo.tsx';
import { baseRawCompound } from '../data/_fixtures.ts';

/**
 * The compound "About" blurb and the metabolism narrative (this feature). The
 * load-bearing requirement is that switching compound must NOT move the chart:
 * the About box sits ABOVE the chart with a fixed height (styles.css `.about`),
 * and the unbounded metabolism prose sits BELOW it. These tests pin the
 * structural contract that makes that hold — the box is always present above the
 * chart, and the growable prose is a separate section — plus the render content.
 */
describe('compound About box (fixed slot above the chart)', () => {
  const compounds = loadAllCompounds();

  it('every compound carries a non-empty user-facing description (the curation rule)', () => {
    for (const c of compounds) {
      expect(c.description, `${c.id} must have a description`).toBeTruthy();
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('renders the About box with the description text', () => {
    const caffeine = compounds.find((c) => c.id === 'caffeine')!;
    const html = renderToStaticMarkup(<CompoundAbout compound={caffeine} />);
    expect(html).toContain('class="about"');
    expect(html).toContain('most widely consumed stimulant');
  });

  it('App renders the About box above the chart canvas (fixed slot precedes the chart)', () => {
    const html = renderToStaticMarkup(<App />);
    const aboutIdx = html.indexOf('class="about"');
    const chartIdx = html.indexOf('chart__canvas');
    expect(aboutIdx).toBeGreaterThanOrEqual(0);
    expect(chartIdx).toBeGreaterThanOrEqual(0);
    // The About box must come BEFORE the chart in document order — that ordering
    // plus its fixed CSS height is what anchors the chart's top edge.
    expect(aboutIdx).toBeLessThan(chartIdx);
  });
});

describe('compound metabolism section (growable, below the chart)', () => {
  const compounds = loadAllCompounds();

  it('renders the metabolism narrative and per-metabolite blurbs when present', () => {
    const caffeine = compounds.find((c) => c.id === 'caffeine')!;
    const html = renderToStaticMarkup(<CompoundMetabolism compound={caffeine} />);
    expect(html).toContain('Metabolism');
    expect(html).toContain('CYP1A2'); // the compound-level metabolism prose
    expect(html).toContain('Paraxanthine'); // a metabolite blurb
    expect(html).toContain('active metabolite'); // the active tag
  });

  it('renders nothing for a compound with no metabolism note and no metabolite blurbs', () => {
    // The synthetic fixture has neither a `metabolism` field nor metabolites.
    const bare = parseCompound(baseRawCompound());
    const html = renderToStaticMarkup(<CompoundMetabolism compound={bare} />);
    expect(html).toBe('');
  });
});
