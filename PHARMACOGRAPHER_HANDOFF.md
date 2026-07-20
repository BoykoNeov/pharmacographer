# Pharmacographer — Development Handoff

**Purpose:** an interactive, *educational* tool that plots the pharmacokinetic (PK) concentration-vs-time curve of a drug (and optionally its metabolites) from a curated database, letting the user pick route, dose, and dosing schedule, and that is honest at every step about uncertainty, data provenance, and inter-individual variability.

**Status:** greenfield. Nothing is built yet. This document is the plan to start from.

---

## 0. How to use this handoff (read first, Claude Code)

- Build in the **phase order** in §13. Do not jump ahead to UI before the engine and its tests pass.
- The three layers in §4 (**engine / data / ui**) must stay strictly separated. The engine must not import data files or UI code. This separation is the entire reason the project can "start simple and go deep later."
- Before writing any UI component, read the `frontend-design` skill. Before touching the PK math, read §7 of this document.
- Several decisions are flagged **[CONFIRM]**. Surface them to the user and get a yes before locking them in; they have already reviewed the overall plan but not these specifics. Sensible defaults are given so you are never blocked.
- Keep the disclaimer (§11) wired in from Phase 0, not bolted on at the end.

---

## 1. Product vision & guiding principles

The goal is not "a drug curve plotter" — there are many of those, and most are quietly misleading. The goal is a tool whose *epistemic honesty is the product*. Concretely, every line on the graph must be able to answer three questions: where did this number come from, was it measured or computed, and under what conditions / for whom does it hold.

Guiding principles, in priority order:

1. **Honest before pretty before featureful.** A provenance note and an "inferred, not measured" warning matter more than a second chart type.
2. **Educational, never clinical.** See §11. The hard line: nothing in the app should *look like* a per-patient dosing tool. Plotting an illustrative curve for a dose the user chose is education. Taking a patient's weight + renal function and returning a dose is clinical — do not build that, ever, regardless of how it is requested.
3. **Show the model, not just the curve.** A half-life alone does not produce a curve; a *model* does. The UI should always say which model and which assumptions produced the line.
4. **Uncertainty is first-class.** Ranges, not just point values. Where the literature disagrees, show the disagreement (a band), don't average it away.
5. **Extensible by construction.** Every v1 simplification must have a designed seam for the deeper version (§12).

---

## 2. Scope

### In scope for v1 (MVP)
- **One-compartment PK model** with first-order absorption and first-order elimination. IV bolus and oral are the two routes; IV infusion (zero-order input) is a near-free third (§7).
- **Parent compound only** (no metabolites yet — but the schema reserves space for them).
- **Single, multiple, and recurring doses** via the superposition principle (valid because v1 PK is linear).
- **A variability band**: plot the curve at the low and high reported half-life, shade between them, and let a slider pick a specific value inside the band.
- **Provenance + measured-vs-derived + inferred-route warnings** threaded through the data model and surfaced in the UI.
- **Prominent disclaimer** in-app, in README, and via the license.
- **~8–12 well-characterised, linear-PK seed compounds** (§12).
- **Linear / semi-log y-axis toggle** (elimination is a straight line on semi-log — pedagogically important and trivial).

### Explicitly deferred (but designed-for — see §12)
- Metabolites (parent → metabolite coupled kinetics).
- Nonlinear PK (Michaelis–Menten / zero-order), e.g. phenytoin, ethanol, high-dose salicylate. **These must be tagged and excluded from v1**, because a fixed half-life is *wrong* for them and superposition is invalid.
- Multi-compartment models (2-/3-compartment, distribution phase).
- Additional routes (IM, SC, transdermal, rectal, inhaled).
- Variability in parameters beyond half-life (Vd, F, ka), and genotype-stratified presets (e.g. CYP2D6 poor/extensive metaboliser).
- User-contributed compounds / PR-based data review workflow.

---

## 3. The data work (the real bulk — set expectations)

The largest effort is **not** code; it is curating the compound database, and the difficulty is **heterogeneity, not volume**. Sources report different parameters (some only t½; some CL + Vd; some Cmax/Tmax/AUC; some compartmental microconstants), and every value is implicitly tied to conditions: dose, route, fed/fasted, formulation (IR vs ER), single vs multiple dose, healthy volunteers vs patients, renal/hepatic function, age, and genetics (CYP2D6 / 2C19 / 2C9 status especially). "Half-life = X" is almost always a measured *distribution under specific conditions* collapsed to one number.

