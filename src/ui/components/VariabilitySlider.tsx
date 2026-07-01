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
 */

import type { HalfLifeRange } from '../curve.ts';
import { fmtNum } from '../curve.ts';

interface VariabilitySliderProps {
  /** The reported half-life range (h), or null when the source gives none. */
  range: HalfLifeRange | null;
  /** Currently selected half-life, h. */
  valueH: number;
  onChange: (halfLifeH: number) => void;
}

export function VariabilitySlider({ range, valueH, onChange }: VariabilitySliderProps) {
  if (!range) {
    return (
      <div className="control">
        <span className="control__label">Half-life variability</span>
        <p className="control__note">
          This compound's source reports no half-life range, so there is no variability band to
          explore.
        </p>
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
