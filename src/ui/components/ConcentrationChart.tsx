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

import { useState } from 'react';
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
import { fmtNum, type BandPoint, type CurvePoint } from '../curve.ts';

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
}

export function ConcentrationChart({ points, band, horizonH, peak }: ConcentrationChartProps) {
  const [yScale, setYScale] = useState<YScale>('linear');
  const [showPeak, setShowPeak] = useState(true);
  const isLog = yScale === 'log';

  // The log-axis floor must clear every plotted series, band included.
  const positives = [
    ...points.map((p) => p.c),
    ...(band ?? []).flatMap((b) => [b.cLow, b.cHigh]),
  ].filter((c) => c > 0);
  const minPositive = positives.length > 0 ? Math.min(...positives) : 1e-6;

  // Recharts draws a range area from a `[low, high]` dataKey. On a log axis a
  // non-positive bound cannot be plotted, so we floor it to `minPositive` (the
  // band edge simply rides the axis floor) and null non-positive line points so
  // the line breaks rather than collapsing the axis.
  const clampLog = (value: number): number => (isLog && !(value > 0) ? minPositive : value);
  const data = points.map((point, i) => {
    const b = band?.[i];
    return {
      t: point.t,
      c: isLog && !(point.c > 0) ? null : point.c,
      band: b ? [clampLog(b.cLow), clampLog(b.cHigh)] : undefined,
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
          <ComposedChart data={data} margin={{ top: 12, right: 24, bottom: 28, left: 16 }}>
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
              domain={isLog ? [minPositive, 'auto'] : [0, 'auto']}
              allowDataOverflow={isLog}
              stroke="#9aa0a6"
              width={68}
              tick={{ fill: '#9aa0a6', fontSize: 12 }}
              tickFormatter={(value: number) => fmtNum(value, 3)}
            >
              <Label
                value="Concentration (mg/L)"
                angle={-90}
                position="insideLeft"
                fill="#9aa0a6"
                style={{ textAnchor: 'middle' }}
              />
            </YAxis>
            <Tooltip
              contentStyle={{
                background: '#181b22',
                border: '1px solid #2a2f3a',
                borderRadius: 6,
                color: '#e8eaed',
              }}
              labelFormatter={(label) => `t = ${fmtNum(Number(label), 3)} h`}
              formatter={(value) => [`${fmtNum(Number(value), 3)} mg/L`, 'Concentration']}
            />
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
                  value={`Cmax ${fmtNum(peak.c)} @ ${fmtNum(peak.t)} h`}
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