Therefore the schema (§8) makes each parameter carry value **+ range + unit + conditions + source reference + measured-or-derived flag** — which is exactly the metadata the "inferred" warning needs anyway. A small **derivation layer** then computes whatever the model needs (e.g. `ke = ln2 / t½`) from whatever subset a source provides, and marks those values as derived.

**Sourcing rules (put these in `docs/DATA_GUIDE.md`):**
- **Preferred free bulk source:** FDA Structured Product Labels — the *Clinical Pharmacology / Pharmacokinetics* section often lists the needed parameters, they are US public domain, and they are queryable via the **openFDA** API. EMA SmPCs are a good second.
- **Be careful with:** DrugBank and commercial clinical references — the underlying numerical *facts* are not copyrightable, but a curated *table* as an expression often is. Re-derive and re-key values from primary labels/papers; do not lift tables wholesale.
- **The honest bottleneck is judgement:** deciding which value to trust, whether two sources describe the *same thing* (same salt? geometric vs arithmetic mean? same route?), and what range is defensible is real pharmacology work. Record the reasoning in the compound file's notes, not just the number.
- Every parameter with no source gets `"derived": true` (if computed) or is omitted. **Never invent a citation.**

---

## 4. Architecture & separation of concerns

Three layers, hard boundaries:

```
        ┌─────────────┐     pure functions, no I/O, no UI, no data imports
        │   ENGINE    │  ←  PK math: models, dosing/superposition, derivation, units
        └─────────────┘     fully unit-tested against closed-form answers
               ▲
               │ consumes parameters (plain numbers in canonical units)
        ┌─────────────┐
        │    DATA     │  ←  compound files (one per drug) + schema/validation + loader
        └─────────────┘     derivation layer turns "what a source gave" into "what the engine needs"
               ▲
               │ provides compounds + provenance metadata
        ┌─────────────┐
        │     UI      │  ←  pickers, dose/route controls, schedule editor, chart,
        └─────────────┘     variability slider, provenance panel, disclaimer banner
```

The engine takes **parameters and a dose schedule in, a concentration-time array out**, and knows nothing about drugs, files, or pixels. This is what makes it testable and what lets every future model (§12) slot in without touching data or UI.

---

## 5. Tech stack **[CONFIRM]**

**Recommended default: a client-side TypeScript single-page app.**
- **Language:** TypeScript (engine math is pure TS — same language end to end, fully testable).
- **Framework / build:** React + Vite.
- **Charting:** Recharts (declarative, supports log scale and shaded areas for the variability band). *Alternative if more scientific features are wanted later: Plotly.*
- **Testing:** Vitest.
- **Compound data:** JSON files bundled with the app (versioned, one per compound, PR-reviewable).
- **Deploy:** static site (e.g. GitHub Pages / Netlify) — no backend needed.

**Rationale:** the interactivity requirements (slider re-rendering curves, live multiple/recurring dosing, route/dose changes) are exactly what a reactive client-side app does well, and a no-backend static deploy keeps it trivially shareable and matches the open, contributable ethos.

**Alternative the user may prefer:** Python (engine in NumPy, UI via Streamlit/Dash, plots via Plotly/Matplotlib). Cleaner if the user is more comfortable in Python or wants heavier numerical/ODE work up front; less smooth for fine-grained live interactivity. *If chosen, every "TS"/`.ts` reference below maps to the Python equivalent; the layering and schema are unchanged.*

Decisions to confirm: **[CONFIRM]** language (TS vs Python), **[CONFIRM]** charting library, **[CONFIRM]** data file format (JSON default vs YAML — YAML is friendlier for hand-curation and comments; JSON is friendlier for tooling).

---

## 6. Units policy (decide once, enforce at the edges)

PK is a unit minefield (mg vs mg/kg, L vs L/kg, ng/mL vs µg/L, h vs min). **Pick one canonical internal system; convert only at input parsing and at display.**

Canonical internal units:

| Quantity | Unit |
|---|---|
| Amount / dose | mg |
| Volume of distribution (absolute) | L |
| Concentration | mg/L (≡ µg/mL ≡ ng/µL) |
| Time | h |
| Rate constants (ka, ke) | 1/h |
| Clearance | L/h |
| Infusion rate | mg/h |

