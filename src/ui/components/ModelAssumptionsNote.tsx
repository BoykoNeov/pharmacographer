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

import type { Compound, DataRoute } from '../../data/schema.ts';
import { engineRouteOf } from '../../data/derive.ts';
import { REFERENCE_WEIGHT_KG } from '../curve.ts';

/**
 * The absorption assumption, which is a claim about the INPUT and therefore about
 * the route — not about the compound. It used to be one fixed line reading "Oral
 * input is a single exponential", printed under every curve regardless, and the
 * rectal route's audit is what surfaced how wrong that had quietly become:
 *
 *  - under a TRANSDERMAL patch it was doubly false — the input is zero-order, not
 *    first-order at all, so the panel named the wrong KIND of absorption while the
 *    heading promised "what this model assumes";
 *  - under an IV bolus or infusion there is no absorption step to assume anything
 *    about, so the bullet was pure noise;
 *  - under IM and rectal the shape claim was right but "oral" was the wrong noun,
 *    and the gut caveat named organs those routes do not use.
 *
 * Same lesson as `PeakNote`, one panel over: prose keyed on nothing at all is prose
 * keyed on whatever route happened to be in view when it was written.
 *
 * The first-order copy below is a RECORD, not the ternary chain it was until `sc`
 * shipped, and the reason is that the chain had already re-armed the exact trap this
 * comment describes. Its final `else` was the rectal sentence, so adding a fourth
 * first-order route would have explained a SUBCUTANEOUS INJECTION as "input from the
 * rectal mucosa … insertion depth decides how much of the dose drains portally" — a
 * confident paragraph about an anatomy the route does not involve, under a curve that
 * is otherwise correct, with every test green. That is the `PeakNote` patch bug
 * verbatim, one route later. An exhaustive `Record<DataRoute, …>` cannot fall
 * through: a new route fails to compile until someone writes its sentence, which is
 * the same fix `BIOAVAILABILITY_LABELS` and `DATA_ROUTES` already carry.
 */
const FIRST_ORDER_ABSORPTION_COPY: Record<DataRoute, string> = {
  oral: 'Oral input is a single exponential; food, formulation, and gut effects are not modelled.',
  im: 'Input from the muscle depot is a single exponential; injection site, volume, and formulation are not modelled.',
  sc: 'Input from the subcutaneous depot is a single exponential; injection site, depth, and formulation are not modelled — and subcutaneous fat is less well perfused than muscle, so this is the route where a single fixed absorption rate is the biggest simplification.',
  rectal:
    'Input from the rectal mucosa is a single exponential; insertion depth, formulation, and retention are not modelled — and it is insertion depth that decides how much of the dose drains portally, so the split behind this route’s F is exactly what a single exponential cannot show.',
  // Unreachable: the caller returns earlier for every route whose engine input is not
  // first-order. Written out anyway because the Record's exhaustiveness is the point,
  // and a plausible-looking absorption sentence sitting in an IV slot is a false string
  // waiting for the day a caller moves.
  iv_bolus: 'An IV bolus has no absorption step.',
  iv_infusion: 'An infusion has no absorption step.',
  transdermal: 'A patch is a zero-order input, not a first-order one.',
};

function absorptionAssumption(route: DataRoute) {
  const engineRoute = engineRouteOf(route);
  if (engineRoute === 'iv_bolus') return null;
  if (engineRoute === 'iv_infusion') {
    return (
      <li>
        <strong>Zero-order input.</strong>{' '}
        {route === 'transdermal'
          ? 'A patch is modelled as delivering drug at a constant rate for the whole wear period — no lag while the skin depot loads, and no variation with site, temperature, or adhesion.'
          : 'The infusion is modelled as a constant rate over its stated duration, starting and stopping instantly.'}
      </li>
    );
  }
  return (
    <li>
      <strong>First-order absorption.</strong> {FIRST_ORDER_ABSORPTION_COPY[route]}
    </li>
  );
}

export function ModelAssumptionsNote({
  model,
  route,
}: {
  model: Compound['model'];
  route: DataRoute;
}) {
  const michaelisMenten = model === 'one_compartment_michaelis_menten';
  return (
    <section className="panel assumptions" aria-label="Model assumptions">
      <h2 className="assumptions__title">What this model assumes</h2>
      <ul className="assumptions__list">
        {michaelisMenten ? (
          <li>
            <strong>One compartment, saturable elimination.</strong> The body is treated as a single
            well-mixed volume, but the enzymes clearing the drug have a ceiling: elimination follows
            Vmax·C/(Km + C) rather than a fixed rate constant. A real drug with a distribution phase
            will still show a steeper early drop than this curve does.
          </li>
        ) : model === 'three_compartment_first_order' ? (
          <li>
            <strong>Three compartments.</strong> The body is split into a central volume (blood plus
            fast-perfusing tissue, where concentration is measured) and two peripheral volumes — a
            rapidly-equilibrating one and a slow, deep one. The curve shows a steep early (α)
            distribution drop, a middle (β) phase, then a slow terminal (γ) decline as drug returns
            from the deep compartment.
          </li>
        ) : model === 'two_compartment_first_order' ? (
          <li>
            <strong>Two compartments.</strong> The body is split into a central volume (blood plus
            fast-perfusing tissue, where concentration is measured) and a peripheral volume it
            exchanges with. The curve shows a distribution phase — a steep early (α) drop as drug
            spreads into the periphery — before the slower terminal (β) decline.
          </li>
        ) : (
          <li>
            <strong>One compartment.</strong> The body is treated as a single well-mixed volume. A
            real drug with a distribution phase will show a steeper early drop than this curve does.
          </li>
        )}
        {michaelisMenten ? (
          <li>
            <strong>NOT linear — no superposition, and no half-life.</strong> Clearance falls as
            concentration rises, so doses do <em>not</em> add up: this curve is integrated as a
            whole course rather than summed from single doses, and two doses together reach higher
            than the same two doses drawn separately. There is also no single half-life to quote —
            the apparent half-life rises with concentration, so the figure in the caption is this
            dose&apos;s, not the drug&apos;s. Change the dose and it moves; that is the compound,
            not a limitation of the model.
          </li>
        ) : (
          <li>
            <strong>Linear kinetics &amp; superposition.</strong> Clearance is assumed
            dose-independent, so doses add up. This breaks down for saturable drugs — see phenytoin
            or ethanol, which are modelled differently for exactly this reason.
          </li>
        )}
        {absorptionAssumption(route)}
        <li>
          <strong>{REFERENCE_WEIGHT_KG} kg illustrative reference subject.</strong> Per-kilogram
          parameters are scaled to a fixed {REFERENCE_WEIGHT_KG} kg figure. This is a teaching
          assumption, <em>not</em> a patient weight — nothing here is individualised.
        </li>
      </ul>
    </section>
  );
}
