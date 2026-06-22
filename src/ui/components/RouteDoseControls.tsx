/**
 * Route + dose controls (handoff §9, §13 Phase 4).
 *
 * Picks the administration route, the single dose (mg), and — for `iv_infusion`
 * only — the infusion duration (h). Routes the engine cannot plot for this
 * compound (e.g. oral with no absorption data) are shown but disabled, with the
 * reason as a tooltip, so the user sees the option exists but understands why it
 * is unavailable rather than meeting a silent error. A derivable-but-not-marked-
 * available route stays selectable and carries an "inferred" note (handoff §10);
 * the full provenance treatment lands in Phase 5.
 */

import type { Route } from '../../engine/types.ts';
import type { RouteOption } from '../curve.ts';

interface RouteDoseControlsProps {
  routeOptions: RouteOption[];
  route: Route;
  onRouteChange: (route: Route) => void;
  dose: number;
  onDoseChange: (dose: number) => void;
  infusionDuration: number;
  onInfusionDurationChange: (hours: number) => void;
}

/** Parse a numeric input, falling back to 0 for empty/invalid entries. */
function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function RouteDoseControls({
  routeOptions,
  route,
  onRouteChange,
  dose,
  onDoseChange,
  infusionDuration,
  onInfusionDurationChange,
}: RouteDoseControlsProps) {
  const selected = routeOptions.find((option) => option.route === route);
  const isInferred = selected !== undefined && selected.derivable && !selected.available;

  return (
    <>
      <label className="control">
        <span className="control__label">Route</span>
        <select
          className="control__input"
          value={route}
          onChange={(event) => onRouteChange(event.target.value as Route)}
        >
          {routeOptions.map((option) => (
            <option
              key={option.route}
              value={option.route}
              disabled={!option.derivable}
              title={option.reason}
            >
              {option.label}
              {!option.derivable ? ' — no data' : option.available ? '' : ' (inferred)'}
            </option>
          ))}
        </select>
      </label>

      <label className="control">
        <span className="control__label">Dose (mg)</span>
        <input
          className="control__input"
          type="number"
          min={0}
          step="any"
          value={dose}
          onChange={(event) => onDoseChange(toNumber(event.target.value))}
        />
      </label>

      {route === 'iv_infusion' && (
        <label className="control">
          <span className="control__label">Infusion duration (h)</span>
          <input
            className="control__input"
            type="number"
            min={0}
            step="any"
            value={infusionDuration}
            onChange={(event) => onInfusionDurationChange(toNumber(event.target.value))}
          />
        </label>
      )}

      {isInferred && (
        <p className="control__note">
          This route has no route-specific data for this compound; the curve is inferred from
          disposition only, not measured for this route.
        </p>
      )}
    </>
  );
}