**The Vd-in-L/kg problem [CONFIRM]:** sources usually give Vd as L/kg, but a concentration needs absolute Vd in L, which needs a body weight. Asking for the user's weight edges toward a clinical tool. **Default resolution:** use a fixed, clearly-labelled *illustrative reference subject* (e.g. 70 kg, shown as an assumption in the UI, optionally adjustable but never framed as "patient weight"). Absolute Vd = (Vd in L/kg) × reference weight. Concentration is then mg/L; offer display conversion to ng/mL / µg/mL for compounds whose clinical ranges are conventionally reported that way.

Put all conversion factors in `engine/units.ts` and never scatter literals.

---

## 7. The PK engine spec

All equations are **one-compartment**. `ke = ln(2) / t½`. Where clearance and volume are both known, `ke = CL / Vd` (cross-check against t½ if both present; flag discrepancies).

**IV bolus, single dose D:**
```
C(t) = (D / Vd) · e^(−ke·t)
```

**Oral (first-order absorption), single dose D — Bateman function:**
```
C(t) = (F · D · ka) / (Vd · (ka − ke)) · ( e^(−ke·t) − e^(−ka·t) )
```
Edge case: when `ka ≈ ke` (flip-flop / equal rates) the formula is 0/0. Use the limit:
```
C(t) = (F · D · ke / Vd) · t · e^(−ke·t)
```
Use this branch when `|ka − ke|` is below a small tolerance (e.g. 1e−6).

**IV infusion, rate R0 for duration T (zero-order in, first-order out):**
```
during infusion (0 ≤ t ≤ T):   C(t) = (R0 / (Vd · ke)) · (1 − e^(−ke·t))
after infusion stops (t > T):   C(t) = (R0 / (Vd · ke)) · (1 − e^(−ke·T)) · e^(−ke·(t−T))
```

**Multiple / recurring dosing — superposition (linear PK only):**
For a schedule of doses `D_i` administered at times `t_i` (same route), the total concentration is the sum of time-shifted single-dose curves, each contributing only after its administration:
```
C_total(t) = Σ_i  singleDoseCurve(D_i, t − t_i)   for all i where t ≥ t_i
```
This one mechanism covers single doses, ad-hoc extra doses, and regular recurring schedules uniformly. **It is only valid for linear PK** — gate it on the compound's `linear` flag (§8); for nonlinear compounds (future) it must be refused / replaced by numerical integration.

**Suggested pure-function interface (TypeScript):**
```ts
// engine/types.ts
type Route = 'iv_bolus' | 'oral' | 'iv_infusion';

interface PkParams {        // all in canonical units (mg, L, h, 1/h)
  vd: number;               // absolute L (after reference-weight scaling)
  ke: number;               // 1/h
  ka?: number;              // 1/h, oral only
  F?: number;               // fraction, extravascular routes
  infusionDuration?: number;// h, iv_infusion only
}

interface DoseEvent { time: number; amount: number; } // h, mg

// the core: parameters + schedule + sample grid -> concentrations
function concentrationCurve(
  route: Route,
  params: PkParams,
  schedule: DoseEvent[],
  timeGrid: number[]        // hours
): number[];                // mg/L, same length as timeGrid
```
Keep `singleDoseCurve(route, params, dose, tau)` as the building block and implement `concentrationCurve` as superposition over it.

**Useful closed forms** (for the UI and for tests):
- Oral time-to-peak: `Tmax = ln(ka/ke) / (ka − ke)`.
- Total exposure (single dose, 0→∞): `AUC = F·D / CL = F·D / (Vd·ke)` (F = 1 for IV).
- Steady state, repeated dose D every τ:
  - Accumulation ratio `R = 1 / (1 − e^(−ke·τ))`.
  - IV-bolus `Cmax,ss = (D/Vd) · R`, `Cmin,ss = Cmax,ss · e^(−ke·τ)`.
  - Average steady-state conc `Cavg,ss = F·D / (CL·τ)`.

---

## 8. Data schema (one file per compound)

Each parameter is an object carrying provenance. Disposition parameters (Vd, half-life, CL) are route-independent and live under `disposition`; route-specific parameters (F, ka, Tmax) live under `routes`.

