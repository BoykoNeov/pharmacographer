/**
 * Application shell + state (handoff §13 Phase 4 — "get one real curve on screen").
 *
 * App is the only place the three layers meet: it loads validated compounds
 * (DATA), drives the pure curve math (ENGINE, via {@link buildCurve}), and
 * renders the controls and chart (UI). It owns all interactive state; the
 * components below are presentational.
 *
 * Honesty is kept proportional to the phase: a model caption ("which model /
 * which assumptions") and a warnings strip ship now because they are cheap and
 * core to the product (handoff §1, §3); the full ProvenancePanel and the
 * measured-vs-derived treatment are Phase 5.
 */

import { useMemo, useState } from 'react';
import type { DoseEvent, Route } from '../engine/types.ts';
import type { DeriveWarning } from '../data/derive.ts';
import { loadAllCompounds } from '../data/loader.ts';
import { CompoundPicker } from './components/CompoundPicker.tsx';
import { ConcentrationChart } from './components/ConcentrationChart.tsx';
import { DisclaimerBanner } from './components/DisclaimerBanner.tsx';
import { DosingScheduleEditor, type ScheduleMode } from './components/DosingScheduleEditor.tsx';
import { ModelAssumptionsNote } from './components/ModelAssumptionsNote.tsx';
import { ProvenancePanel } from './components/ProvenancePanel.tsx';
import { RouteDoseControls } from './components/RouteDoseControls.tsx';
import { VariabilitySlider } from './components/VariabilitySlider.tsx';
import {
  buildCurve,
  defaultRoute,
  fmtNum,
  halfLifeRangeH,
  REFERENCE_WEIGHT_KG,
  ROUTE_LABELS,
  routeOptions,
  type CurveResult,
  type DoseSchedule,
  DEFAULT_INFUSION_DURATION_H,
} from './curve.ts';

// Loaded once at module init. A malformed compound file throws here (loudly,
// naming the file) rather than rendering a half-formed app — the intended
// behaviour for a data bug (loader.ts).
const COMPOUNDS = loadAllCompounds();

