// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';

/**
 * The variability axes (half-life + Vd + F), driven through the REAL App (handoff §12).
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

  /**
   * Pick a route by its option value. The route `<select>` shares the compound
   * picker's `.control__input` class, so it is found by looking for the one whose
   * options carry route values rather than by index.
   */
  const selectRoute = (routeValue: string) => {
    const selects = [...container!.querySelectorAll<HTMLSelectElement>('.control__input')];
    const select = selects.find((s) => [...s.options].some((o) => o.value === routeValue))!;
    act(() => {
      select.value = routeValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  /** Every slider label in the controls panel, lower-cased. */
  const sliderLabels = () =>
    [...container!.querySelectorAll('.control__label')].map((el) =>
      (el.textContent ?? '').toLowerCase(),
    );

  const hasVdSlider = () => sliderLabels().some((t) => t.includes('volume of distribution'));

  const hasFSlider = () => sliderLabels().some((t) => t.includes('bioavailability'));

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

  it('does NOT tell a flip-flop compound that the slider tilts its tail', () => {
    // Acamprosate absorbs (ka ≈ 0.081/h) more slowly than it eliminates (ke ≈
    // 0.198–0.277/h across the whole reported range), so its terminal slope is
    // the ABSORPTION rate and does not move with this slider at all — pinned
    // numerically in `curve.test.ts`. The generic axis note claims the opposite,
    // and the point of this assertion is the negative one: prose written for the
    // ordinary case must not be inherited by the case where it reverses. That is
    // the transdermal `PeakNote` defect, which no type or numeric test can see.
    mount();
    selectCompound('Acamprosate');
    const text = panelText();
    expect(text).toMatch(/absorbs more slowly than it eliminates/i);
    expect(text).not.toMatch(/changes how fast the curve falls/i);
  });

  it('DOES tell an ordinary compound that the slider tilts its tail', () => {
    // The other side of the branch: the generic sentence is correct for every
    // elimination-limited compound and must survive the flip-flop fix. Ibuprofen,
    // not caffeine: the assertion needs a compound that HAS a half-life slider
    // (caffeine reports a point value, so it gets the no-range note instead).
    mount();
    selectCompound('Ibuprofen');
    const text = panelText();
    expect(text).toMatch(/changes how fast the curve falls/i);
    expect(text).not.toMatch(/absorbs more slowly than it eliminates/i);
  });

  it('does NOT tell a flip-flop compound its curve falls as it is eliminated', () => {
    // The CAPTION, not the slider — a separate surface making the identical
    // misattribution, and the one the first pass at this fix walked past because
    // the sentence's OTHER clause ("the peak is where those balance") does
    // survive flip-flop. Half a sentence holding is not the sentence holding.
    // Reads the whole document, since the caption lives under the chart rather
    // than in the controls panel.
    mount();
    selectCompound('Acamprosate');
    const text = container!.textContent ?? '';
    expect(text).toMatch(/what the curve falls at after the peak is the absorption rate/i);
    expect(text).not.toMatch(/rises as it is absorbed and falls as it is eliminated/i);
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
    const slider = () => container!.querySelectorAll<HTMLInputElement>('.slider')[1]!; // [0] = t½, [1] = Vd
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

  it('offers an F slider on the ORAL route of a compound reporting an F range', () => {
    mount();
    selectCompound('Morphine'); // oral F 22–36%
    selectRoute('oral');
    expect(hasFSlider()).toBe(true);
  });

  it('offers NO F slider on an IV route — bioavailability there is 1 by definition', () => {
    // Not a "the source reports no range" case: there is no parameter to vary.
    mount();
    selectCompound('Morphine');
    selectRoute('iv_bolus');
    expect(hasFSlider()).toBe(false);
  });

  it('does not describe F with the "held constant" copy the other axes use', () => {
    // The transdermal PeakNote defect, pre-empted: F has no ceteris-paribus
    // choice to report, so cloning that sentence would put a true-sounding but
    // meaningless claim on screen. What must appear instead is the
    // non-identifiability — that the curve's height cannot tell F from Vd.
    mount();
    selectCompound('Morphine');
    selectRoute('oral');
    const text = panelText();
    expect(text).toMatch(/V\/F/); // the apparent-volume ratio, named
    expect(text).toMatch(/cannot tell whether/i); // …as a statement about ATTRIBUTION
    expect(text).not.toMatch(/bioavailability is held/i);
  });

  it('does not tell the reader whether to combine the F and Vd spreads', () => {
    // An earlier draft said "one uncertainty seen twice, not two to add
    // together". Half true and half false: you cannot attribute a height change
    // to one parameter, but F and Vd are separately-measured quantities that
    // both vary between people, and their extremes compound — morphine's
    // high-F/small-Vd corner is 1.7× the nominal height, outside either band
    // alone, and describes a perfectly coherent person. Nothing in the data says
    // how the two covary, so "add them" and "never add them" are equally
    // unsupported and the panel asserts neither.
    mount();
    selectCompound('Morphine');
    selectRoute('oral');
    const text = panelText();
    expect(text).not.toMatch(/add together/i);
    expect(text).not.toMatch(/one uncertainty/i);
  });

  it('writes F as a percent, not as the canonical fraction', () => {
    // "F = 0.292" invites the reader to ask what it is a fraction of; every label
    // and paper states a percent.
    mount();
    selectCompound('Morphine');
    selectRoute('oral');
    const label = sliderLabels().find((t) => t.includes('bioavailability'))!;
    expect(label).toMatch(/%/);
    expect(label).not.toMatch(/=\s*0\./);
  });

  it('the F band checkbox reads as the symbol F', () => {
    mount();
    selectCompound('Morphine');
    selectRoute('oral');
    const labels = [...container!.querySelectorAll('.band-toggle')].map((el) => el.textContent);
    expect(labels).toContain('Show F band');
  });
});
