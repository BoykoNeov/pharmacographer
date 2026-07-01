/**
 * Concentration-vs-time chart (handoff §9, §13 Phase 4).
 *
 * Recharts line plot of mg/L vs h, with the pedagogically-important linear ↔
 * semi-log y-axis toggle (handoff §2, §13): on a semi-log axis a first-order
 * elimination phase is a straight line, which is the whole point of offering it.
 * The toggle is purely a display concern of the chart, so the scale lives in
 * local state here rather than being lifted into App.
 *
 * Two log-scale hazards are handled explicitly:
 *   - a concentration of 0 (oral C(0) = 0) has no place on a log axis, so such
 *     points become `null` and the line simply breaks there;
 *   - the y-domain is pinned to the smallest POSITIVE concentration, because an
 *     auto-domain that still spans 0 makes the axis compute log(0) = −∞ and
 *     renders blank — pinning the floor and `allowDataOverflow` avoids that.
 */

import { useState, type CSSProperties } from 'react';
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Label,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CONCENTRATION_UNITS,
  fmtNum,
  toDisplayConcentration,
  type BandPoint,
  type ConcentrationDisplayUnit,
  type CurvePoint,
} from '../curve.ts';

type YScale = 'linear' | 'log';

interface ConcentrationChartProps {
  points: CurvePoint[];
  /**
   * The low/high half-life variability envelope, shaded behind the main line.
   * Absent when the compound reports no half-life range.
   */
  band?: BandPoint[];
  /** Right edge of the time axis, h. */
  horizonH: number;
  /** The model-predicted peak (Cmax at Tmax) of the main curve, marked on the plot. */
  peak: CurvePoint;
  /** Display unit for every concentration on the chart (data stays canonical mg/L). */
  concUnit: ConcentrationDisplayUnit;
  /** Change the concentration display unit (owned by App so the caption agrees). */
  onConcUnitChange: (unit: ConcentrationDisplayUnit) => void;
}

/** The tooltip's dark box, shared by the default and custom renderers. */
const TOOLTIP_STYLE: CSSProperties = {
  background: '#181b22',
  border: '1px solid #2a2f3a',
  borderRadius: 6,
  color: '#e8eaed',
  padding: '0.5rem 0.7rem',
  fontSize: 12,
  lineHeight: 1.5,
};

/** One row of the datum the chart plots (t, main c, and — when present — the band). */
interface ChartDatum {
  t: number;
  c: number | null;
  /** Log-clamped band the Area draws; non-positive bounds floored to the axis. */
  band?: [number, number];
  /** The true, unclamped band for the tooltip — honest even where the Area floors. */
  bandRaw?: [number, number];
}

/**
 * Tooltip content that reports the main concentration and, when a variability
 * band exists, its extremes labelled by what they MEAN (short vs long half-life)
 * rather than a bare low/high. Reads the raw band so it is truthful even at
 * points where the log axis floored the shaded area. Survives no band and a
 * null main concentration (oral C(0) = 0 on a log axis).
 */
function ConcTooltip(props: {
  active?: boolean;
  payload?: { payload: ChartDatum }[];
  concUnit: ConcentrationDisplayUnit;
}) {
  const { active, payload, concUnit } = props;
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const fmt = (v: number) => `${fmtNum(toDisplayConcentration(v, concUnit))} ${concUnit}`;
  return (
    <div style={TOOLTIP_STYLE}>
      <div>t = {fmtNum(datum.t, 3)} h</div>
      <div>Concentration: {datum.c == null ? '—' : fmt(datum.c)}</div>
      {datum.bandRaw && (
        <>
          <div style={{ color: '#9aa0a6' }}>Short t½ (fast elim.): {fmt(datum.bandRaw[0])}</div>
          <div style={{ color: '#9aa0a6' }}>Long t½ (slow elim.): {fmt(datum.bandRaw[1])}</div>
        </>
      )}
    </div>
  );
}

