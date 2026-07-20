// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';

/**
 * The variability axes (half-life + Vd), driven through the REAL App (handoff §12).
 *
 * The math is pinned in `curve.test.ts`; what only a mounted tree can catch is the
 * wiring and the COPY. This project's standing trap is a green suite over a wrong
 * screen — the transdermal route shipped with `PeakNote` explaining a patch with
 * the oral story under 522 passing tests. The equivalents here:
 *
 *  - the Vd slider appearing for a compound that has no single Vd to slide (a
 *    two-compartment or saturable one), which no data test can see;
 *  - the per-axis "what is held constant" line going stale or missing, which turns
 *    a curve the reader can interpret into one they cannot;
 *  - a slider carrying its value across a compound switch, where absolute litres
 *    from another molecule are meaningless (the phenotype-picker defect, again).
 */
describe('variability axes, wired through App', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  const mount = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    container = host;
    act(() => createRoot(host).render(<App />));
  };

  const selectCompound = (name: string) => {
    const select = container!.querySelector<HTMLSelectElement>('.control__input')!;
    const option = [...select.options].find((o) => o.textContent?.includes(name))!;
    act(() => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  /** Every slider label in the controls panel, lower-cased. */
  const sliderLabels = () =>
    [...container!.querySelectorAll('.control__label')].map((el) =>
      (el.textContent ?? '').toLowerCase(),
    );

  const hasVdSlider = () => sliderLabels().some((t) => t.includes('volume of distribution'));

  const panelText = () => container!.querySelector('.controls')!.textContent ?? '';

  it('offers a Vd slider for a one-compartment compound that reports a range', () => {
    mount();
    selectCompound('Acamprosate'); // 1-comp, Vd 70–112 L reported
    expect(hasVdSlider()).toBe(true);
  });

  it('states what is HELD CONSTANT on each axis', () => {
    // Without this the Vd curve is ambiguous rather than merely unexplained: the
    // same volume change means something different if clearance is what is fixed.
    mount();
    selectCompound('Acamprosate');
    const text = panelText();
    expect(text).toMatch(/volume of distribution is held/i);
    expect(text).toMatch(/half-life is held/i);
    expect(text).toMatch(/CL = ke · Vd/);
  });

  it('offers NO Vd slider for a two-compartment compound', () => {
    // Digoxin has a central and a peripheral volume; "the" Vd does not exist for
    // it, exactly as "the" half-life does not.
    mount();
    selectCompound('Digoxin');
    expect(hasVdSlider()).toBe(false);
    expect(panelText()).toMatch(/more than one half-life at once/i);
  });

  it('offers NO Vd slider for a saturable (Michaelis–Menten) compound', () => {
    mount();
    selectCompound('Phenytoin');
    expect(hasVdSlider()).toBe(false);
    expect(panelText()).toMatch(/no fixed half-life to vary/i);
  });

  it('the band checkbox reads as a symbol, not a mangled sentence', () => {
    // `.control__label` is styled all-caps, so the checkbox needs its own short
    // form — deriving it from the label produced "Show volume of distribution vd
    // band" on screen while every test stayed green.
    mount();
    selectCompound('Acamprosate');
    const labels = [...container!.querySelectorAll('.band-toggle')].map((el) => el.textContent);
    expect(labels).toContain('Show t½ band');
    expect(labels).toContain('Show Vd band');
  });

  it('defaults to the half-life band shown and the Vd band hidden', () => {
    // The identity-at-default rule: the opening view is the one the app has always
    // drawn, so a regression shows up as a changed default rather than hiding
    // behind the new axis.
    mount();
    selectCompound('Acamprosate');
    const boxes = [...container!.querySelectorAll<HTMLInputElement>('.band-toggle input')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });

  it('resets the Vd slider when the compound changes', () => {
    // Absolute litres do not travel between molecules: a value carried over would
    // usually sit outside the next compound's reported range entirely.
    mount();
    selectCompound('Acamprosate');
    const slider = () =>
      container!.querySelectorAll<HTMLInputElement>('.slider')[1]!; // [0] = t½, [1] = Vd
    const nominal = slider().value;
    act(() => {
      slider().value = slider().max;
      slider().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(slider().value).not.toBe(nominal);

    selectCompound('Digoxin'); // no Vd slider at all
    selectCompound('Acamprosate');
    expect(slider().value).toBe(nominal);
  });
});
