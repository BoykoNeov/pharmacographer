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
  Legend,
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
  metaboliteTag,
  toDisplayConcentration,
  type ConcentrationDisplayUnit,
  type CurvePoint,
  type MetaboliteCurve,
  type VariabilityAxis,
  type VariabilityBand,
} from '../curve.ts';

type YScale = 'linear' | 'log';

/** The parent (main) line colour — the accent used across the app. */
const PARENT_COLOR = '#5b9dd9';

/**
 * Distinct hues for metabolite lines, cycled by index. Chosen to stand clear of
 * the parent blue and the yellow Cmax marker; metabolite lines are also dashed,
 * so the legend — not the colour alone — carries "this is a computed metabolite".
 */
const METABOLITE_COLORS = ['#e0794f', '#9b8cf5', '#4fbf9f', '#d95b9d'];

/**
 * How each variability band is shaded. Two bands can overlap, and on a semi-log
 * axis an overlap of two flat translucent fills reads as a third colour that means
 * nothing — so each axis gets a distinct diagonal HATCH as well as a hue. The
 * hatching is what survives the overlap: crossing strokes stay individually
 * traceable where crossing washes do not, and it keeps the bands distinguishable
 * without relying on colour alone.
 */
const BAND_STYLES: Record<VariabilityAxis, { color: string; angle: number; label: string }> = {
  // The half-life band keeps the parent's own blue: it is the long-standing
  // default band, and re-hueing it would make every existing screenshot wrong.
  half_life: { color: PARENT_COLOR, angle: 45, label: 'half-life t½' },
  vd: { color: '#c9a227', angle: -45, label: 'volume Vd' },
  // A third distinct angle — the base stroke is vertical, so 90° lays it FLAT.
  // (45 and −45 are the two diagonals; horizontal is the remaining direction that
  // crosses both of them cleanly.) F is COLLINEAR with Vd on the parent
  // curve (both are pure vertical rescales — see `VariabilityAxis`), so these two
  // bands are concentric by construction and one will often sit inside the other.
  // A shared or near-shared angle would make the inner one unreadable exactly
  // where it matters most.
  f: { color: '#7f9f5b', angle: 90, label: 'bioavailability F' },
};

/** Stable empty default for `visibleBands` (a fresh Set would re-render on every pass). */
const EMPTY_AXES: ReadonlySet<VariabilityAxis> = new Set();

