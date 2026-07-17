// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';

/**
 * The phenotype picker, driven through the REAL App (§12).
 *
 * This is a wiring test, and it exists because the data-layer oracles in
 * tests/data/phenotype.test.ts cannot see the defect that matters most here: the
 * slider carrying a half-life across a population switch. `applyPhenotype` is
 * provably atomic on its own, but App holds `halfLifeH` separately — so the mixed
 * state the data layer forbids could be rebuilt in the UI, and every data test
 * would stay green while it happened. That is exactly the class of bug this
 * project has been bitten by before (green suite, wrong screen), so it is checked
 * against the mounted component tree rather than reasoned about.
 */
describe('phenotype picker, wired through App', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  const mount = () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<App />));
    return root;
  };

  const selectCompound = (name: string) => {
    const select = container!.querySelector<HTMLSelectElement>('.control__input')!;
    const option = [...select.options].find((o) => o.textContent?.includes(name))!;
    act(() => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const radios = () => [
    ...container!.querySelectorAll<HTMLInputElement>('.phenotype__option input'),
  ];
  const slider = () => container!.querySelector<HTMLInputElement>('.slider');
  const sliderLabelText = () =>
    [...container!.querySelectorAll('.control__label')].map((n) => n.textContent ?? '').join(' | ');

  it('shows no population control for a compound with one unnamed population', () => {
    mount();
    // The first compound alphabetically is not procainamide; almost every
    // compound models a single population and must get no control at all.
    expect(container!.querySelector('.control--phenotype')).toBeNull();
  });

  it('offers both acetylator archetypes for procainamide, defaulting to fast', () => {
    mount();
    selectCompound('Procainamide');

    const labels = radios().map((r) => r.closest('label')!.textContent);
    expect(labels).toEqual(['Fast acetylator', 'Slow acetylator']);
    expect(radios()[0]!.checked).toBe(true);
  });

  it('re-anchors the slider band to the selected population', () => {
    mount();
    selectCompound('Procainamide');

    // Fast band: 1.7–3.1 h, nominal 2.4.
    expect(slider()!.min).toBe('1.7');
    expect(slider()!.max).toBe('3.1');
    expect(Number(slider()!.value)).toBeCloseTo(2.4, 6);

    act(() => radios()[1]!.click());

    // Slow band: 2.6–4.6 h, nominal 3.6 — a different band, not a wider one.
    expect(slider()!.min).toBe('2.6');
    expect(slider()!.max).toBe('4.6');
    expect(Number(slider()!.value)).toBeCloseTo(3.6, 6);
    expect(sliderLabelText()).toContain('3.6');
  });

  it('drops a carried-over half-life when the population changes', () => {
    mount();
    selectCompound('Procainamide');

    // Slide to 1.8 h — legal for a fast acetylator, and nowhere in the slow band.
    act(() => {
      const s = slider()!;
      s.value = '1.8';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(Number(slider()!.value)).toBeCloseTo(1.8, 6);

    act(() => radios()[1]!.click());

    // It must NOT clamp to 2.6 (silently keeping a foreign value) and must not
    // stay at 1.8 (outside the band entirely). It resets to the slow nominal.
    expect(Number(slider()!.value)).toBeCloseTo(3.6, 6);
  });

  it('resets to the default population when the compound changes', () => {
    mount();
    selectCompound('Procainamide');
    act(() => radios()[1]!.click());
    expect(radios()[1]!.checked).toBe(true);

    selectCompound('Warfarin');
    selectCompound('Procainamide');
    expect(radios()[0]!.checked).toBe(true);
  });

  it('frames the control as an illustrative population, never as the user own genotype', () => {
    // The bright line, asserted. If someone reworks this copy into a
    // personalisation control, this test is the thing that should stop them.
    mount();
    selectCompound('Procainamide');
    const text = container!.querySelector('.control--phenotype')!.textContent!.toLowerCase();

    expect(text).toContain('illustrative population');
    expect(text).toContain('not a genotype test');
    // No second-person solicitation of the user's own biology.
    expect(text).not.toMatch(/your genotype is|select your|enter your|tell us your/);
  });
});
