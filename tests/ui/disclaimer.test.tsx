import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import { DisclaimerBanner } from '../../src/ui/components/DisclaimerBanner.tsx';

/**
 * The persistent disclaimer is a product guardrail (handoff §11), not optional
 * chrome — so it gets a test, not just a compile. If a future refactor drops the
 * banner from App, this fails.
 */
describe('disclaimer guardrail (handoff §11)', () => {
  it('App always renders the "educational use only — not medical advice" notice', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Educational use only');
    expect(html).toContain('not medical advice');
  });

  it('DisclaimerBanner is a note region with no dismiss control', () => {
    const html = renderToStaticMarkup(<DisclaimerBanner />);
    expect(html).toContain('role="note"');
    // Non-dismissible by design: there must be no close/dismiss button.
    expect(html.toLowerCase()).not.toContain('<button');
  });
});
