/**
 * Variability controls (handoff §5, §12, §13 Phase 6).
 *
 * A compound's reported parameters are ranges, not constants, and this panel is
 * where that becomes visible: one slider per varied parameter, each with its own
 * shaded band on the chart. It is an honesty feature — it makes the point
 * estimate visibly ONE choice within a reported range.
 *
 * Half-life shipped first and was for a long time the only axis. Vd is the second
 * (handoff §12). The two are varied INDEPENDENTLY and drawn as separate bands,
 * never merged into one envelope — see {@link VariabilityAxis} in `curve.ts` for
 * why a merged edge would be a person nobody measured. Each slider therefore
 * carries its own show-band checkbox, so the reader can look at one lesson at a
 * time or compare which parameter dominates the spread.
 *
 * A slider renders only when the compound reports that parameter's range; the
 * caller passes `range: null` otherwise and gets a short note instead of a dead
 * control. Every value here is an ILLUSTRATIVE population parameter, never a
 * patient's — the bright line (CLAUDE.md) holds: no individual-patient input, no
 * dosing output.
 *
 * WHY the half-life slider is absent matters as much as that it is, so the caller
 * says which of three different things is true ({@link NoRangeReason}). "The
 * source reports no range" is the innocent case — but printing it under phenytoin
 * would be a plain falsehood: its label reports 7–42 h, and this project declines
 * to store that because the number is not a constant of the drug. A note that
 * explains a deliberate omission as a missing datum is exactly the kind of quiet
 * dishonesty this panel exists to prevent.
 */

import type {
  FRange,
  HalfLifeAxisRegime,
  HalfLifeRange,
  VariabilityAxis,
  VdRange,
} from '../curve.ts';
import { fmtNum, fmtPercent } from '../curve.ts';

/** Why a compound has no half-life slider. */
export type NoRangeReason =
  /** One-compartment, but the source gives a point half-life and no range. */
  | 'no_reported_range'
  /** Multi-compartment: several half-lives at once, so there is no single one to slide. */
  | 'multi_compartment'
  /** Saturable: the half-life is not a constant at all — it moves with concentration. */
  | 'nonlinear';

const NO_RANGE_NOTES: Record<NoRangeReason, string> = {
  no_reported_range:
    "This compound's source reports a single half-life and no range, so there is no reported variability to explore.",
  multi_compartment:
    'This compound has more than one half-life at once — a fast distribution phase and a slower terminal one — so there is no single value to slide. The caption reports each phase separately.',
  nonlinear:
    'This compound has no fixed half-life to vary. Its elimination saturates, so the apparent half-life rises with concentration: it changes when you change the dose, which the caption shows as a range rather than a number. A slider here would imply a constant that does not exist.',
};

/**
 * What the half-life slider does — which is not one thing.
 *
 * The ordinary sentence ("changes how fast the curve falls, not how high it
 * starts") describes elimination being the slow step, which it is for every
 * shipped compound but one. Under FLIP-FLOP kinetics (`ka < ke`) absorption is
 * the slow step and the sentence reverses: on acamprosate the tail rate does not
 * budge across the entire reported 2.5–3.5 h range, while the peak moves 25%.
 * Printing the ordinary copy there would state the opposite of what the reader
 * is watching happen. See {@link HalfLifeAxisRegime} for why the regime is
 * decided at the range's extremes rather than at its nominal.
 *
 * The flip-flop copy does not merely negate the ordinary one — it says WHY, and
 * the why is the whole reason a flip-flop compound is worth shipping: a curve's
 * terminal slope is the slower of the two rates, so it is not automatically the
 * elimination rate. That is the lesson acamprosate is on the compound list for,
 * and the slider is where a reader can watch it fail to happen.
 */
const HALF_LIFE_NOTES: Record<HalfLifeAxisRegime, string> = {
  elimination_limited:
    'Volume of distribution is held at its reported value, so this changes how fast the curve falls, not how high it starts.',
  absorption_limited:
    'Volume of distribution is held at its reported value. This compound absorbs more slowly than it eliminates, so watch what does NOT move: the tail keeps the same slope wherever you put this slider, because that slope is the absorption rate, not the elimination rate. What changes is the height — a longer half-life clears each absorbed amount more slowly, so more accumulates. A curve’s terminal slope is always the slower of the two steps, which is only usually elimination.',
  mixed:
    'Volume of distribution is held at its reported value. This slider then does two different things across its own range: over part of it absorption is the slower step, and the tail holds its slope while the height moves; over the rest elimination is slower and the tail tilts as usual. The terminal slope always follows whichever step is slower, and this compound’s reported range crosses over between them.',
};

