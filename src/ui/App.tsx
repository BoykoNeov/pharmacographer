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
import { applyPhenotype, defaultPhenotypeId, type DeriveWarning } from '../data/derive.ts';
import { loadAllCompounds } from '../data/loader.ts';
import { CompoundAbout, CompoundMetabolism } from './components/CompoundInfo.tsx';
import { CompoundPicker } from './components/CompoundPicker.tsx';
import { ConcentrationChart } from './components/ConcentrationChart.tsx';
import { DisclaimerBanner } from './components/DisclaimerBanner.tsx';
import { DosingScheduleEditor, type ScheduleMode } from './components/DosingScheduleEditor.tsx';
import { ModelAssumptionsNote } from './components/ModelAssumptionsNote.tsx';
import { PhenotypePicker } from './components/PhenotypePicker.tsx';
import { ProvenancePanel } from './components/ProvenancePanel.tsx';
import { RouteDoseControls } from './components/RouteDoseControls.tsx';
import { VariabilitySlider, type NoRangeReason } from './components/VariabilitySlider.tsx';
import {
  buildCurve,
  defaultRoute,
  fmtNum,
  halfLifeRangeH,
  REFERENCE_WEIGHT_KG,
  ROUTE_LABELS,
  routeOptions,
  toDisplayConcentration,
  type ConcentrationDisplayUnit,
  type CurveResult,
  type DoseSchedule,
  DEFAULT_DOSE_MG,
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
  const [dose, setDose] = useState(() => COMPOUNDS[0]?.illustrativeDoseMg ?? DEFAULT_DOSE_MG);
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
  // Concentration display unit. Owned here (not in the chart) because the model
  // caption also prints a Cmax — the two must never disagree on screen. The curve
  // math stays in canonical mg/L; this only changes how values are shown.
  const [concUnit, setConcUnit] = useState<ConcentrationDisplayUnit>('mg/L');
  // Which illustrative population is on screen (§12). Compound-specific, so it
  // resets on a compound switch. `undefined` ⇒ the compound's default preset.
  const [phenotypeId, setPhenotypeId] = useState<string | undefined>(() =>
    COMPOUNDS[0] ? defaultPhenotypeId(COMPOUNDS[0]) : undefined,
  );

  const selected = useMemo(() => COMPOUNDS.find((c) => c.id === compoundId), [compoundId]);
  // The compound EVERYTHING below works from: the selected file re-anchored onto
  // the chosen population. Doing this once, here, is what keeps phenotypes out of
  // the layers underneath — derive and the engine just see numbers, and the
  // provenance rows/prose automatically cite the active population's sources
  // rather than needing a parallel "but which phenotype" channel. For the default
  // preset this IS the selected compound (same object), so nothing moves.
  const compound = useMemo(
    () => (selected ? applyPhenotype(selected, phenotypeId) : undefined),
    [selected, phenotypeId],
  );
  const options = useMemo(() => (compound ? routeOptions(compound) : []), [compound]);
  // The variability band/slider vary a single half-life — a one-compartment
  // feature. A two-compartment compound has two eigenvalues, so there is no single
  // half-life to slide; the slider shows its "no range" note instead (handoff §12).
  const halfLifeRange = useMemo(
    () =>
      compound && compound.model === 'one_compartment_first_order'
        ? halfLifeRangeH(compound)
        : null,
    [compound],
  );
  // When there is no slider, WHY there isn't is itself a teaching point, and the
  // three reasons are not interchangeable — a saturable drug has no half-life at
  // all, which is a different statement from a source that simply reported no
  // range (handoff §12).
  const noRangeReason: NoRangeReason = useMemo(() => {
    if (compound?.model === 'one_compartment_michaelis_menten') return 'nonlinear';
    if (compound && compound.model !== 'one_compartment_first_order') return 'multi_compartment';
    return 'no_reported_range';
  }, [compound]);

  // The dose amount is per-administration; the schedule repeats it. `count: 1`
  // in single mode makes single and recurring the same engine code path.
  const schedule = useMemo<DoseSchedule>(
    () => ({
      amount: dose,
      count: scheduleMode === 'recurring' ? count : 1,
      interval: dosingInterval,
      adHoc,
    }),
    [dose, scheduleMode, count, dosingInterval, adHoc],
  );

  // Switching compounds can invalidate the current route (e.g. oral-only →
  // iv-only). Reset to the new compound's default rather than store-then-validate.
  const handleCompoundChange = (id: string) => {
    setCompoundId(id);
    const next = COMPOUNDS.find((c) => c.id === id);
    if (next) setRoute(defaultRoute(next));
    setHalfLifeH(undefined); // back to the new compound's nominal half-life
    setPhenotypeId(next ? defaultPhenotypeId(next) : undefined);
    // Only a compound that declares its own scale overrides the dose in the box.
    // Otherwise the typed dose is left alone: resetting every switch would throw
    // away the user's number for the 43 compounds where 500 mg is a fair opening
    // (docs: `illustrativeDoseMg`).
    if (next?.illustrativeDoseMg !== undefined) setDose(next.illustrativeDoseMg);
  };

  // Switching population MUST drop the slider back to that population's nominal.
  // Each phenotype's band is deliberately kept inside its own phenotype, so a
  // half-life carried over from the previous one can land outside the new band
  // entirely (procainamide: a fast 1.8 h is nowhere in the slow 2.6–4.6 h band) —
  // and, worse, would pair one population's half-life with the other's fm. That
  // mixed state is the exact thing presets exist to make unreachable; keeping the
  // old value here would quietly rebuild it in the UI after the data layer went
  // to some trouble to forbid it.
  const handlePhenotypeChange = (id: string) => {
    setPhenotypeId(id);
    setHalfLifeH(undefined);
  };

  // The derive → engine pipeline. `deriveParams` throws for a nonlinear compound
  // or an oral route with no absorption data; we catch and show the message
  // instead of crashing the chart.
  const curve = useMemo(() => {
    if (!compound) return { ok: false as const, error: 'No compound selected.' };
    try {
      return {
        ok: true as const,
        value: buildCurve({ compound, route, schedule, infusionDuration, halfLifeH }),
      };
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
            {/* Directly above the slider on purpose: the two controls compose as
                two levels of the same idea — the preset picks WHICH population,
                the slider the spread WITHIN it. Selecting a preset re-anchors the
                slider's whole band (halfLifeRange reads the re-anchored compound). */}
            {selected && (
              <PhenotypePicker
                compound={selected}
                selectedId={phenotypeId}
                onSelect={handlePhenotypeChange}
              />
            )}
            <VariabilitySlider
              range={halfLifeRange}
              valueH={halfLifeH ?? halfLifeRange?.nominal ?? 0}
              onChange={setHalfLifeH}
              noRangeReason={noRangeReason}
            />
          </section>

          <section className="panel chart-area" aria-label="Concentration curve">
            {/* Fixed-height "what is this compound" box ABOVE the chart — its
                constant height keeps the chart's top edge from jumping when the
                compound changes. */}
            {compound && <CompoundAbout compound={compound} />}
            {curve.ok ? (
              <>
                <ConcentrationChart
                  points={curve.value.points}
                  band={curve.value.band}
                  metabolites={curve.value.metabolites}
                  parentName={compound?.names.inn ?? 'Parent'}
                  horizonH={curve.value.horizonH}
                  peak={curve.value.peak}
                  concUnit={concUnit}
                  onConcUnitChange={setConcUnit}
                />
                <ModelCaption
                  route={route}
                  schedule={schedule}
                  infusionDuration={infusionDuration}
                  curve={curve.value}
                  concUnit={concUnit}
                />
                {/* No hardcoded lead-in: `displayNote` started as a units caveat
                    (lithium's mEq/L) and the label said "Units.", but it is now
                    the general "caveat the viewer must see" slot — three of the
                    five notes are about a compound having no fixed half-life at
                    all. Labelling those "Units." states something false in the
                    one panel whose whole job is not to. Each note names its own
                    subject in its first clause. */}
                {compound?.displayNote && (
                  <p className="caption caption--emphasis">{compound.displayNote}</p>
                )}
                <PeakNote route={route} schedule={schedule} />
                {/* Metabolite derivation cautions are folded in alongside the
                    parent's — currently dormant (diazepam's fm is in range) but
                    honest plumbing so a metabolite warning is never dropped. */}
                <WarningsStrip
                  warnings={[
                    ...curve.value.warnings,
                    ...(curve.value.metabolites?.flatMap((m) => m.warnings) ?? []),
                  ]}
                />
              </>
            ) : (
              <div className="chart-error" role="alert">
                <strong>No curve.</strong> {curve.error}
              </div>
            )}
            {/* Metabolism prose renders BELOW the chart, where its unbounded
                length can't push the chart around. Route-independent descriptive
                text, so it shows regardless of whether a curve was built. */}
            {compound && <CompoundMetabolism compound={compound} />}
          </section>

          {curve.ok && compound && (
            <aside className="honesty" aria-label="Provenance and assumptions">
              <ProvenancePanel
                compound={compound}
                route={route}
                derived={curve.value.derived}
                metabolites={curve.value.metabolites}
              />
              <ModelAssumptionsNote model={compound.model} />
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
  concUnit: ConcentrationDisplayUnit;
}

/** Describe the dosing schedule in words for the caption. */
function describeSchedule(schedule: DoseSchedule, route: Route): string {
  const routeWord = ROUTE_LABELS[route].toLowerCase();
  const base =
    schedule.count <= 1
      ? `single ${fmtNum(schedule.amount)} mg ${routeWord} dose`
      : `${schedule.count} × ${fmtNum(schedule.amount)} mg ${routeWord} doses every ${fmtNum(schedule.interval)} h`;
  if (schedule.adHoc.length === 0) return base;
  const extras =
    schedule.adHoc.length === 1 ? '1 extra dose' : `${schedule.adHoc.length} extra doses`;
  return `${base} + ${extras}`;
}

/** "Show the model, not just the curve" (handoff §1) — a one-line summary. */
function ModelCaption({ route, schedule, infusionDuration, curve, concUnit }: ModelCaptionProps) {
  const { peak } = curve;
  const parts: string[] = [];
  if (curve.model === 'two_compartment_first_order') {
    parts.push('Two-compartment model');
    parts.push(describeSchedule(schedule, route));
    parts.push(
      `distribution t½ ${fmtNum(curve.distributionHalfLifeH)} h · terminal t½ ${fmtNum(curve.terminalHalfLifeH)} h`,
    );
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  } else if (curve.model === 'three_compartment_first_order') {
    parts.push('Three-compartment model');
    parts.push(describeSchedule(schedule, route));
    parts.push(
      `distribution t½ ${fmtNum(curve.distributionHalfLifeH)} h · intermediate t½ ${fmtNum(curve.intermediateHalfLifeH)} h · terminal t½ ${fmtNum(curve.terminalHalfLifeH)} h`,
    );
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  } else if (curve.model === 'one_compartment_michaelis_menten') {
    // The nonlinear caption states a RANGE where the others state a half-life —
    // for a saturable drug a single number would be the category error the
    // compound exists to expose. The two ends are this curve's own peak and the
    // dilute limit, so the caption changes when the dose changes: that movement
    // IS the lesson (handoff §12).
    parts.push('One-compartment model, saturable elimination');
    parts.push(describeSchedule(schedule, route));
    parts.push(
      `Vmax = ${fmtNum(curve.params.vmax)} mg/h · Km = ${fmtNum(toDisplayConcentration(curve.params.km, concUnit))} ${concUnit}`,
    );
    parts.push(
      `apparent t½ ${fmtNum(curve.limitHalfLifeH)}→${fmtNum(curve.apparentHalfLifeAtPeakH)} h (rises with concentration — no single half-life)`,
    );
    if (route === 'oral' && curve.params.ka !== undefined) {
      parts.push(`ka = ${fmtNum(curve.params.ka)} /h`);
    }
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  } else {
    parts.push('One-compartment model');
    parts.push(describeSchedule(schedule, route));
    parts.push(`ke = ${fmtNum(curve.params.ke)} /h (t½ ${fmtNum(curve.halfLifeH)} h)`);
    if (route === 'oral' && curve.params.ka !== undefined) {
      parts.push(`ka = ${fmtNum(curve.params.ka)} /h`);
    }
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  }
  parts.push(
    `Cmax ${fmtNum(toDisplayConcentration(peak.c, concUnit))} ${concUnit} at Tmax ${fmtNum(peak.t)} h`,
  );
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
      <strong>Cmax / Tmax</strong> — the peak concentration the model predicts and the time it
      occurs. {routeMeaning}
      {scheduleCaveat} This is model-predicted for the {REFERENCE_WEIGHT_KG} kg illustrative subject
      and scales with the dose you chose — it is not a measured Cmax from any study.
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