interface ConcentrationChartProps {
  points: CurvePoint[];
  /**
   * Variability envelopes, one per varied parameter, shaded behind the main line.
   * Each is that parameter's reported range with the others held where the main
   * line has them — deliberately NOT merged into a single outer envelope, whose
   * edge would be a person extreme on two parameters at once (see
   * {@link VariabilityAxis}). Empty/absent when the compound reports no ranges.
   */
  bands?: VariabilityBand[];
  /**
   * Which bands to draw. Owned by App rather than the chart because each band's
   * on/off control sits with its slider in the controls panel, so the range and
   * the shaded region it produces are visibly the same idea. Defaults to none,
   * which pairs with the `bands` prop: a caller that supplies no envelopes has
   * nothing to make visible.
   */
  visibleBands?: ReadonlySet<VariabilityAxis>;
  /**
   * Metabolite curves to overlay (handoff §12). Each is drawn as its own dashed
   * line sharing the parent's time grid (evaluated over the same `times` in
   * `buildCurve`, so they zip to `points` by index). Present only for an IV-bolus
   * parent that declares metabolites; model-agnostic (both 1- and 2-comp paths
   * populate identical {@link MetaboliteCurve}s).
   */
  metabolites?: MetaboliteCurve[];
  /** Parent compound display name — the legend label for the main line. */
  parentName: string;
  /** Right edge of the time axis, h. */
  horizonH: number;
  /** The model-predicted peak (Cmax at Tmax) of the main curve, marked on the plot. */
  peak: CurvePoint;
  /**
   * What the marked point MEANS, which is not the same on every route. On a
   * bolus/oral/infusion curve it is a true peak: the curve rises, turns over and
   * falls, so "Cmax at Tmax" is a fact about the drug. A continuously-worn patch
   * never turns over — it climbs monotonically toward `Css = R0/CL` — so its
   * marker is just the concentration reached when the wear period (and with it the
   * plot) ends. Calling that a Tmax would assert a peak that does not exist and
   * make 168 h look like a property of the drug rather than of the product.
   *
   * Deliberately NOT "plateau": that is true of clonidine (7 days is ~13
   * half-lives) but would be false for a future short-wear patch that comes off
   * still rising. "End of wear" holds for every zero-order-in/first-order-out
   * patch, because such a curve is monotone up to — and never past — the plateau.
   */
  peakKind?: 'peak' | 'end_of_wear';
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

/** One row of the datum the chart plots (t, main c, and — when present — the bands). */
interface ChartDatum {
  t: number;
  c: number | null;
  /**
   * Log-clamped band ranges the Areas draw, keyed `band_<axis>`; non-positive
   * bounds floored to the axis. One key per VISIBLE band.
   */
  [bandKey: `band_${string}`]: [number, number] | undefined;
  /** The true, unclamped band edges by axis — honest even where the Area floors. */
  bandRaw?: Partial<Record<VariabilityAxis, [number, number]>>;
  /** True (unclamped) metabolite concentrations by id, for the tooltip. */
  mRaw?: Record<string, number>;
  /**
   * Metabolite series columns, keyed `m_<id>`. Log-nulled like the main `c` so a
   * metabolite's C(0) = 0 (an oracle for every metabolite) breaks the line on the
   * semi-log axis instead of blanking or diving it. Template-literal index
   * signature so these dynamic keys don't loosen the typed fields above.
   */
  [metaboliteKey: `m_${string}`]: number | null;
}

/**
 * Tooltip content that reports the main concentration and, for each visible
 * variability band, its extremes labelled by what they MEAN (short vs long
 * half-life; large vs small volume) rather than a bare low/high. The labelling
 * carries real weight once there is more than one axis, because the two do not
 * point the same way: a LONG half-life raises concentration while a LARGE volume
 * lowers it, so "the top edge" is a different kind of extreme on each band.
 * Reads the raw edges so it is truthful even where the log axis floored the
 * shaded area. Survives no bands and a null main concentration (oral C(0) = 0 on
 * a log axis).
 */
function ConcTooltip(props: {
  active?: boolean;
  payload?: { payload: ChartDatum }[];
  concUnit: ConcentrationDisplayUnit;
  /** Metabolites to add rows for, with the colour of their line. */
  metabolites: { id: string; name: string; color: string }[];
  /** Parent display name for its concentration row (when metabolites are shown). */
  parentName: string;
  /** The bands being drawn, for their edge labels. */
  bands: VariabilityBand[];
}) {
  const { active, payload, concUnit, metabolites, parentName, bands } = props;
  if (!active || !payload || payload.length === 0) return null;
  // Recharts hands one payload entry per series, but they all share the same
  // `.payload` datum — read metabolite columns off it by known key, never by
  // iterating `payload` (which mixes parent and metabolite entries).
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const fmt = (v: number) => `${fmtNum(toDisplayConcentration(v, concUnit))} ${concUnit}`;
  const hasMetabolites = metabolites.length > 0;
  return (
    <div style={TOOLTIP_STYLE}>
      <div>t = {fmtNum(datum.t, 3)} h</div>
      <div>
        {hasMetabolites ? `${parentName}: ` : 'Concentration: '}
        {datum.c == null ? '—' : fmt(datum.c)}
      </div>
      {metabolites.map((m) => {
        const value = datum.mRaw?.[m.id];
        return (
          <div key={m.id} style={{ color: m.color }}>
            {m.name}: {value == null ? '—' : fmt(value)}
          </div>
        );
      })}
      {bands.map((band) => {
        const edges = datum.bandRaw?.[band.axis];
        if (!edges) return null;
        return (
          <div key={band.axis} style={{ color: '#9aa0a6', marginTop: 4 }}>
            <div style={{ color: BAND_STYLES[band.axis].color }}>
              varying {BAND_STYLES[band.axis].label}
            </div>
            <div>
              {band.lowLabel}: {fmt(edges[0])}
            </div>
            <div>
              {band.highLabel}: {fmt(edges[1])}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ConcentrationChart({
  points,
  bands,
  visibleBands = EMPTY_AXES,
  metabolites,
  parentName,
  horizonH,
  peak,
  peakKind = 'peak',
  concUnit,
  onConcUnitChange,
}: ConcentrationChartProps) {
  const [yScale, setYScale] = useState<YScale>('linear');
  const [showPeak, setShowPeak] = useState(true);
  // Per-metabolite line visibility. A pure display concern like `yScale`/`showPeak`,
  // so it lives in chart-local state rather than being lifted to App — nothing
  // outside the chart cares which lines are shown (the ProvenancePanel deliberately
  // stays independent: hiding a line declutters the plot, it does not filter data).
  // Keyed by metabolite id so stale ids from a previously-selected compound are
  // harmless (they never match a current id), which is why no reset-on-switch is
  // needed. Default empty ⇒ every metabolite visible.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const isLog = yScale === 'log';

  const metas = metabolites ?? [];
  // Pair each metabolite with a stable line colour (cycled) once, so the line,
  // legend, and tooltip all agree. Colour is assigned from the FULL-list index so a
  // metabolite's hue never shifts when an earlier one is toggled off.
  const metaSeries = metas.map((m, i) => ({
    ...m,
    color: METABOLITE_COLORS[i % METABOLITE_COLORS.length]!,
  }));
  // Only the visible metabolites drive the plot, the log axis, and the tooltip —
  // hiding the towering line (e.g. M3G) lets the remaining lines rescale to fill
  // the axis, which is the point of the toggle. The toolbar chips iterate the full
  // `metaSeries` so a hidden line can be brought back.
  const visibleSeries = metaSeries.filter((m) => !hiddenIds.has(m.id));
  const toggleMetabolite = (id: string) =>
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Only the bands the user has switched on are drawn — and, below, only they
  // widen the axis. A hidden band must not stretch the y-axis, or turning one off
  // would leave the plot mysteriously zoomed out around empty space.
  const shownBands = (bands ?? []).filter((b) => visibleBands.has(b.axis));

  // The log axis spans every VISIBLE plotted series — shown bands and metabolites
  // included, or a metabolite that accumulates above the parent (e.g. nordiazepam)
  // overflows.
  const positives = [
    ...points.map((p) => p.c),
    ...shownBands.flatMap((band) => band.points.flatMap((b) => [b.cLow, b.cHigh])),
    ...visibleSeries.flatMap((m) => m.points.map((p) => p.c)),
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
    const row: ChartDatum = {
      t: point.t,
      c: isLog && !(point.c > 0) ? null : point.c,
    };
    if (shownBands.length > 0) {
      const bandRaw: Partial<Record<VariabilityAxis, [number, number]>> = {};
      for (const band of shownBands) {
        // Bands share the parent grid (built over the same `times`), so index-align.
        const b = band.points[i];
        if (!b) continue;
        bandRaw[band.axis] = [b.cLow, b.cHigh];
        row[`band_${band.axis}`] = [clampLog(b.cLow), clampLog(b.cHigh)];
      }
      row.bandRaw = bandRaw;
    }
    if (visibleSeries.length > 0) {
      const mRaw: Record<string, number> = {};
      for (const m of visibleSeries) {
        // Metabolites share the parent grid (same `times`), so index-align — no
        // merge on `t`. C(0) = 0 (a metabolite oracle) is nulled on the log axis
        // exactly like the main line so semi-log breaks the line, not the axis.
        const raw = m.points[i]?.c ?? 0;
        mRaw[m.id] = raw;
        row[`m_${m.id}`] = isLog && !(raw > 0) ? null : raw;
      }
      row.mRaw = mRaw;
    }
    return row;
  });

  return (
    <div className="chart">
      <div className="chart__toolbar">
        {metaSeries.length > 0 && (
          <>
            <span className="chart__toolbar-label">metabolites</span>
            <div className="metab-toggles" role="group" aria-label="Metabolite lines">
              {metaSeries.map((m) => {
                const visible = !hiddenIds.has(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`metab-toggle${visible ? ' metab-toggle--active' : ''}`}
                    onClick={() => toggleMetabolite(m.id)}
                    aria-pressed={visible}
                    title={`${m.name} ${metaboliteTag(m.active)}`}
                  >
                    <span
                      className="metab-toggle__swatch"
                      style={{ borderTopColor: m.color, opacity: visible ? 1 : 0.4 }}
                    />
                    {m.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div className="toggle" role="group" aria-label="Peak marker">
          <button
            type="button"
            className={`toggle__btn${showPeak ? ' toggle__btn--active' : ''}`}
            onClick={() => setShowPeak((v) => !v)}
            aria-pressed={showPeak}
          >
            {peakKind === 'end_of_wear' ? 'End of wear' : 'Cmax / Tmax'}
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
            <Tooltip
              content={
                <ConcTooltip
                  concUnit={concUnit}
                  metabolites={visibleSeries}
                  parentName={parentName}
                  bands={shownBands}
                />
              }
            />
            {visibleSeries.length > 0 && (
              <Legend verticalAlign="top" height={28} iconType="plainline" />
            )}
            {/* Hatch fills, one per axis. Defined inside the chart's own SVG so
                the pattern ids resolve without a document-level <defs>. */}
            {shownBands.length > 0 && (
              <defs>
                {shownBands.map((band) => {
                  const { color, angle } = BAND_STYLES[band.axis];
                  return (
                    <pattern
                      key={band.axis}
                      id={`band-hatch-${band.axis}`}
                      patternUnits="userSpaceOnUse"
                      width={6}
                      height={6}
                      patternTransform={`rotate(${angle})`}
                    >
                      {/* A faint wash under the strokes so a band still reads as a
                          region at a glance, with the hatch doing the work of
                          telling two overlapping regions apart. */}
                      <rect width={6} height={6} fill={color} fillOpacity={0.1} />
                      <line x1={0} y1={0} x2={0} y2={6} stroke={color} strokeWidth={1.4} strokeOpacity={0.45} />
                    </pattern>
                  );
                })}
              </defs>
            )}
            {shownBands.map((band) => (
              <Area
                key={band.axis}
                type="monotone"
                dataKey={`band_${band.axis}`}
                stroke="none"
                fill={`url(#band-hatch-${band.axis})`}
                isAnimationActive={false}
                activeDot={false}
                tooltipType="none"
                legendType="none"
              />
            ))}
            <Line
              type="monotone"
              dataKey="c"
              name={parentName}
              stroke={PARENT_COLOR}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* Metabolites: computed (handoff §12), drawn dashed and hued to read
                as secondary; the legend names each so the dashing isn't the only
                signal. Rendered after the parent so the parent stays the headline. */}
            {visibleSeries.map((m) => (
              <Line
                key={m.id}
                type="monotone"
                dataKey={`m_${m.id}`}
                name={`${m.name} ${metaboliteTag(m.active)}`}
                stroke={m.color}
                strokeWidth={1.75}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
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
                  value={`${peakKind === 'end_of_wear' ? 'End of wear' : 'Cmax'} ${fmtNum(toDisplayConcentration(peak.c, concUnit))} ${concUnit} @ ${fmtNum(peak.t)} h`}
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
