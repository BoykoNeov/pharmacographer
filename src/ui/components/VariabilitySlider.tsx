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

import type { HalfLifeRange, VariabilityAxis, VdRange } from '../curve.ts';
import { fmtNum } from '../curve.ts';

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
 * The ceteris-paribus each axis assumes, stated on screen rather than left to be
 * inferred. Varying Vd is ambiguous until you say what is held fixed: holding the
 * half-life makes clearance co-vary (`CL = ke·Vd`) and moves the curve straight up
 * and down, which is what makes this axis readable as something distinct from the
 * half-life slider. Holding clearance instead would drag `ke = CL/Vd` around and
 * merely restate the other slider.
 */
const AXIS_NOTES: Record<VariabilityAxis, string> = {
  half_life:
    'Volume of distribution is held at its reported value, so this changes how fast the curve falls, not how high it starts.',
  vd: 'Half-life is held at the value above, so this scales the whole curve up or down without changing its slope — clearance moves with it (CL = ke · Vd).',
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
  return (
    <div className="control">
      <span className="control__label">
        {label} = {fmtNum(value)} {unit}
        <span className="control__hint">
          {' '}
          (reported {fmtNum(low)}–{fmtNum(high)} {unit})
        </span>
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
        <span>{fmtNum(low)}</span>
        <button type="button" className="slider__nominal" onClick={() => onChange(nominal)}>
          nominal {fmtNum(nominal)}
        </button>
        <span>{fmtNum(high)}</span>
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
      <p className="control__note control__note--quiet">{AXIS_NOTES[axis]}</p>
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
  /** The reported Vd range (absolute L), or null when the source gives none. */
  vdRange?: VdRange | null;
  /** Currently selected Vd, L. */
  vdValueL?: number;
  onVdChange?: (vdL: number) => void;
  /** Which axes' bands the chart is drawing. */
  visibleBands: ReadonlySet<VariabilityAxis>;
  onVisibleBandsChange: (axis: VariabilityAxis, visible: boolean) => void;
}

export function VariabilitySlider({
  range,
  valueH,
  onChange,
  noRangeReason = 'no_reported_range',
  vdRange = null,
  vdValueL,
  onVdChange,
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
    </>
  );
}
