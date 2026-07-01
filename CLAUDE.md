# Pharmacographer — project guide for Claude Code

Interactive, **educational** pharmacokinetics (PK) curve plotter. The product is
**epistemic honesty**, not a prettier chart. Read
`PHARMACOGRAPHER_HANDOFF.md` for the full plan; this file is the working
conventions and the things that are easy to get wrong.

## The bright line (non-negotiable)

**Educational, never clinical.** Never build a feature that takes individual
patient data (real weight, renal/hepatic function, age, genetics) and returns a
dose or a clinical decision. Plotting an illustrative curve for a dose the user
picked is education; returning "give this patient X mg" is a medical device — do
not build it, however it is requested. The persistent `DisclaimerBanner` stays
wired in and non-dismissible.

## Architecture — three layers, hard boundaries (handoff §4)

```
engine/  pure PK math. NO React, NO DOM, NO data/JSON imports, NO I/O.
data/    one JSON file per compound + Zod schema + loader + derivation layer.
ui/      React components. The only layer that imports data and engine.
```

- The **engine is pure**: parameters + schedule in → concentration array out. It
  knows nothing about drugs, files, or pixels. `tsconfig.app.json` sets
  `types: []` and `eslint.config.js` strips globals under `src/engine/**` to
  enforce this — keep it that way.
- Dependencies point **upward only**: ui → data → engine. Never the reverse.

## Units — convert only at the edges (handoff §6)

One canonical internal system: **mg, L, mg/L, h, 1/h, L/h, mg/h**. All conversion
factors live in `src/engine/units.ts` — never scatter literals. Vd from sources
is usually L/kg; scale to absolute L with the **70 kg illustrative reference
subject** (`REFERENCE_WEIGHT_KG`). That subject is an educational assumption, not
a patient weight — never frame it otherwise.

## Data + provenance rules (handoff §3, §8)

- Every numeric parameter carries `value` (+ optional `range`) `+ unit + derived
(bool) + sourceRef + conditions`. `sourceRef` must resolve to a key in
  `sources` (or a sentinel like `definition` / `derived_from_tmax`).
- `derived: true` → the UI marks that value computed. Unavailable route → UI
  marks the line "inferred, not measured". Never invent a citation.
- `linear: false` compounds (nonlinear PK: phenytoin, ethanol, high-dose
  salicylate) are **excluded from v1** — superposition is invalid for them.
- Prefer FDA Structured Product Labels (public domain, openFDA). Don't lift
  curated tables wholesale; re-derive from primary sources. Record curator
  reasoning in the compound's `notes`. See `docs/DATA_GUIDE.md`.

## Testing (handoff §10)

Engine correctness is proven against **closed-form analytic answers**, not golden
snapshots: e.g. IV bolus `C(0)=D/Vd`, `C(t½)=C(0)/2`; numeric AUC ≈ `D/(Vd·ke)`;
flip-flop `ka≈ke` branch returns finite values; superposition of one dose equals
the single-dose curve. Numeric AUC via trapezoid on a fine grid, assert within a
small relative tolerance. Write the test before/with the math and make it pass.

## Commands

```bash
npm run dev            # dev server
npm test               # vitest run (engine oracle tests)
npm run test:watch     # vitest watch
npm run build          # tsc -b + vite build (typecheck gate)
npm run lint           # eslint
npm run format         # prettier --write
```

Before committing a change: `npm test`, `npm run lint`, `npm run build` should
all pass.

## Conventions

- Tests import from `vitest` explicitly (globals are off).
- Data files are **JSON**, validated at load with **Zod**. Reasoning goes in the
  `notes` field (we chose JSON over YAML, so no inline comments).
- License is **Apache-2.0**; keep the AS-IS / disclaimer posture intact.
- Charting is **Recharts**; the lin/semi-log y-axis toggle is a pedagogical
  feature, not optional polish.
