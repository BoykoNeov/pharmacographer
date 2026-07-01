import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';

/**
 * The honesty UI (Phase 5) is the product, not chrome — so it gets a render
 * test, not just a compile. App defaults to the first seed compound on an IV
 * route, so the provenance panel and the standing assumptions must appear with
 * real sourced content and the measured/derived badges.
 */
describe('honesty UI (handoff §5, Phase 5)', () => {
  const html = renderToStaticMarkup(<App />);

  it('renders the provenance panel with a source citation', () => {
    expect(html).toContain('Where these numbers come from');
    expect(html).toContain('Sources');
    expect(html).toContain('FDA label'); // seed compounds are FDA-sourced
  });

  it('shows measured-vs-derived badges', () => {
    expect(html).toContain('Measured'); // half-life / Vd are read from the label
    // ke is computed from t½, grouped in as a derivation, not a measured row.
    expect(html).toContain('ke = ln2');
  });

  it('renders the standing model assumptions, framing 70 kg as illustrative', () => {
    expect(html).toContain('What this model assumes');
    expect(html).toContain('illustrative reference subject');
    expect(html).toContain('not</em> a patient weight');
  });
});