/**
 * What each axis actually does, stated on screen rather than left to be inferred.
 *
 * For the first two axes that means naming the CETERIS PARIBUS, because varying
 * Vd is ambiguous until you say what is held fixed: holding the half-life makes
 * clearance co-vary (`CL = ke·Vd`) and moves the curve straight up and down,
 * which is what makes this axis readable as something distinct from the half-life
 * slider. Holding clearance instead would drag `ke = CL/Vd` around and merely
 * restate the other slider.
 *
 * F is deliberately NOT written to that template, and the temptation to clone it
 * is precisely the trap this project keeps falling into — the transdermal route
 * shipped a peak explanation copied from the oral one, under a curve that never
 * peaked, with every test green. There is no ceteris-paribus decision to report
 * here: F scales the mass that gets in, and nothing has to be held anywhere for
 * that to be well defined. What DOES need saying is why this band looks exactly
 * like the Vd one — the `V/F` non-identifiability. See {@link VariabilityAxis}.
 *
 * Note what this copy stops short of. An earlier draft told the reader to treat
 * the two bands as "one uncertainty seen twice, not two to add together". That
 * fused a true claim to a false one: you genuinely cannot ATTRIBUTE a height
 * change to F or to Vd from the curve, but F and Vd are separately-measured
 * physical quantities that both vary between people, and a high-F / small-Vd
 * person is perfectly coherent — for morphine that corner is 1.7× the nominal
 * height, well outside either band alone. Combining them is not forbidden; it is
 * simply something this tool cannot do honestly, because nothing in the data
 * says how F and Vd covary. So the copy instructs on neither adding nor not
 * adding, and confines itself to what is actually known.
 */
const AXIS_NOTES: Record<VariabilityAxis, string> = {
  half_life: HALF_LIFE_NOTES.elimination_limited,
  vd: 'Half-life is held at the value above, so this scales the whole curve up or down without changing its slope — clearance moves with it (CL = ke · Vd).',
  f: 'This scales the dose that actually gets in, so it moves the curve up and down in exactly the same way the volume slider does. That is not a coincidence: an oral curve shows only the ratio V/F, so from the height alone you cannot tell whether someone absorbed more drug or has a smaller volume to dilute it in. They are still two different quantities, and the difference shows up off the parent line — changing F moves the metabolite curves, and changing the volume does not.',
};

/** One labelled slider over a reported [low, high] range, with its band toggle. */
interface AxisSliderProps {
  axis: VariabilityAxis;
  /** Control label, e.g. "Half-life t½". Rendered upper-cased by `.control__label`. */
  label: string;
  /**
   * Symbol for the band checkbox ("t½", "Vd"). Separate from {@link label}
   * because that one is styled all-caps, which mangles a symbol spelled out
   * inside a sentence ("Show volume of distribution vd band").
   */
  shortLabel: string;
  /**
   * How a value on this axis is written. Defaults to "<number> <unit>", which is
   * right for hours and litres; F overrides it because a bioavailable fraction is
   * universally read as a percent, and rendering the canonical 0.292 would make
   * the reader work out what it is a fraction of.
   */
  format?: (value: number) => string;
  /**
   * Overrides {@link AXIS_NOTES} for this axis. Used only by half-life, whose
   * note depends on which rate is rate-limiting ({@link HALF_LIFE_NOTES}).
   */
  note?: string;
  /** Unit shown after the value and the range, e.g. "h" or "L". */
  unit: string;
  low: number;
  nominal: number;
  high: number;
  value: number;
  onChange: (next: number) => void;
  /** Whether this axis's band is drawn on the chart. */
  bandVisible: boolean;
  onBandVisibleChange: (visible: boolean) => void;
}