- Conventional commits. Each commit should typecheck and pass tests.

## Build order

Follow the phases in handoff §13 — engine + tests before UI. Current state:
**Phase 7 data expansion + all three chart refinements done; static-site deploy
is the sole remaining Phase 7 item. Post-v1: the metabolites (§12) engine core
landed as a spike (see below).**

**Metabolites spike — engine core landed, UI + real compound deferred.** The §12
metabolites extension was de-risked end-to-end through the data layer (192 tests).
Landed and green: (1) **`engine/metabolite.ts`** — pure `singleDoseMetaboliteConcentration`
+ `metaboliteConcentrationCurve`, a 2-exp Bateman for an **IV-bolus parent** where the
parent `ke` is the metabolite's formation (input) rate, reusing `models.ts`'s
`FLIP_FLOP_REL_TOL` guard; oracles = `C_m(0)=0`, `AUC_m = fm·D/(k_m·Vd_m)` (k_p-independent,
exact only for IV bolus), Bateman peak time, terminal slope `−min(k_p,k_m)` (formation-
vs elimination-rate-limited), superposition. (2) **`MetaboliteParams`** in `engine/types.ts`.
(3) **`schema.ts`** — the reserved `metabolites` slot is now a real `MetaboliteSchema`
(fractionFormed/vd/halfLife each full-provenance; sourceRefs resolve into the compound
bibliography via the superRefine); an omitted/empty array stays valid so all 8 compounds
pass. (4) **`derive.ts`** `deriveMetaboliteParams` (keM=ln2/t½, Vd L/kg scaling, percent
fm normalisation). (5) **`ui/curve.ts`** `buildCurve` returns `metabolites: MetaboliteCurve[]`
— **only for `route === 'iv_bolus'`** (the mono-exponential-parent gate; also excludes
infusion), formation driven by the plotted `mainKe` (slider reshapes the metabolite but
preserves its AUC), and the horizon is sized on the slowest of parent/band/metabolite ke
so a long-lived metabolite isn't clipped. **Deferred (not done):** the React `<Line>` +
`provenance.ts`/`ProvenancePanel` metabolite rows (needs visual verification), and a real
demo compound. **No real compound shipped** — the mono-exponential-parent assumption needs
a one-compartment IV parent, and every vetted pair is two-compartment (rejection log in
`docs/DATA_GUIDE.md`): **diazepam→nordiazepam** (2-compartment + uncited fm),
**procainamide→NAPA** (2-compartment + acetylator-dependent fm), **cefotaxime→desacetyl-**
(2-compartment; fm~33% and half-lives citable — the least-bad approximation). Awaits a
clean one-compartment IV pair or the multi-compartment §12 engine extension.

**Phase 7 in progress** (polish & expand, handoff §13/§14). The seed set grew
from 3 → **8 compounds**: added `caffeine`, `ibuprofen`, `diphenhydramine`,
`metoprolol`, `amoxicillin` (all FDA-label / primary-source curated, provenance
per parameter, judgement calls in each `notes`). Adding a compound is still just
dropping a JSON file — `loader.ts`'s `import.meta.glob` picks it up and the
`loader.test.ts` integration guard derives every route of every bundled
compound (now 154 tests). No `engine/`, `schema.ts`, or `derive.ts` changes —
pure data. Curation carry-forwards worth remembering: (1) `npm test` proves
*structure + derivation*, NOT numeric correctness — magnitudes were cross-checked
by building the actual engine curve and comparing peak concentration to reported
therapeutic Cmax (caught diphenhydramine's Vd: StatPearls' 17 L/kg under-predicts
the measured 50 mg Cmax, so Blyden 1986's IV-derived 4.5 L/kg is used instead).
(2) The apparent-volume convention (F=1, use V/F) and the "don't store clearance
when t½ is derived from CL/Vd — it's a circular ke cross-check" rule (from
cetirizine) both recur. Two §14 candidates were vetted and NOT shipped, rationale
in `docs/DATA_GUIDE.md`: **omeprazole excluded** (`linear: false` — CYP2C19
autoinhibition breaks superposition) and **lisinopril deferred** (neither FDA
label nor EMA SmPC states a Vd; not guessed).