```jsonc
{
  "id": "acetaminophen",
  "schemaVersion": 1,
  "names": {
    "inn": "Paracetamol",
    "usan": "Acetaminophen",
    "synonyms": ["APAP"]
  },
  "molecular": { "molarMass": { "value": 151.16, "unit": "g/mol" } },

  "model": "one_compartment_first_order",   // discriminator — the seam for future models (§12)
  "linear": true,                            // false => superposition invalid; future nonlinear path

  "disposition": {
    "halfLife":  { "value": 2.5, "range": [1.9, 3.0], "unit": "h",
                   "derived": false, "sourceRef": "fda_label", "conditions": "healthy adults" },
    "vd":        { "value": 0.95, "range": [0.8, 1.0], "unit": "L/kg",
                   "derived": false, "sourceRef": "fda_label", "conditions": "..." },
    "clearance": { "value": null, "unit": "L/h/kg", "derived": false, "sourceRef": null }
  },

  "routes": {
    "oral": {
      "available": true,
      "F":    { "value": 0.88, "range": [0.70, 0.90], "unit": "fraction",
                "derived": false, "sourceRef": "fda_label", "conditions": "IR tablet, fasted" },
      "ka":   { "value": 3.0, "unit": "1/h", "derived": true,  "sourceRef": "derived_from_tmax",
                "conditions": "estimated from reported Tmax" },
      "tmax": { "value": 0.75, "range": [0.5, 1.5], "unit": "h",
                "derived": false, "sourceRef": "fda_label" }
    },
    "iv_bolus": { "available": true, "F": { "value": 1.0, "unit": "fraction", "derived": false, "sourceRef": "definition" } }
  },

  "variability": {
    "geneticFactors": [],            // e.g. ["CYP2D6"] for future genotype presets
    "notes": "Half-life prolonged in hepatic impairment; ..."
  },

  "metabolites": [],                 // reserved for future; see §12

  "flags": { "nonlinear": false, "narrowTherapeuticIndex": false },

  "sources": {
    "fda_label": { "type": "FDA label", "title": "...", "url": "https://...", "accessed": "2026-06-15" }
  },

  "notes": "Curator reasoning: chose geometric-mean t½ from healthy-volunteer studies; ER formulation excluded from v1."
}
```

**Rules the loader/validator must enforce:**
- Every numeric parameter has a `unit`. Every parameter has `derived` (bool) and `sourceRef`.
- A `sourceRef` must resolve to a key in `sources` (or be a recognised sentinel like `"definition"` / `"derived_from_tmax"`).
- A route with `available: false` (or missing required params) → the engine may still infer a curve, but the UI **must** mark that line "inferred, not based on route-specific data" (§1, §10).
- `derived: true` anywhere on a displayed line → UI marks the affected parameter/line as computed.
- `linear: false` → UI disables multiple-dose superposition and warns (v1 should simply not ship such compounds).

**Derivation layer (`engine/derive.ts`):** given a raw compound, produce the `PkParams` the engine needs. `ke` from `halfLife` if no clearance; if both `clearance` and `vd` exist, compute `ke = CL/Vd` and warn if it conflicts with `halfLife` beyond a tolerance. Scale `vd` (L/kg) by the reference weight to absolute L. Estimate `ka` from `Tmax` only if `ka` is absent (and mark derived). Return both the resolved params **and** a list of what was derived, so the UI can show it.

---

## 9. Repo structure

```
pharmacographer/
├── README.md                 # includes the prominent disclaimer (§11)
├── LICENSE                   # MIT or Apache-2.0 (AS-IS / no-warranty clause)
├── DISCLAIMER.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── engine/               # PURE — no UI, no data imports
│   │   ├── types.ts
│   │   ├── units.ts          # canonical units + all conversions
│   │   ├── models.ts         # iv_bolus / oral / iv_infusion single-dose curves
│   │   ├── dosing.ts         # superposition over schedules
│   │   ├── derive.ts         # raw compound params -> engine params (+ derived list)
│   │   └── pk.ts             # closed forms: Tmax, AUC, steady-state Cmax/Cmin/Cavg, R
│   ├── data/
│   │   ├── schema.ts         # types + runtime validation for compound files
│   │   ├── loader.ts
│   │   └── compounds/        # one file per drug
│   │       ├── acetaminophen.json
│   │       └── ...
│   ├── ui/
│   │   ├── App.tsx
│   │   └── components/
│   │       ├── CompoundPicker.tsx
│   │       ├── RouteDoseControls.tsx
│   │       ├── DosingScheduleEditor.tsx   # single + recurring (interval τ, n doses)
│   │       ├── VariabilitySlider.tsx
│   │       ├── ConcentrationChart.tsx     # lin/semilog toggle, shaded band
│   │       ├── ModelAssumptionsNote.tsx   # "which model / assumptions" (§1)
│   │       ├── ProvenancePanel.tsx        # sources, conditions, derived flags
│   │       └── DisclaimerBanner.tsx
│   └── main.tsx
├── tests/
│   └── engine/               # closed-form oracle tests (§10)
│       ├── models.test.ts
│       ├── dosing.test.ts
│       └── pk.test.ts
└── docs/
    ├── PK_MODEL.md           # the math of §7, documented
    └── DATA_GUIDE.md         # §3 sourcing rules + how to add a compound
```

