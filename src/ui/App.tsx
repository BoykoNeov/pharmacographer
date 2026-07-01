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
import type { Route } from '../engine/types.ts';
import type { DeriveWarning } from '../data/derive.ts';
import { loadAllCompounds } from '../data/loader.ts';
import { CompoundPicker } from './components/CompoundPicker.tsx';
import { ConcentrationChart } from './components/ConcentrationChart.tsx';
import { DisclaimerBanner } from './components/DisclaimerBanner.tsx';
import { ModelAssumptionsNote } from './components/ModelAssumptionsNote.tsx';
import { ProvenancePanel } from './components/ProvenancePanel.tsx';
import { RouteDoseControls } from './components/RouteDoseControls.tsx';
import {
  buildCurve,
  defaultRoute,
  fmtNum,
  REFERENCE_WEIGHT_KG,
  ROUTE_LABELS,
  routeOptions,
  type CurveResult,
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

  const compound = useMemo(() => COMPOUNDS.find((c) => c.id === compoundId), [compoundId]);
  const options = useMemo(() => (compound ? routeOptions(compound) : []), [compound]);

  // Switching compounds can invalidate the current route (e.g. oral-only →
  // iv-only). Reset to the new compound's default rather than store-then-validate.
  const handleCompoundChange = (id: string) => {
    setCompoundId(id);
    const next = COMPOUNDS.find((c) => c.id === id);
    if (next) setRoute(defaultRoute(next));
  };

  // The derive → engine pipeline. `deriveParams` throws for a nonlinear compound
  // or an oral route with no absorption data; we catch and show the message
  // instead of crashing the chart.
  const curve = useMemo(() => {
    if (!compound) return { ok: false as const, error: 'No compound selected.' };
    try {
      return { ok: true as const, value: buildCurve({ compound, route, dose, infusionDuration }) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, [compound, route, dose, infusionDuration]);

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
          </section>

          <section className="panel chart-area" aria-label="Concentration curve">
            {curve.ok ? (
              <>
                <ConcentrationChart points={curve.value.points} horizonH={curve.value.horizonH} />
                <ModelCaption
                  route={route}
                  dose={dose}
                  infusionDuration={infusionDuration}
                  curve={curve.value}
                />
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
  dose: number;
  infusionDuration: number;
  curve: CurveResult;
}

/** "Show the model, not just the curve" (handoff §1) — a one-line summary. */
function ModelCaption({ route, dose, infusionDuration, curve }: ModelCaptionProps) {
  const { params, halfLifeH } = curve;
  const parts = [
    'One-compartment model',
    `single ${fmtNum(dose)} mg ${ROUTE_LABELS[route].toLowerCase()} dose`,
    `ke = ${fmtNum(params.ke)} /h (t½ ${fmtNum(halfLifeH)} h)`,
  ];
  if (route === 'oral' && params.ka !== undefined) {
    parts.push(`ka = ${fmtNum(params.ka)} /h`);
  }
  if (route === 'iv_infusion') {
    parts.push(`infused over ${fmtNum(infusionDuration)} h`);
  }
  parts.push(`${REFERENCE_WEIGHT_KG} kg illustrative reference subject`);
  return <p className="caption">{parts.join(' · ')}</p>;
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
