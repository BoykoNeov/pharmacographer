/**
 * Variability slider (handoff §5, §13 Phase 6).
 *
 * Half-life is the ONE parameter v1 varies (varying Vd/F/ka is a documented
 * non-goal — handoff §11). The shaded band on the chart shows the curve at the
 * reported low and high half-life; this slider picks a specific value inside
 * that band and drives the solid main line. It is an honesty feature: it makes
 * the point estimate visibly one choice within a reported range, not a constant.
 *
 * Rendered only when the compound reports a half-life range — the caller passes
 * `range: null` otherwise and this returns a short note instead of a dead slider.
 * The value is an ILLUSTRATIVE population half-life, never a patient's — the
 * bright line (CLAUDE.md) holds: no individual-patient input, no dosing output.
 *
 * WHY the slider is absent matters as much as that it is, so the caller says
 * which of three different things is true ({@link NoRangeReason}). "The source
 * reports no range" is the innocent case — but printing it under phenytoin would
 * be a plain falsehood: its label reports 7–42 h, and this project declines to
 * store that because the number is not a constant of the drug. A note that
 * explains a deliberate omission as a missing datum is exactly the kind of quiet
 * dishonesty this panel exists to prevent.
 */

import type { HalfLifeRange } from '../curve.ts';
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

interface VariabilitySliderProps {
  /** The reported half-life range (h), or null when there is none to show. */
  range: HalfLifeRange | null;
  /** Currently selected half-life, h. */
  valueH: number;
  onChange: (halfLifeH: number) => void;
  /** Why there is no slider — used only when `range` is null. */
  noRangeReason?: NoRangeReason;
}

export function VariabilitySlider({
  range,
  valueH,
  onChange,
  noRangeReason = 'no_reported_range',
}: VariabilitySliderProps) {
  if (!range) {
    return (
      <div className="control">
        <span className="control__label">Half-life variability</span>
        <p className="control__note">{NO_RANGE_NOTES[noRangeReason]}</p>
      </div>
    );
  }

  // A fine step (~100 stops across the band) so the line moves smoothly.
  const step = Math.max((range.high - range.low) / 100, 1e-6);

  return (
    <div className="control">
      <span className="control__label">
        Half-life t½ = {fmtNum(valueH)} h
        <span className="control__hint"> (reported {fmtNum(range.low)}–{fmtNum(range.high)} h)</span>
      </span>
      <input
        className="slider"
        type="range"
        min={range.low}
        max={range.high}
        step={step}
        value={valueH}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Elimination half-life within the reported range"
      />
      <div className="slider__scale" aria-hidden="true">
        <span>{fmtNum(range.low)}</span>
        <button type="button" className="slider__nominal" onClick={() => onChange(range.nominal)}>
          nominal {fmtNum(range.nominal)}
        </button>
        <span>{fmtNum(range.high)}</span>
      </div>
    </div>
  );
}