---

## 10. Testing strategy

The engine's correctness lives in its tests, validated against analytic answers (no "golden curve" snapshots for the core math):

- **IV bolus single:** `C(0) = D/Vd`; `C(t½) = C(0)/2`; numeric `AUC_0→∞ ≈ D/(Vd·ke)`.
- **Oral single:** `C(0) = 0`; numeric peak time `≈ ln(ka/ke)/(ka−ke)`; numeric `AUC_0→∞ ≈ F·D/(Vd·ke)`.
- **Flip-flop branch:** `ka` set equal to `ke` returns finite values matching the limit form (no NaN/Inf).
- **Superposition sanity:** a one-element schedule equals the single-dose curve exactly; two identical doses far apart in time ≈ two non-overlapping copies.
- **Steady state (repeated IV bolus, every τ):** simulated `Cmax`/`Cmin` after many doses converge to `(D/Vd)·R` and `Cmax·e^(−ke·τ)` with `R = 1/(1−e^(−ke·τ))`; simulated interval-average ≈ `Cavg,ss = F·D/(CL·τ)`.
- **Units:** round-trip conversions in `units.ts` are exact/within tolerance.

Numeric AUC via trapezoid on a fine grid; assert within a small relative tolerance.

---

## 11. Disclaimer, licensing, legal posture

This is **educational software, not a medical device.** The disclaimer lives in *three* places:

1. **License** — MIT or Apache-2.0 **[CONFIRM]**; both carry an "AS IS, without warranty" clause that does real work.
2. **In-app** — a persistent, visible `DisclaimerBanner` (not a one-time dismissible toast): *educational use only; not medical advice; not for clinical use or treatment of real patients; data is not guaranteed accurate; the authors accept no responsibility for use.*
3. **README + `DISCLAIMER.md`** — the same notice, prominent at the top of the repo.

The strongest practical protection is not the text but a **design decision** (§1, principle 2): never build a feature that takes individual patient data and returns a dose or a clinical decision. Keep that line bright. *(Note: this is informational, not legal advice; the user should adapt wording to their jurisdiction.)*

---

## 12. Extension points — "simple now, deep later"

Each v1 simplification has a designed seam so the deeper feature slots in **without rewriting** engine/data/ui boundaries:

- **Metabolites.** Schema already has a `metabolites` array. Add `engine/metabolite.ts` implementing parent→metabolite kinetics (the one-compartment case is analytically solvable: parent eliminates, fraction `fm` forms the metabolite, which then forms and clears with its own params; watch for *formation-rate-limited* cases where the metabolite's apparent half-life tracks the parent). Each metabolite entry needs its own Vd, formation fraction, and elimination half-life. UI gains an opt-in toggle and extra lines. Engine stays pure. Good teaching cases: codeine→morphine, fluoxetine→norfluoxetine, diazepam→nordiazepam — also the hardest to source, hence deferred.
- **Nonlinear PK (Michaelis–Menten / zero-order).** The `model` discriminator + `linear` flag are the seam. Add new model functions in `models.ts`; when `linear: false`, replace superposition with numerical integration of the ODE and have the UI warn that half-life is dose-dependent. This is why `model`/`linear` exist in the schema from day one. Tag (and in v1, exclude) phenytoin, ethanol, high-dose salicylate.
- **Multi-compartment (2-/3-compartment).** Another value of `model`; add the distribution-phase equations and the extra disposition parameters (inter-compartmental rate constants / peripheral volumes). No change to the data/ui contract beyond new optional fields.
- **More routes** (IM, SC, transdermal, rectal, inhaled). Each is a new entry under `routes` with its own absorption parameters; the engine dispatches on the route's input type (bolus / first-order / zero-order / sequential). 
- **Variability beyond half-life.** Every parameter already carries a `range`. Generalise `VariabilitySlider` to also vary Vd, F, ka, and the band/envelope rendering to combine them. Then add **genotype presets** driven by `variability.geneticFactors` (e.g. CYP2D6 poor vs extensive metaboliser selecting different parameter sets).
  > **Shipped, with one clause deliberately NOT followed** (2026-07-20). Half-life, Vd and oral F are axes; genotype presets landed earlier. **"Combine them" was rejected** — bands are rendered per axis and never merged, because a merged envelope's outer edge is a person extreme on two parameters at once, which no source reports and which the phenotype-preset work had already established we do not manufacture. **`ka` was refused** as an axis: it moves Tmax and would invalidate the exact Bateman peak instant `criticalTimes` pins. See `docs/HISTORY.md` (top entry) and `CLAUDE.md` "Variability axes" — treat this bullet as the original plan, not as current instructions.
- **Community data.** Because compounds are one-file-each and provenance-rich, a PR-based review workflow drops in naturally; `DATA_GUIDE.md` becomes the contributor spec.

---

## 13. Phased build order (the actual task list)

**Phase 0 — Scaffold & guardrails.** Init repo (chosen stack), `LICENSE`, `DISCLAIMER.md`, README with disclaimer, Vitest harness, `engine/units.ts`, `engine/types.ts`. Wire `DisclaimerBanner` placeholder.

**Phase 1 — Core engine, single dose.** Implement `iv_bolus` and `oral` in `models.ts` (including the `ka≈ke` limit branch) and `iv_infusion`. Write the §10 single-dose oracle tests. Make them pass.

**Phase 2 — Dosing & steady state.** `dosing.ts` superposition + `pk.ts` closed forms; steady-state and superposition tests. Make them pass.

**Phase 3 — Data layer.** `schema.ts` + validation, `loader.ts`, `derive.ts` (with derived-list output), and **3–5 seed compounds** to start. Validate the derivation layer against the engine.

**Phase 4 — Minimum UI.** CompoundPicker, RouteDoseControls, ConcentrationChart (with lin/semi-log toggle), live persistent DisclaimerBanner. Get one real curve on screen.

**Phase 5 — Honesty UI.** ProvenancePanel (sources + conditions), ModelAssumptionsNote, measured-vs-derived flags, and the **"inferred, not measured" warning** for unavailable routes.

**Phase 6 — Schedules & variability.** DosingScheduleEditor (single + recurring: interval τ, number of doses, extra ad-hoc doses) and VariabilitySlider with the **shaded low/high half-life band**.

**Phase 7 — Polish & expand.** Fill the seed set to ~8–12 compounds, refine charts, static-site deploy.

**Then:** pick from §12 in whatever order serves the teaching goals (metabolites and genotype presets are the highest-value next steps).

---

## 14. Seed compounds for v1

Choose **linear-PK, well-characterised** drugs with clean FDA-label PK. Candidate set (curate from labels; confirm each is linear at typical doses):

- Acetaminophen / paracetamol
- Ibuprofen
- Caffeine (great for recurring-dose teaching)
- Metformin
- Amoxicillin
- Lisinopril
- Metoprolol (*CYP2D6* — flags a future genotype example)
- Omeprazole (*CYP2C19* — another future genotype example)
- Diphenhydramine
- Cetirizine

**Tag-and-exclude from v1 (nonlinear — would be misleading with a fixed half-life):** phenytoin, ethanol, high-dose aspirin/salicylate. Add a short note in each excluded entry (or a TODO list) explaining *why*, so the rationale is preserved for the nonlinear phase.

---

## 15. Open decisions to confirm with the user

1. **[CONFIRM]** Stack: TypeScript/React/Vite (default) vs Python/Streamlit-or-Dash.
2. **[CONFIRM]** Charting library: Recharts (default) vs Plotly.
3. **[CONFIRM]** Compound data format: JSON (default) vs YAML (friendlier for hand-curation + comments).
4. **[CONFIRM]** License: MIT vs Apache-2.0.
5. **[CONFIRM]** Reference-subject handling for Vd in L/kg: fixed 70 kg illustrative subject (default), and whether it is adjustable in the UI.
6. **[CONFIRM]** Concentration display units offered (mg/L default; add ng/mL, µg/mL?).