export function App() {
  const [compoundId, setCompoundId] = useState(() => COMPOUNDS[0]?.id ?? '');
  const [route, setRoute] = useState<Route>(() => {
    const first = COMPOUNDS[0];
    return first ? defaultRoute(first) : 'iv_bolus';
  });
  const [dose, setDose] = useState(500);
  const [infusionDuration, setInfusionDuration] = useState(DEFAULT_INFUSION_DURATION_H);
  // Schedule shape (interval τ, dose count, ad-hoc extras). Unlike `route`, a
  // schedule is compound-independent, so it persists across compound switches.
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('single');
  // `dosingInterval`, not `interval`, to avoid shadowing the global timer.
  const [dosingInterval, setDosingInterval] = useState(6);
  const [count, setCount] = useState(4);
  const [adHoc, setAdHoc] = useState<DoseEvent[]>([]);
  // Half-life chosen within the reported band; undefined ⇒ the compound's
  // nominal. Compound-specific (its range differs), so reset on compound switch.
  const [halfLifeH, setHalfLifeH] = useState<number | undefined>(undefined);

  const compound = useMemo(() => COMPOUNDS.find((c) => c.id === compoundId), [compoundId]);
  const options = useMemo(() => (compound ? routeOptions(compound) : []), [compound]);
  const halfLifeRange = useMemo(() => (compound ? halfLifeRangeH(compound) : null), [compound]);

  // The dose amount is per-administration; the schedule repeats it. `count: 1`
  // in single mode makes single and recurring the same engine code path.
  const schedule = useMemo<DoseSchedule>(
    () => ({ amount: dose, count: scheduleMode === 'recurring' ? count : 1, interval: dosingInterval, adHoc }),
    [dose, scheduleMode, count, dosingInterval, adHoc],
  );

  // Switching compounds can invalidate the current route (e.g. oral-only →
  // iv-only). Reset to the new compound's default rather than store-then-validate.
  const handleCompoundChange = (id: string) => {
    setCompoundId(id);
    const next = COMPOUNDS.find((c) => c.id === id);
    if (next) setRoute(defaultRoute(next));
    setHalfLifeH(undefined); // back to the new compound's nominal half-life
  };

  // The derive → engine pipeline. `deriveParams` throws for a nonlinear compound
  // or an oral route with no absorption data; we catch and show the message
  // instead of crashing the chart.
  const curve = useMemo(() => {
    if (!compound) return { ok: false as const, error: 'No compound selected.' };
    try {
      return { ok: true as const, value: buildCurve({ compound, route, schedule, infusionDuration, halfLifeH }) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [compound, route, schedule, infusionDuration, halfLifeH]);

  return (
    <>
      <DisclaimerBanner />
      <div className="app">
        <header className="app__header">
          <h1>Pharmacographer</h1>
          <p className="app__tagline">
            An honest, interactive pharmacokinetics curve plotter — for learning, not for patients.
          </p>
        </header>

        <main className="layout">
          <section className="panel controls" aria-label="Controls">
            <CompoundPicker
              compounds={COMPOUNDS}
              selectedId={compoundId}
              onSelect={handleCompoundChange}
            />
            <RouteDoseControls
              routeOptions={options}
              route={route}
              onRouteChange={setRoute}
              dose={dose}
              onDoseChange={setDose}
              infusionDuration={infusionDuration}
              onInfusionDurationChange={setInfusionDuration}
            />
            <DosingScheduleEditor
              mode={scheduleMode}
              onModeChange={setScheduleMode}
              interval={dosingInterval}
              onIntervalChange={setDosingInterval}
              count={count}
              onCountChange={setCount}
              adHoc={adHoc}
              onAdHocChange={setAdHoc}
            />
            <VariabilitySlider
              range={halfLifeRange}
              valueH={halfLifeH ?? halfLifeRange?.nominal ?? 0}
              onChange={setHalfLifeH}
            />
          </section>

          <section className="panel chart-area" aria-label="Concentration curve">
            {curve.ok ? (
              <>
                <ConcentrationChart
                  points={curve.value.points}
                  band={curve.value.band}
                  horizonH={curve.value.horizonH}
                  peak={curve.value.peak}
                />
                <ModelCaption
                  route={route}
                  schedule={schedule}
                  infusionDuration={infusionDuration}
                  curve={curve.value}
                />
                <PeakNote route={route} schedule={schedule} />
                <WarningsStrip warnings={curve.value.warnings} />
              </>
            ) : (
              <div className="chart-error" role="alert">
                <strong>No curve.</strong> {curve.error}
              </div>
            )}
          </section>

          {curve.ok && compound && (
            <aside className="honesty" aria-label="Provenance and assumptions">
              <ProvenancePanel compound={compound} route={route} derived={curve.value.derived} />
              <ModelAssumptionsNote />
            </aside>
          )}
        </main>
      </div>
    </>
  );
}

interface ModelCaptionProps {
  route: Route;
  schedule: DoseSchedule;
  infusionDuration: number;
  curve: CurveResult;
}

/** Describe the dosing schedule in words for the caption. */
function describeSchedule(schedule: DoseSchedule, route: Route): string {
  const routeWord = ROUTE_LABELS[route].toLowerCase();
  const base =
    schedule.count <= 1
      ? `single ${fmtNum(schedule.amount)} mg ${routeWord} dose`
      : `${schedule.count} × ${fmtNum(schedule.amount)} mg ${routeWord} doses every ${fmtNum(schedule.interval)} h`;
  if (schedule.adHoc.length === 0) return base;
  const extras = schedule.adHoc.length === 1 ? '1 extra dose' : `${schedule.adHoc.length} extra doses`;
  return `${base} + ${extras}`;
}

/** "Show the model, not just the curve" (handoff §1) — a one-line summary. */
function ModelCaption({ route, schedule, infusionDuration, curve }: ModelCaptionProps) {
  const { params, halfLifeH, peak } = curve;
  const parts = [
    'One-compartment model',
    describeSchedule(schedule, route),
    `ke = ${fmtNum(params.ke)} /h (t½ ${fmtNum(halfLifeH)} h)`,
  ];
  if (route === 'oral' && params.ka !== undefined) {
    parts.push(`ka = ${fmtNum(params.ka)} /h`);
  }
  if (route === 'iv_infusion') {
    parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  }
  parts.push(`Cmax ${fmtNum(peak.c)} mg/L at Tmax ${fmtNum(peak.t)} h`);
  parts.push(`${REFERENCE_WEIGHT_KG} kg illustrative reference subject`);
  return <p className="caption">{parts.join(' · ')}</p>;
}

/**
 * What the marked Cmax/Tmax means — the standing concept + honesty caveat, kept
 * distinct from the dynamic values in the caption (which restate the numbers).
 * The peak means something different per route, so the phrasing is route-aware;
 * a recurring course marks the whole-course peak, NOT a steady-state value.
 */
function PeakNote({ route, schedule }: { route: Route; schedule: DoseSchedule }) {
  const totalDoses = schedule.count + schedule.adHoc.length;
  const routeMeaning =
    route === 'iv_bolus'
      ? 'An IV bolus peaks the instant it is given (Tmax = 0), at Cmax = dose / Vd, then only falls.'
      : route === 'iv_infusion'
        ? 'A constant infusion peaks at the end of the infusion, then falls.'
        : 'An oral dose rises as it is absorbed and falls as it is eliminated; the peak (Tmax) is where those balance.';
  const scheduleCaveat =
    totalDoses > 1
      ? ' With repeated doses the marker is the highest point of the whole plotted course (the last-dose accumulation peak) — not a steady-state value; the course may not have reached steady state.'
      : '';
  return (
    <p className="caption">
      <strong>Cmax / Tmax</strong> — the peak concentration the model predicts and the time it occurs.{' '}
      {routeMeaning}
      {scheduleCaveat} This is model-predicted for the {REFERENCE_WEIGHT_KG} kg illustrative subject and scales with
      the dose you chose — it is not a measured Cmax from any study.
    </p>
  );
}

/** Cautions from the derivation layer (assumed F, inferred route, …). */
function WarningsStrip({ warnings }: { warnings: DeriveWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="warnings" aria-label="Modelling cautions">
      {warnings.map((warning, index) => (
        <li key={`${warning.parameter}-${index}`} className="warnings__item">
          {warning.message}
        </li>
      ))}
    </ul>
  );
}
