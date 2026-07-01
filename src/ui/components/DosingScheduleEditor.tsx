/**
 * Dosing schedule editor (handoff §13 Phase 6).
 *
 * Controls the *repetition* structure of the dose: a single dose, or a regular
 * recurring course (interval τ, number of doses), plus any ad-hoc extra doses.
 * The per-dose amount stays in {@link RouteDoseControls} — this component only
 * shapes when doses land. App flattens the result to the engine's `DoseEvent[]`
 * via `buildSchedule`; the engine handles them all by linear superposition, so
 * "single", "recurring", and "recurring + extras" are the same code path.
 *
 * The count/interval guards here mirror the engine's `recurringDoses` invariant
 * (count ≥ 1, interval > 0 when count > 1) so a valid schedule always reaches
 * the engine and the throw-path stays a backstop, not a routine UI state.
 */

import type { DoseEvent } from '../../engine/types.ts';

export type ScheduleMode = 'single' | 'recurring';

interface DosingScheduleEditorProps {
  mode: ScheduleMode;
  onModeChange: (mode: ScheduleMode) => void;
  /** Interval τ between regular doses, h. */
  interval: number;
  onIntervalChange: (hours: number) => void;
  /** Number of regular doses. */
  count: number;
  onCountChange: (count: number) => void;
  /** Ad-hoc extra doses (time h, amount mg). */
  adHoc: DoseEvent[];
  onAdHocChange: (doses: DoseEvent[]) => void;
}

/** Parse a numeric input, falling back to 0 for empty/invalid entries. */
function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function DosingScheduleEditor({
  mode,
  onModeChange,
  interval,
  onIntervalChange,
  count,
  onCountChange,
  adHoc,
  onAdHocChange,
}: DosingScheduleEditorProps) {
  const isRecurring = mode === 'recurring';

  const updateAdHoc = (index: number, patch: Partial<DoseEvent>) => {
    onAdHocChange(adHoc.map((dose, i) => (i === index ? { ...dose, ...patch } : dose)));
  };
  const addAdHoc = () => {
    // Seed a new dose just after the last one so it isn't hidden at t = 0.
    const lastTime = adHoc.reduce((latest, dose) => Math.max(latest, dose.time), 0);
    onAdHocChange([...adHoc, { time: lastTime + 1, amount: 0 }]);
  };
  const removeAdHoc = (index: number) => {
    onAdHocChange(adHoc.filter((_, i) => i !== index));
  };

  return (
    <div className="control">
      <span className="control__label">Schedule</span>
      <div className="toggle" role="group" aria-label="Dosing schedule mode">
        <button
          type="button"
          className={`toggle__btn${!isRecurring ? ' toggle__btn--active' : ''}`}
          onClick={() => onModeChange('single')}
          aria-pressed={!isRecurring}
        >
          Single
        </button>
        <button
          type="button"
          className={`toggle__btn${isRecurring ? ' toggle__btn--active' : ''}`}
          onClick={() => onModeChange('recurring')}
          aria-pressed={isRecurring}
        >
          Recurring
        </button>
      </div>

      {isRecurring && (
        <div className="schedule__recurring">
          <label className="control control--inline">
            <span className="control__label">Interval τ (h)</span>
            <input
              className="control__input"
              type="number"
              min={0}
              step="any"
              value={interval}
              onChange={(event) => onIntervalChange(toNumber(event.target.value))}
            />
          </label>
          <label className="control control--inline">
            <span className="control__label">Number of doses</span>
            <input
              className="control__input"
              type="number"
              min={1}
              step={1}
              value={count}
              onChange={(event) => onCountChange(Math.max(1, Math.round(toNumber(event.target.value))))}
            />
          </label>
        </div>
      )}

      <div className="schedule__adhoc">
        <span className="control__label">Extra doses</span>
        {adHoc.length === 0 ? (
          <p className="control__note">None. Add a one-off dose on top of the course above.</p>
        ) : (
          <ul className="schedule__adhoc-list">
            {adHoc.map((dose, index) => (
              <li key={index} className="schedule__adhoc-row">
                <label className="control control--inline">
                  <span className="control__label">at (h)</span>
                  <input
                    className="control__input"
                    type="number"
                    min={0}
                    step="any"
                    value={dose.time}
                    onChange={(event) => updateAdHoc(index, { time: toNumber(event.target.value) })}
                  />
                </label>
                <label className="control control--inline">
                  <span className="control__label">amount (mg)</span>
                  <input
                    className="control__input"
                    type="number"
                    min={0}
                    step="any"
                    value={dose.amount}
                    onChange={(event) => updateAdHoc(index, { amount: toNumber(event.target.value) })}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => removeAdHoc(index)}
                  aria-label={`Remove extra dose ${index + 1}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn" onClick={addAdHoc}>
          + Add dose
        </button>
      </div>
    </div>
  );
}