**All three chart refinements now landed** (pure-UI — no `engine/`, `schema.ts`,
or `derive.ts` changes). (1) **Cmax/Tmax markers** — `buildCurve` returns a
`peak`; `criticalTimes` samples each oral dose's analytic Bateman peak so the
marked Tmax is exact (round-trips `derive.ts`'s `kaFromTmax`), IV bolus/infusion
peaks were already pinned; a `ReferenceDot` + a route-aware `PeakNote`. (2)
**Concentration unit toggle** (mg/L ↔ µg/mL ↔ ng/mL, handoff §15 #6) and (3)
**semi-log decade ticks + band-in-tooltip**: curve math stays canonical mg/L;
concentration is converted **only at display** (tick formatter, axis label,
tooltip, marker label, and the App `ModelCaption`). Because every offered unit
is a power-of-ten factor, decade ticks generated in mg/L stay decade ticks after
conversion — so the toggle and the decade gridlines compose for free (curve.ts
`CONCENTRATION_UNITS` + `toDisplayConcentration`, re-exported like
`REFERENCE_WEIGHT_KG`).

**Input-field limits** (`src/ui/limits.ts`): every numeric control clamps its
value (`INPUT_LIMITS` + `clampInput`) — dose/ad-hoc-amount ≤ 100 g, infusion ≤
72 h, interval ≤ 168 h, ad-hoc time ≤ 1000 h, and **dose count ≤ 200**. The
count cap is the load-bearing one: `concentrationCurve` is ~O(samples × doses)
(the grid itself grows with the count via `criticalTimes`), so an uncapped count
could freeze the tab; count=200 (main + both band curves) recomputes in ~50 ms.
The clamp runs in `onChange`, not just the `max`/`min` attributes, because those
only drive the spinner/validity UI — they do NOT stop a typed or pasted value.
These are input hygiene, not clinical limits.

Key chart-refinement decisions: the unit is lifted to **App state** (not
chart-local like the y-scale) because `ModelCaption` also prints a Cmax and the
two must never disagree on screen; the semi-log y-domain **snaps to whole
decades** `[10^floor(log10 min), 10^ceil(log10 max)]` with `10^n` ticks (a plain
`'auto'` domain drops the edge decade ticks) — a sub-decade curve rides high in
its band, the conventional log-axis tradeoff; a **custom Tooltip** shows the
band's extremes labelled by meaning (short vs long t½), reading a `bandRaw`
(unclamped) datum so it stays honest even where the log axis floors a
non-positive band edge. Verified end-to-end via a throwaway Playwright driver:
mg/L→µg/mL keeps the number identical (only the label changes — the teachable
equivalence), mg/L→ng/mL scales ×1000, semi-log shows clean decade gridlines,
hover shows the band rows. The **static-site deploy** (vite `base` + GitHub
Pages workflow) is now the sole remaining Phase 7 item.

**Phase 6 done** (schedules & variability). The engine already supported
multi-dose (`recurringDoses` + linear superposition), so Phase 6 was **pure-UI**
— no `engine/`, `schema.ts`, or `derive.ts` changes. `ui/curve.ts` grew a
`DoseSchedule` (`amount`, `count`, `interval`, `adHoc: DoseEvent[]`) that
`buildSchedule` flattens to the engine's `DoseEvent[]`; `buildCurve` now takes
that schedule (not a bare `dose`) and an optional `halfLifeH` slider override,
sizes the horizon from the **last** dose so a recurring/ad-hoc course isn't
clipped, and — when the compound reports a half-life `range` — emits a `band`
(low/high `BandPoint[]`) fixed at the reported extremes. ke is scaled **around
the nominal** (`scaleKe = baseKe · nominal/target`) not `ln2/target`, so
selecting nominal reproduces the compound's derived ke exactly even for a future
clearance-derived ke. Components: `DosingScheduleEditor` (single/recurring
toggle, τ + count, add/remove ad-hoc doses) and `VariabilitySlider` (returns a
"no range" note when the compound has none — cetirizine/metformin). The chart is
now a Recharts `ComposedChart`: an `<Area dataKey="band">` (translucent, painted
BEFORE the `<Line>` so it sits behind) with log-axis bounds floored to
`minPositive`. **Variability = half-life only** (varying Vd/F/ka is a §11
non-goal); the band is the reported range, the slider is one illustrative choice
within it — the bright line holds (no patient input, no dose output). Verified
end-to-end via a throwaway Playwright driver (12/12 assertions + screenshots:
band-behind-line, slider+nominal, semi-log band, cetirizine no-band note,
recurring+ad-hoc accumulation). Next: **Phase 7** per handoff §13.

**Phase 5 done** (honesty UI). The honesty layer is now first-class:
`ui/provenance.ts` is a pure, tested helper (`provenanceEntries`,
`resolveSource`, `citedSources`) that turns a `Compound` + `route` into
route-truthful rows. Two ORTHOGONAL axes of "measured vs derived" meet there:
axis 1 = was the *source value* measured or curator-computed (the per-parameter
`derived` flag + `derived_from_*` sentinel sourceRefs → the badge); axis 2 = did
`derive.ts` transform it for the engine (the runtime `DerivedNote` list → grouped
IN under its input row). The subtle rule: **`ke` has no raw parameter** — it only
ever exists on axis 2 (computed from half-life or CL/Vd), so source rows show
half-life (and clearance when present, since `resolveKe` cross-checks it), never a
bare "ke measurement". Components: `ProvenancePanel` (rows + Sources
bibliography) and `ModelAssumptionsNote` (standing caveats — one-compartment,
linear/superposition, first-order absorption, 70 kg *illustrative* subject —
deliberately distinct from the per-curve `ModelCaption`). "Inferred, not
measured" was NOT re-copied a third time: `WarningsStrip` (App) owns dynamic
cautions, the `RouteDoseControls` note owns the contextual one, the panel/
assumptions own standing epistemic content. Phase 5 is pure-UI: no `engine/`,
`schema.ts`, or `derive.ts` changes.

**Phase 4 done** (minimum UI) — `ui/curve.ts` is the engine↔data glue
(`routeOptions`/`defaultRoute`, `buildCurve`: `deriveParams` → inject infusion
duration → single-dose schedule → auto-sized time grid → `concentrationCurve`).
`ui/App.tsx` owns state and resets the route to the compound's default on every
compound switch (so an oral-only → iv-only change can't strand a non-derivable
route). Components: `CompoundPicker`, `RouteDoseControls` (disables routes the
engine can't plot), `ConcentrationChart` (Recharts; owns the lin/semi-log
y-toggle; log axis pins the domain to the smallest positive value so `log(0)`
can't blank the chart). Earlier phases: Phase 3 data layer (`data/schema.ts` Zod
validation, `loader.ts`, `derive.ts` with the linearity gate, 3 FDA-sourced seed
compounds); Phases 1–2 engine (`models.ts`, `dosing.ts`, `pk.ts`) with the §10
oracle tests. (Phase 6 — schedules & variability — landed on top of this; see
the Phase 6 note above.)

**Linearity gate — landed (Phase 3).** Superposition is valid only for linear
PK. The engine stays pure with no `linear` flag; the gate lives in
`data/derive.ts`, where `deriveParams` throws for a `linear: false` (or
non-one-compartment) compound rather than feeding the engine parameters it would
misuse. The UI catches that throw and shows the message instead of a curve.
