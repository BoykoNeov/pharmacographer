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
 * So is the LINEARITY bullet, and for the same reason. It used to say that
 * saturable drugs "are excluded here" — true until the nonlinear engine landed
 * (handoff §12), and a falsehood the moment phenytoin and ethanol shipped. Under
 * a Michaelis–Menten curve the bullet does not soften, it INVERTS: superposition
 * is not assumed, it is refused, and the reason the curve looks the way it does
 * is precisely the assumption every other compound makes and this one cannot.
 *
 * The 70 kg subject line is load-bearing: it must always frame the reference
 * weight as an illustrative modelling assumption, never a patient weight (the
 * bright line, CLAUDE.md).
 */

import type { Compound } from '../../data/schema.ts';
import { REFERENCE_WEIGHT_KG } from '../curve.ts';

export function ModelAssumptionsNote({ model }: { model: Compound['model'] }) {
  const michaelisMenten = model === 'one_compartment_michaelis_menten';
  return (
    <section className="panel assumptions" aria-label="Model assumptions">
      <h2 className="assumptions__title">What this model assumes</h2>
      <ul className="assumptions__list">
        {michaelisMenten ? (
          <li>
            <strong>One compartment, saturable elimination.</strong> The body is
            treated as a single well-mixed volume, but the enzymes clearing the
            drug have a ceiling: elimination follows Vmax·C/(Km + C) rather than a
            fixed rate constant. A real drug with a distribution phase will still
            show a steeper early drop than this curve does.
          </li>
        ) : model === 'three_compartment_first_order' ? (
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
        {michaelisMenten ? (
          <li>
            <strong>NOT linear — no superposition, and no half-life.</strong>{' '}
            Clearance falls as concentration rises, so doses do <em>not</em> add
            up: this curve is integrated as a whole course rather than summed from
            single doses, and two doses together reach higher than the same two
            doses drawn separately. There is also no single half-life to quote —
            the apparent half-life rises with concentration, so the figure in the
            caption is this dose&apos;s, not the drug&apos;s. Change the dose and it
            moves; that is the compound, not a limitation of the model.
          </li>
        ) : (
          <li>
            <strong>Linear kinetics &amp; superposition.</strong> Clearance is
            assumed dose-independent, so doses add up. This breaks down for
            saturable drugs — see phenytoin or ethanol, which are modelled
            differently for exactly this reason.
          </li>
        )}
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
