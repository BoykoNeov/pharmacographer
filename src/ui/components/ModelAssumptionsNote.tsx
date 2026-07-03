/**
 * ModelAssumptionsNote — the standing assumptions behind every curve (handoff
 * §1, §13 Phase 5). Deliberately distinct from the in-chart `ModelCaption`:
 * the caption says "what this specific curve is" (dose, route, ke, ka); this
 * note says "what you are trusting, and where it stops being true." It does not
 * change with the dose, so it reads as a fixed disclosure, not a live readout.
 *
 * The compartment bullet is model-aware: a one-compartment curve trusts a
 * single well-mixed volume, while a two-compartment curve explicitly models a
 * distribution phase — printing "One compartment" under a two-compartment curve
 * would contradict what is on screen (the epistemic-honesty bright line).
 *
 * The 70 kg subject line is load-bearing: it must always frame the reference
 * weight as an illustrative modelling assumption, never a patient weight (the
 * bright line, CLAUDE.md).
 */

import type { Compound } from '../../data/schema.ts';
import { REFERENCE_WEIGHT_KG } from '../curve.ts';

export function ModelAssumptionsNote({ model }: { model: Compound['model'] }) {
  return (
    <section className="panel assumptions" aria-label="Model assumptions">
      <h2 className="assumptions__title">What this model assumes</h2>
      <ul className="assumptions__list">
        {model === 'three_compartment_first_order' ? (
          <li>
            <strong>Three compartments.</strong> The body is split into a central
            volume (blood plus fast-perfusing tissue, where concentration is
            measured) and two peripheral volumes — a rapidly-equilibrating one and
            a slow, deep one. The curve shows a steep early (α) distribution drop,
            a middle (β) phase, then a slow terminal (γ) decline as drug returns
            from the deep compartment.
          </li>
        ) : model === 'two_compartment_first_order' ? (
          <li>
            <strong>Two compartments.</strong> The body is split into a central
            volume (blood plus fast-perfusing tissue, where concentration is
            measured) and a peripheral volume it exchanges with. The curve shows
            a distribution phase — a steep early (α) drop as drug spreads into
            the periphery — before the slower terminal (β) decline.
          </li>
        ) : (
          <li>
            <strong>One compartment.</strong> The body is treated as a single
            well-mixed volume. A real drug with a distribution phase will show a
            steeper early drop than this curve does.
          </li>
        )}
        <li>
          <strong>Linear kinetics &amp; superposition.</strong> Clearance is
          assumed dose-independent, so doses add up. This breaks down for
          saturable (nonlinear) drugs, which are excluded here.
        </li>
        <li>
          <strong>First-order absorption.</strong> Oral input is a single
          exponential; food, formulation, and gut effects are not modelled.
        </li>
        <li>
          <strong>{REFERENCE_WEIGHT_KG} kg illustrative reference subject.</strong> Per-kilogram
          parameters are scaled to a fixed {REFERENCE_WEIGHT_KG} kg figure. This is a teaching
          assumption, <em>not</em> a patient weight — nothing here is individualised.
        </li>
      </ul>
    </section>
  );
}
