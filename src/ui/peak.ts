/**
 * What the marked point on the curve MEANS — resolved once, per route, for every
 * surface that says anything about it.
 *
 * ## Why this file exists
 *
 * Five surfaces independently asked "does this curve have a peak, or does it just
 * end?", and each answered it with its own `route === 'transdermal'` ternary:
 *
 *  1. the chart's peak-marker toggle button (`ConcentrationChart`);
 *  2. the label on the marker dot itself (`ConcentrationChart`);
 *  3. the live caption's Cmax/Tmax clause (`ModelCaption`);
 *  4. the standing note's heading and opening clause (`PeakNote`);
 *  5. that same note's closing "not a measured Cmax from any study" noun.
 *
 * Every one of them was correct. That is not the problem — the problem is that
 * correctness had to be achieved five times, and a sixth route (or a change of
 * mind about the fifth) has to land in five places or the chart contradicts the
 * paragraph under it. That defect has shipped THREE times in this project already
 * (transdermal `PeakNote`, rectal `ModelAssumptionsNote`, subcutaneous `PeakNote`),
 * every time with a green suite and a happy typechecker, and every time it was
 * found only by launching the app. Prose is invisible to tests; agreement between
 * five copies of a decision is invisible to types.
 *
 * So the decision is made ONCE here and the five surfaces render its output. They
 * no longer see `route` for this question at all. A new route cannot inherit an
 * answer, because {@link PEAK_SEMANTICS} is an exhaustive `Record<DataRoute, …>`
 * and fails to compile until someone writes its entry — the same fix already
 * carried by `BIOAVAILABILITY_LABELS`, `DATA_ROUTES`, `FIRST_ORDER_ABSORPTION_COPY`
 * and `ROUTE_MEANING` (which is now this file's {@link PeakSemantics.meaning}).
 *
 * ## Why the entries are built by factories rather than spelled out
 *
 * The five surfaces cannot disagree if they cannot be written apart. {@link peaking}
 * builds all of one route's strings from one decision, so "the toolbar says Cmax /
 * Tmax but the note says End of wear" is not a state this file can express.
 *
 * ## Why the kind is named for the physics, not for the product
 *
 * `end_of_input`, not `end_of_wear`. A patch is today's only instance, but the
 * property is not "is a patch" — it is "the plotted window ends while the input is
 * still running, so the curve never turns over". Any future route with a stated
 * delivery window (an implant, a depot with a quoted duration) is the same kind
 * with a different noun for its window, which is why the noun is a per-route
 * string and the kind is not. Naming the kind after patches would invite a fifth
 * kind instead of a second instance.
 */

import type { DataRoute } from '../data/schema.ts';
import type { HalfLifeAxisRegime } from './curve.ts';

/**
 * Whether the marked point is a genuine turning point of the curve, or merely
 * where the plot stops.
 *
 * This is a claim about the SHAPE of the plotted curve, and it is checked against
 * one: `tests/ui/peak-semantics.test.tsx` builds every compound on every derivable
 * route and asserts `end_of_input` holds exactly of the curves still rising at the
 * right edge. So a route mis-assigned here is a test failure, not a paragraph
 * nobody reads. (Structurally, only `transdermal` can be `end_of_input` today:
 * `curveHorizon` gives an infusion `infusionDuration + 5·t½`, so its peak is always
 * well inside the window, and the patch path is the one place the horizon is
 * truncated at the input's end — see `buildCurve`.)
 */
export type PeakKind =
  /** The curve rises, turns over, and falls: "Cmax at Tmax" is a fact about the drug. */
  | 'peak'
  /** The curve is still climbing when the window ends: the mark is the window's end. */
  | 'end_of_input';

/** Everything any surface needs to say about the marked point, for one route. */
export interface PeakSemantics {
  /** Whether there is a turning point at all. See {@link PeakKind}. */
  kind: PeakKind;
  /** Chart toolbar toggle, and {@link PeakSemantics} note heading. */
  heading: string;
  /** Prefix on the in-chart marker dot's label. */
  markerPrefix: string;
  /** The note's first clause, following the heading: "<heading> — <opener>". */
  opener: string;
  /** Fills "…it is not a measured <measuredNoun> from any study." */
  measuredNoun: string;
  /**
   * The live caption's clause, given the already-formatted concentration (with
   * its unit) and time. A function rather than a template because the two kinds
   * put the number and the time in different orders — a peak leads with "Cmax",
   * an end-of-input curve cannot.
   */
  captionClause: (concWithUnit: string, timeH: string) => string;
  /**
   * The standing explanation of what the mark means on THIS route — the paragraph
   * under the chart. Route-specific by nature (the physiology differs even where
   * the kind does not), and regime-aware because under flip-flop kinetics naming
   * elimination as the cause of the falling limb is false. See
   * `docs/DATA_GUIDE.md` "rate-limiting-step screen".
   */
  meaning: (regime: HalfLifeAxisRegime) => string;
}

/**
 * A route whose curve genuinely turns over. Takes only its own explanation: every
 * Cmax/Tmax string is fixed here, so no peaking route can drift from another.
 */
function peaking(meaning: PeakSemantics['meaning']): PeakSemantics {
  return {
    kind: 'peak',
    heading: 'Cmax / Tmax',
    markerPrefix: 'Cmax',
    opener: 'the peak concentration the model predicts and the time it occurs.',
    measuredNoun: 'Cmax',
    captionClause: (conc, t) => `Cmax ${conc} at Tmax ${t} h`,
    meaning,
  };
}