function AxisSlider({
  axis,
  label,
  shortLabel,
  format,
  note,
  unit,
  low,
  nominal,
  high,
  value,
  onChange,
  bandVisible,
  onBandVisibleChange,
}: AxisSliderProps) {
  // A fine step (~100 stops across the band) so the line moves smoothly.
  const step = Math.max((high - low) / 100, 1e-6);
  const show = format ?? ((v: number) => `${fmtNum(v)} ${unit}`);
  // The range hint carries a shared unit ONCE ("1.3–2.2 h") rather than on each
  // bound. Repeating it wrapped the half-life label onto a second line, which
  // shifts every control below it as the compound changes — the same
  // fixed-height discipline the About box exists for. A percent sign is not a
  // trailing unit, so `format` (F) keeps it on both bounds.
  const showRange = format
    ? `${format(low)}–${format(high)}`
    : `${fmtNum(low)}–${fmtNum(high)} ${unit}`;
  return (
    <div className="control">
      <span className="control__label">
        {label} = {show(value)}
        <span className="control__hint"> (reported {showRange})</span>
      </span>
      <input
        className="slider"
        type="range"
        min={low}
        max={high}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label} within the reported range`}
      />
      <div className="slider__scale" aria-hidden="true">
        <span>{show(low)}</span>
        <button type="button" className="slider__nominal" onClick={() => onChange(nominal)}>
          nominal {show(nominal)}
        </button>
        <span>{show(high)}</span>
      </div>
      {/* The band toggle sits WITH its slider, not in the chart toolbar, so the
          causal link between the range and the shaded region is on screen rather
          than inferred. (Metabolite line toggles live in the toolbar because they
          have no matching control to sit beside.) */}
      <label className="band-toggle">
        <input
          type="checkbox"
          checked={bandVisible}
          onChange={(event) => onBandVisibleChange(event.target.checked)}
        />
        Show {shortLabel} band
      </label>
      <p className="control__note control__note--quiet">{note ?? AXIS_NOTES[axis]}</p>
    </div>
  );
}

interface VariabilitySliderProps {
  /** The reported half-life range (h), or null when there is none to show. */
  range: HalfLifeRange | null;
  /** Currently selected half-life, h. */
  valueH: number;
  onChange: (halfLifeH: number) => void;
  /** Why there is no half-life slider — used only when `range` is null. */
  noRangeReason?: NoRangeReason;
  /**
   * Which rate the half-life slider can actually move, selecting its note.
   * Defaults to the ordinary elimination-limited case, which is right for every
   * shipped compound except the flip-flop one.
   */
  halfLifeRegime?: HalfLifeAxisRegime;
  /** The reported Vd range (absolute L), or null when the source gives none. */
  vdRange?: VdRange | null;
  /** Currently selected Vd, L. */
  vdValueL?: number;
  onVdChange?: (vdL: number) => void;
  /**
   * The reported oral bioavailability range (fraction), or null. Null on every
   * non-oral route: IV is F = 1 by definition and a patch stores no F at all, so
   * there is nothing to vary rather than something the source failed to report.
   */
  fRange?: FRange | null;
  /** Currently selected F, as a fraction. */
  fValue?: number;
  onFChange?: (f: number) => void;
  /** Which axes' bands the chart is drawing. */
  visibleBands: ReadonlySet<VariabilityAxis>;
  onVisibleBandsChange: (axis: VariabilityAxis, visible: boolean) => void;
}

export function VariabilitySlider({
  range,
  valueH,
  onChange,
  noRangeReason = 'no_reported_range',
  halfLifeRegime = 'elimination_limited',
  vdRange = null,
  vdValueL,
  onVdChange,
  fRange = null,
  fValue,
  onFChange,
  visibleBands,
  onVisibleBandsChange,
}: VariabilitySliderProps) {
  return (
    <>
      {range ? (
        <AxisSlider
          axis="half_life"
          label="Half-life t½"
          shortLabel="t½"
          note={HALF_LIFE_NOTES[halfLifeRegime]}
          unit="h"
          low={range.low}
          nominal={range.nominal}
          high={range.high}
          value={valueH}
          onChange={onChange}
          bandVisible={visibleBands.has('half_life')}
          onBandVisibleChange={(visible) => onVisibleBandsChange('half_life', visible)}
        />
      ) : (
        <div className="control">
          <span className="control__label">Half-life variability</span>
          <p className="control__note">{NO_RANGE_NOTES[noRangeReason]}</p>
        </div>
      )}
      {/* Vd carries no equivalent "why not" note, which is a judgement about
          REDUNDANCY rather than a claim that its absence is always innocent. It
          is absent for two different reasons: the source reported a point value
          (innocent), or the compound is multi-compartment / saturable, where
          there is no single volume to slide any more than there is a single
          half-life. In that second case the note directly above has ALREADY said
          the compound has no one value of this kind, and repeating it per
          parameter would turn one clear sentence into a wall the reader skips.
          If a third axis ever lands, revisit — the argument is about how much
          near-identical prose one panel can carry, not about it being fine to
          stay silent. */}
      {vdRange && vdValueL !== undefined && onVdChange && (
        <AxisSlider
          axis="vd"
          // Not "Volume of distribution Vd": `.control__label` upper-cases, which
          // would render the symbol as "VD".
          label="Volume of distribution"
          shortLabel="Vd"
          unit="L"
          low={vdRange.low}
          nominal={vdRange.nominal}
          high={vdRange.high}
          value={vdValueL}
          onChange={onVdChange}
          bandVisible={visibleBands.has('vd')}
          onBandVisibleChange={(visible) => onVisibleBandsChange('vd', visible)}
        />
      )}
      {fRange && fValue !== undefined && onFChange && (
        <AxisSlider
          axis="f"
          // "Bioavailability F" would render "BIOAVAILABILITY F" — acceptable, but
          // the symbol is carried by the value ("= 29.2%") and the short label, so
          // the control name stays plain English like the other two.
          label="Bioavailability"
          shortLabel="F"
          format={fmtPercent}
          unit=""
          low={fRange.low}
          nominal={fRange.nominal}
          high={fRange.high}
          value={fValue}
          onChange={onFChange}
          bandVisible={visibleBands.has('f')}
          onBandVisibleChange={(visible) => onVisibleBandsChange('f', visible)}
        />
      )}
    </>
  );
}
