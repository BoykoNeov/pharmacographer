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
import type { DoseEvent } from '../engine/types.ts';
import {
  applyPhenotype,
  defaultPhenotypeId,
  engineRouteOf,
  type DeriveWarning,
} from '../data/derive.ts';
import type { DataRoute } from '../data/schema.ts';
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
  fmtPercent,
  halfLifeRangeH,
  REFERENCE_WEIGHT_KG,
  ROUTE_LABELS,
  routeOptions,
  toDisplayConcentration,
  type ConcentrationDisplayUnit,
  type CurveResult,
  type DoseSchedule,
  type HalfLifeAxisRegime,
  type VariabilityAxis,
  DEFAULT_DOSE_MG,
  DEFAULT_INFUSION_DURATION_H,
} from './curve.ts';

// Loaded once at module init. A malformed compound file throws here (loudly,
// naming the file) rather than rendering a half-formed app — the intended
// behaviour for a data bug (loader.ts).
const COMPOUNDS = loadAllCompounds();

export function App() {
  const [compoundId, setCompoundId] = useState(() => COMPOUNDS[0]?.id ?? '');
  const [route, setRoute] = useState<DataRoute>(() => {
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
  // Vd chosen within its reported range; undefined ⇒ the compound's derived
  // nominal. Same compound-specific reset rule as the half-life above.
  const [vdL, setVdL] = useState<number | undefined>(undefined);
  // Oral bioavailability chosen within its reported range; undefined ⇒ the
  // compound's derived nominal. Resets on a compound switch like the two above.
  // Deliberately NOT reset when the route changes: unlike a compound switch, an
  // oral → IV → oral round trip never changes the range this value lives in, so
  // there is no stale-value hazard to guard against, and dropping the selection
  // would be gratuitous (`halfLifeH` and `dose` survive a route change for the
  // same reason). `buildCurve` ignores it on any non-oral route regardless.
  const [oralF, setOralF] = useState<number | undefined>(undefined);
  // Which variability bands are shaded. Half-life alone by default, so the
  // opening view still shows exactly the one envelope it always did — the same
  // identity-at-default discipline the phenotype presets use (`presets[0]`
  // overrides nothing), and what makes the curve.test.ts identity anchor
  // meaningful. (The band's FILL did change: it is hatched now rather than a flat
  // wash, so that a second band overlapping it stays traceable. Same data, same
  // geometry, deliberately different shading.)
  const [visibleBands, setVisibleBands] = useState<ReadonlySet<VariabilityAxis>>(
    () => new Set<VariabilityAxis>(['half_life']),
  );
  const setBandVisible = (axis: VariabilityAxis, visible: boolean) =>
    setVisibleBands((prev) => {
      const next = new Set(prev);
      if (visible) next.add(axis);
      else next.delete(axis);
      return next;
    });
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
    setVdL(undefined); // …and its nominal Vd: an absolute litre value carried over
    // from another compound is meaningless, and would usually sit outside the new
    // compound's range entirely (lithium ~50 L vs digoxin ~500 L).
    setOralF(undefined); // …and its nominal F, on the same reasoning: morphine's
    // 22–36% and glipizide's 95–100% do not overlap at all.
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
    // Vd resets too, on the same reasoning. A preset that leaves Vd alone (the
    // usual case — acetylator status does not change a volume, which is why
    // procainamide's presets override neither) makes this a no-op, but a preset
    // that DID re-anchor Vd would otherwise strand the slider on the previous
    // population's litres: the mixed state presets exist to forbid.
    setVdL(undefined);
    // F resets too. No shipped preset re-anchors a bioavailability, but the rule
    // is about what a preset MAY do, not what today's data happens to do — a
    // future first-pass-metaboliser preset (CYP3A4, say) would move F, and the
    // mixed state would be this population's F against that one's half-life.
    setOralF(undefined);
  };

  // The derive → engine pipeline. `deriveParams` throws for a nonlinear compound
  // or an oral route with no absorption data; we catch and show the message
  // instead of crashing the chart.
  const curve = useMemo(() => {
    if (!compound) return { ok: false as const, error: 'No compound selected.' };
    try {
      return {
        ok: true as const,
        value: buildCurve({
          compound,
          route,
          schedule,
          infusionDuration,
          halfLifeH,
          vdL,
          F: oralF,
        }),
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [compound, route, schedule, infusionDuration, halfLifeH, vdL, oralF]);

  // The Vd range comes off the built curve rather than the compound file, because
  // its nominal must be the DERIVED Vd (per-kg values scaled against the
  // illustrative reference subject) — the same number the engine actually used.
  // Reading the raw file here would put the slider on a different scale from the
  // curve for every compound reporting L/kg, which is most of them.
  const vdRange =
    curve.ok && curve.value.model === 'one_compartment_first_order'
      ? (curve.value.vdRange ?? null)
      : null;
  // Likewise F: read off the built curve, which is also what makes the slider
  // disappear on an IV or transdermal curve without App having to re-derive the
  // route rule — `buildCurve` returns no `fRange` there because there is no F to
  // vary, not because the source is silent.
  const fRange =
    curve.ok && curve.value.model === 'one_compartment_first_order'
      ? (curve.value.fRange ?? null)
      : null;
  // Likewise the half-life slider's NOTE: whether that slider tilts the tail or
  // moves the height is a fact about ka vs ke on the plotted route, so it is read
  // off the same built curve rather than re-derived here.
  const halfLifeRegime =
    curve.ok && curve.value.model === 'one_compartment_first_order'
      ? curve.value.halfLifeAxisRegime
      : 'elimination_limited';

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
              halfLifeRegime={halfLifeRegime}
              vdRange={vdRange}
              vdValueL={vdL ?? vdRange?.nominal}
              onVdChange={setVdL}
              fRange={fRange}
              fValue={oralF ?? fRange?.nominal}
              onFChange={setOralF}
              visibleBands={visibleBands}
              onVisibleBandsChange={setBandVisible}
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
                  bands={curve.value.bands}
                  visibleBands={visibleBands}
                  metabolites={curve.value.metabolites}
                  parentName={compound?.names.inn ?? 'Parent'}
                  horizonH={curve.value.horizonH}
                  peak={curve.value.peak}
                  peakKind={route === 'transdermal' ? 'end_of_wear' : 'peak'}
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
                <PeakNote route={route} schedule={schedule} halfLifeRegime={halfLifeRegime} />
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
  route: DataRoute;
  schedule: DoseSchedule;
  infusionDuration: number;
  curve: CurveResult;
  concUnit: ConcentrationDisplayUnit;
}

/** Describe the dosing schedule in words for the caption. */
function describeSchedule(schedule: DoseSchedule, route: DataRoute): string {
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
    if (engineRouteOf(route) === 'oral' && curve.params.ka !== undefined) {
      parts.push(`ka = ${fmtNum(curve.params.ka)} /h`);
    }
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  } else {
    parts.push('One-compartment model');
    parts.push(describeSchedule(schedule, route));
    parts.push(`ke = ${fmtNum(curve.params.ke)} /h (t½ ${fmtNum(curve.halfLifeH)} h)`);
    // Vd is stated here because it is now a slider, not a constant: without it the
    // caption would describe a curve the reader can no longer identify — two
    // different volumes give the same ke and t½ but a chart twice the height.
    parts.push(`Vd = ${fmtNum(curve.params.vd)} L`);
    if (engineRouteOf(route) === 'oral' && curve.params.ka !== undefined) {
      parts.push(`ka = ${fmtNum(curve.params.ka)} /h`);
    }
    // F is stated for the same reason Vd is — it became a slider. It matters more
    // here than Vd did, because F and Vd move the curve identically: with only one
    // of the pair on screen the caption would describe a curve whose height the
    // reader cannot account for.
    if (engineRouteOf(route) === 'oral' && curve.params.F !== undefined) {
      parts.push(`F = ${fmtPercent(curve.params.F)}`);
    }
    if (route === 'iv_infusion') parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  }
  parts.push(
    route === 'transdermal'
      ? // A worn patch never turns over, so it has no Tmax: this is where the wear
        // period ends, not where the curve peaked. See PeakNote.
        `${fmtNum(toDisplayConcentration(peak.c, concUnit))} ${concUnit} at end of wear (${fmtNum(peak.t)} h)`
      : `Cmax ${fmtNum(toDisplayConcentration(peak.c, concUnit))} ${concUnit} at Tmax ${fmtNum(peak.t)} h`,
  );
  parts.push(`${REFERENCE_WEIGHT_KG} kg illustrative reference subject`);
  return <p className="caption">{parts.join(' · ')}</p>;
}

/**
 * What the marked Cmax/Tmax means — the standing concept + honesty caveat, kept
 * distinct from the dynamic values in the caption (which restate the numbers).
 * The peak means something different per route, so the phrasing is route-aware;
 * a recurring course marks the whole-course peak, NOT a steady-state value.
 *
 * The oral clause is ALSO regime-aware, which the first pass at the flip-flop fix
 * missed: "falls as it is eliminated" names elimination as the cause of the
 * falling limb, and under flip-flop the limb falls at ka instead. Fixing the
 * slider's note and leaving this one would have left the misattribution on screen
 * in a second place, directly under the chart, on the very compound that exists
 * to teach that a terminal slope is not automatically elimination. The
 * rate-limiting-step screen in `docs/DATA_GUIDE.md` is written to catch exactly
 * this — every sentence naming a parameter as the CAUSE of a visible feature —
 * and it has to be run against each such sentence, not against the component.
 */
export function PeakNote({
  route,
  schedule,
  halfLifeRegime = 'elimination_limited',
}: {
  route: DataRoute;
  schedule: DoseSchedule;
  halfLifeRegime?: HalfLifeAxisRegime;
}) {
  const totalDoses = schedule.count + schedule.adHoc.length;
  const routeMeaning =
    route === 'iv_bolus'
      ? 'An IV bolus peaks the instant it is given (Tmax = 0), at Cmax = dose / Vd, then only falls.'
      : route === 'iv_infusion'
        ? 'A constant infusion peaks at the end of the infusion, then falls.'
        : route === 'transdermal'
          ? // Deliberately NOT the Cmax/Tmax language: a worn patch has no peak to
            // name. Phrased for every patch, not just one that reached its plateau.
            'A patch worn continuously has no peak at all: it climbs steadily toward a plateau at Css = R0/CL — set by clearance alone, not by Vd — and never turns over, because nothing is ever taken off. The marker is simply the concentration reached when the wear period ends, so its time is a property of the product, not of the drug.'
        : route === 'im'
          ? // An IM depot is first-order in, exactly like a tablet, so the peak means
            // the same THING — but the oral sentence names the gut and, more
            // importantly, an oral F is net of first-pass extraction while an IM F is
            // not. Letting `im` fall through to the oral branch would have been the
            // patch-explained-as-a-tablet bug again, one route later, and neither the
            // typechecker nor a test would have said a word.
            'An intramuscular dose rises as it is absorbed from the muscle depot and falls as it is eliminated; the peak (Tmax) is where those balance. The shape is a tablet’s, but the fraction is not: an injection drains straight to the systemic circulation, so its F is absorption completeness only — it carries no first-pass loss through gut wall and liver, which is why the same drug can reach far higher concentrations by needle than by mouth at the same dose.'
          : // The peak is where the two rates balance whichever one is slower, so
            // that clause holds in both regimes; what does NOT hold in both is
            // naming elimination as the cause of the fall.
            halfLifeRegime === 'elimination_limited'
            ? 'An oral dose rises as it is absorbed and falls as it is eliminated; the peak (Tmax) is where those balance.'
            : 'An oral dose rises as it is absorbed and falls once elimination outpaces what is still arriving; the peak (Tmax) is where those balance. Here absorption is the slower step, so what the curve falls at after the peak is the ABSORPTION rate — the drug is eliminated as fast as it gets in, and the tail measures how slowly it arrives, not how quickly it leaves.';
  const scheduleCaveat =
    totalDoses > 1
      ? ' With repeated doses the marker is the highest point of the whole plotted course (the last-dose accumulation peak) — not a steady-state value; the course may not have reached steady state.'
      : '';
  const heading = route === 'transdermal' ? 'End of wear' : 'Cmax / Tmax';
  const opener =
    route === 'transdermal'
      ? 'the concentration the model predicts the patch reaches by the time it comes off.'
      : 'the peak concentration the model predicts and the time it occurs.';
  return (
    <p className="caption">
      <strong>{heading}</strong> — {opener} {routeMeaning}
      {scheduleCaveat} This is model-predicted for the {REFERENCE_WEIGHT_KG} kg illustrative subject
      and scales with the dose you chose — it is not a measured{' '}
      {route === 'transdermal' ? 'concentration' : 'Cmax'} from any study.
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