/**
 * A route whose plotted window ends while the input is still running. The caller
 * supplies the noun for its own window ("wear"), because that is a property of the
 * product; everything the KIND implies — that there is no Cmax and no Tmax to name
 * — is fixed here, so an end-of-input route cannot accidentally claim a peak.
 */
function endOfInput({
  heading,
  opener,
  captionClause,
  meaning,
}: {
  heading: string;
  opener: string;
  captionClause: PeakSemantics['captionClause'];
  meaning: PeakSemantics['meaning'];
}): PeakSemantics {
  return {
    kind: 'end_of_input',
    heading,
    // Deliberately the same string as the heading: there is no shorter noun for it
    // the way "Cmax" shortens "Cmax / Tmax", and inventing one ("End", "Off") would
    // read on the dot as if it marked something else.
    markerPrefix: heading,
    opener,
    // NOT "Cmax": the whole point is that no such quantity exists here.
    measuredNoun: 'concentration',
    captionClause,
    meaning,
  };
}

/** A peaking route whose explanation does not depend on the flip-flop regime. */
const fixed =
  (sentence: string): PeakSemantics['meaning'] =>
  () =>
    sentence;

/**
 * The one place the question is answered. Exhaustive over {@link DataRoute}: a new
 * route fails to compile until someone decides, once, whether its curve peaks —
 * and every surface then follows automatically.
 */
export const PEAK_SEMANTICS: Record<DataRoute, PeakSemantics> = {
  iv_bolus: peaking(
    fixed(
      'An IV bolus peaks the instant it is given (Tmax = 0), at Cmax = dose / Vd, then only falls.',
    ),
  ),
  iv_infusion: peaking(fixed('A constant infusion peaks at the end of the infusion, then falls.')),
  // The peak is where the two rates balance whichever one is slower, so that clause
  // holds in both regimes; what does NOT hold in both is naming elimination as the
  // cause of the fall.
  oral: peaking((regime) =>
    regime === 'elimination_limited'
      ? 'An oral dose rises as it is absorbed and falls as it is eliminated; the peak (Tmax) is where those balance.'
      : 'An oral dose rises as it is absorbed and falls once elimination outpaces what is still arriving; the peak (Tmax) is where those balance. Here absorption is the slower step, so what the curve falls at after the peak is the ABSORPTION rate — the drug is eliminated as fast as it gets in, and the tail measures how slowly it arrives, not how quickly it leaves.',
  ),
  // An IM depot is first-order in, exactly like a tablet, so the peak means the
  // same THING — but the oral sentence names the gut and, more importantly, an
  // oral F is net of first-pass extraction while an IM F is not.
  im: peaking(
    fixed(
      'An intramuscular dose rises as it is absorbed from the muscle depot and falls as it is eliminated; the peak (Tmax) is where those balance. The shape is a tablet’s, but the fraction is not: an injection drains straight to the systemic circulation, so its F is absorption completeness only — it carries no first-pass loss through gut wall and liver, which is why the same drug can reach far higher concentrations by needle than by mouth at the same dose.',
    ),
  ),
  // SC gets its own sentence even though its F is the SAME category as IM's, which
  // is the opposite of why `im` and `rectal` got theirs. The physiology it must not
  // misstate is the ANATOMY (fat, not muscle) and the RATE (slower, more variable);
  // the F claim it makes is deliberately identical in substance to IM's, because
  // saying anything else would invent a distinction that does not exist.
  sc: peaking(
    fixed(
      'A subcutaneous dose rises as it is absorbed from the fatty layer under the skin and falls as it is eliminated; the peak (Tmax) is where those balance. Its F means exactly what an intramuscular F means — absorption completeness, carrying no first-pass loss, because an injection of either kind drains straight to the systemic circulation without crossing gut wall or liver. What differs from a muscle depot is the RATE, not the fraction: subcutaneous fat is less well perfused than muscle, so absorption is typically slower and more variable between people and between injection sites.',
    ),
  ),
  // The third meaning of F. IM's sentence above ("carries no first-pass loss") and
  // oral's implicit full one are both FALSE here: rectal venous drainage is split,
  // so the bypass is partial. Written for any rectal compound, not for diazepam.
  rectal: peaking(
    fixed(
      'A rectal dose rises as it is absorbed across the rectal mucosa and falls as it is eliminated; the peak (Tmax) is where those balance — the same shape as a tablet. Its F is a third thing again: rectal veins drain PARTLY to the portal circulation and partly straight to the systemic one, so part of the dose meets the liver first and part escapes it. Rectal administration therefore recovers some, but not all, of what a swallowed dose loses to first pass — and how much it recovers depends on how much the liver was taking in the first place, so for a drug the liver barely extracts the gain is small.',
    ),
  ),
  transdermal: endOfInput({
    heading: 'End of wear',
    opener: 'the concentration the model predicts the patch reaches by the time it comes off.',
    // A worn patch never turns over, so it has no Tmax: this is where the wear
    // period ends, not where the curve peaked.
    captionClause: (conc, t) => `${conc} at end of wear (${t} h)`,
    // Phrased for every patch, not just one that reached its plateau.
    meaning: fixed(
      'A patch worn continuously has no peak at all: it climbs steadily toward a plateau at Css = R0/CL — set by clearance alone, not by Vd — and never turns over, because nothing is ever taken off. The marker is simply the concentration reached when the wear period ends, so its time is a property of the product, not of the drug.',
    ),
  }),
};

/** The marked point's meaning on `route`. The only entry point; see {@link PEAK_SEMANTICS}. */
export function peakSemanticsFor(route: DataRoute): PeakSemantics {
  return PEAK_SEMANTICS[route];
}