export function ConcentrationChart({
  points,
  band,
  horizonH,
  peak,
  concUnit,
  onConcUnitChange,
}: ConcentrationChartProps) {
  const [yScale, setYScale] = useState<YScale>('linear');
  const [showPeak, setShowPeak] = useState(true);
  const isLog = yScale === 'log';

  // The log axis spans every plotted series, band included.
  const positives = [
    ...points.map((p) => p.c),
    ...(band ?? []).flatMap((b) => [b.cLow, b.cHigh]),
  ].filter((c) => c > 0);
  const minPositive = positives.length > 0 ? Math.min(...positives) : 1e-6;
  const maxPositive = positives.length > 0 ? Math.max(...positives) : 1;

  // Semi-log: snap the domain to whole decades and tick each 10ⁿ across it. A
  // plain [minPositive, 'auto'] domain would push the edge decade ticks outside
  // the axis, so they wouldn't render. Snapping means a narrow curve (< 1 decade)
  // rides high in its decade band — inherent to a log axis, and the conventional
  // choice. Decades stay round in any unit because the unit factors are all 10ⁿ.
  const loExp = Math.floor(Math.log10(minPositive));
  const hiExp = Math.max(loExp + 1, Math.ceil(Math.log10(maxPositive)));
  const logDomain: [number, number] = [Math.pow(10, loExp), Math.pow(10, hiExp)];
  const decadeTicks: number[] = [];
  for (let e = loExp; e <= hiExp; e++) decadeTicks.push(Math.pow(10, e));

  // Recharts draws a range area from a `[low, high]` dataKey. On a log axis a
  // non-positive bound cannot be plotted, so we floor it to `minPositive` (the
  // band edge simply rides the axis floor) and null non-positive line points so
  // the line breaks rather than collapsing the axis. `bandRaw` keeps the true
  // values for the tooltip, which should not lie about a floored point.
  const clampLog = (value: number): number => (isLog && !(value > 0) ? minPositive : value);
  const data: ChartDatum[] = points.map((point, i) => {
    const b = band?.[i];
    return {
      t: point.t,
      c: isLog && !(point.c > 0) ? null : point.c,
      band: b ? [clampLog(b.cLow), clampLog(b.cHigh)] : undefined,
      bandRaw: b ? [b.cLow, b.cHigh] : undefined,
    };
  });

  return (
    <div className="chart">
      <div className="chart__toolbar">
        <div className="toggle" role="group" aria-label="Peak marker">
          <button
            type="button"
            className={`toggle__btn${showPeak ? ' toggle__btn--active' : ''}`}
            onClick={() => setShowPeak((v) => !v)}
            aria-pressed={showPeak}
          >
            Cmax / Tmax
          </button>
        </div>
        <span className="chart__toolbar-label">units</span>
        <div className="toggle" role="group" aria-label="Concentration unit">
          {CONCENTRATION_UNITS.map((unit) => (
            <button
              key={unit}
              type="button"
              className={`toggle__btn${unit === concUnit ? ' toggle__btn--active' : ''}`}
              onClick={() => onConcUnitChange(unit)}
              aria-pressed={unit === concUnit}
            >
              {unit}
            </button>
          ))}
        </div>
        <span className="chart__toolbar-label">y-axis</span>
        <div className="toggle" role="group" aria-label="Y-axis scale">
          <button
            type="button"
            className={`toggle__btn${!isLog ? ' toggle__btn--active' : ''}`}
            onClick={() => setYScale('linear')}
            aria-pressed={!isLog}
          >
            Linear
          </button>
          <button
            type="button"
            className={`toggle__btn${isLog ? ' toggle__btn--active' : ''}`}
            onClick={() => setYScale('log')}
            aria-pressed={isLog}
          >
            Semi-log
          </button>
        </div>
      </div>

      <div className="chart__canvas">
        <ResponsiveContainer width="100%" height="100%">
          {/* Top margin leaves room for the Cmax label, which sits above the
              peak — the highest point on the plot — so a tight margin clips it. */}
          <ComposedChart data={data} margin={{ top: 30, right: 24, bottom: 28, left: 16 }}>
            <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="t"
              domain={[0, horizonH]}
              stroke="#9aa0a6"
              tick={{ fill: '#9aa0a6', fontSize: 12 }}
              tickFormatter={(value: number) => fmtNum(value, 3)}
            >
              <Label value="Time (h)" position="insideBottom" offset={-16} fill="#9aa0a6" />
            </XAxis>
            <YAxis
              scale={isLog ? 'log' : 'linear'}
              domain={isLog ? logDomain : [0, 'auto']}
              ticks={isLog ? decadeTicks : undefined}
              allowDataOverflow={isLog}
              stroke="#9aa0a6"
              // ng/mL multiplies every tick by 1000, so its labels need more room.
              width={concUnit === 'ng/mL' ? 84 : 68}
              tick={{ fill: '#9aa0a6', fontSize: 12 }}
              tickFormatter={(value: number) => fmtNum(toDisplayConcentration(value, concUnit), 3)}
            >
              <Label
                value={`Concentration (${concUnit})`}
                angle={-90}
                position="insideLeft"
                fill="#9aa0a6"
                style={{ textAnchor: 'middle' }}
              />
            </YAxis>
            <Tooltip content={<ConcTooltip concUnit={concUnit} />} />
            {band && (
              <Area
                type="monotone"
                dataKey="band"
                stroke="none"
                fill="#5b9dd9"
                fillOpacity={0.18}
                isAnimationActive={false}
                activeDot={false}
                tooltipType="none"
              />
            )}
            <Line
              type="monotone"
              dataKey="c"
              stroke="#5b9dd9"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            {showPeak && peak.c > 0 && (
              <ReferenceDot
                x={peak.t}
                y={peak.c}
                r={5}
                fill="#f2c94c"
                stroke="#0b0d11"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
              >
                <Label
                  value={`Cmax ${fmtNum(toDisplayConcentration(peak.c, concUnit))} ${concUnit} @ ${fmtNum(peak.t)} h`}
                  // Peaks sitting on the y-axis (IV bolus, Tmax = 0) would clip a
                  // top-centred label off the left edge, so anchor those to the right.
                  position={peak.t < horizonH * 0.08 ? 'right' : 'top'}
                  fill="#f2c94c"
                  fontSize={12}
                  offset={8}
                />
              </ReferenceDot>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
