# Pharmacographer — project guide for Claude Code

Interactive, **educational** pharmacokinetics (PK) curve plotter. The product is
**epistemic honesty**, not a prettier chart. This file is the working conventions
and the things that are easy to get wrong. The companion docs, read on demand:

| Doc | Holds |
| --- | --- |
| `PHARMACOGRAPHER_HANDOFF.md` | the full plan + phase list (§ refs below point here) |
| `docs/DATA_GUIDE.md` | **curation rules** — every screen/gate, and the rejection log |
| `docs/PK_MODEL.md` | the PK math |
| `docs/HISTORY.md` | milestone narrative: rejected alternatives + advisor catches |

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
- `linear` means **superposition is valid**, and nothing more. It used to double as
  "we don't ship this" — no longer: `linear: false` compounds ship, against the
  Michaelis–Menten engine. Linearity is a property **of the `model`**
  (`NONLINEAR_MODELS` in `schema.ts`), cross-checked against `linear` rather than
  trusted, and the reject is now "no resolver for this model", not `!linear`. A
  nonlinear compound carries `dispositionMM` (Vd/Vmax/Km) **instead of**
  `disposition` — it has no half-life to state, and the schema forbids writing one.
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
- **Every compound MUST carry a user-facing `description`** (required in schema,
  `.max(400)`): what it is + what it's typically used for, ~2 sentences. It renders
  in a **fixed-height "About" box above the chart** so switching compounds never
  jumps the chart — keep it short. Optional `metabolism` (compound-level, uncapped)
  + per-metabolite `description` render **below** the chart (free to grow). For a
  toxin, say what it *is*, not a therapy it lacks (bright line). See
  `docs/DATA_GUIDE.md` "User-facing prose".
- License is **Apache-2.0**; keep the AS-IS / disclaimer posture intact.
- Charting is **Recharts**; the lin/semi-log y-axis toggle is a pedagogical
  feature, not optional polish.
- Conventional commits. Each commit should typecheck and pass tests.

## Build order & current state

Follow the phases in handoff §13 — engine + tests before UI.

**Phase 7 (polish & expand) is complete. There is no public deploy, and that is a
decision, not a gap** — a GitHub Pages workflow was built and then removed at the
user's request (`4721f0c`): the workflow was deleted, the live Pages site was
unpublished, and the in-flight run cancelled. Do **not** re-add a deploy without
asking first. Work now comes from handoff §12 (extension points), picked for
teaching value.

**Seed set: 47 compounds** — the file count in `src/data/compounds/` is
authoritative, not this number. Adding a **linear** compound is pure data: drop in
a JSON file and `loader.ts`'s `import.meta.glob` picks it up, with
`loader.test.ts` deriving every route of it as an integration guard. No
engine/schema/derive change needed.

**Engine capabilities, all landed and wired through data + UI:**

- **1-, 2-, and 3-compartment** disposition (`models.ts` / `models2c.ts` /
  `models3c.ts`), sharing one mode-based spine (`modes.ts`): a curve is
  `Σ coef_λ·e^(−λt)`, so each route is written once, model-independently.
  3-comp eigenvalues use bracketed bisection, **not** Cardano — see HISTORY.
- **Nonlinear (Michaelis–Menten)** one-compartment (`modelsMM.ts`) — the one place
  the mode spine does **not** apply, because saturable elimination has no
  closed form and doses do not superpose. It is a **parallel path to `dosing.ts`**:
  the whole schedule is integrated as one ODE (fixed-step RK4 between dose events),
  never summed from single-dose curves. Pinned by the IV-bolus implicit solution
  `Km·ln(C0/C)+(C0−C)=(Vmax/Vd)·t`, the AUC + steady-state closed forms, mass
  balance, and the `Km≫C` collapse onto `models.ts`. Ships **phenytoin + ethanol +
  theophylline**. Theophylline is the one to study: the same molecule ALSO appears as a
  *linear* metabolite line on caffeine, ~100-300× below its Km, so that line is this
  model's own low-concentration limit rather than a contradiction — the `Km≫C` collapse
  as data. Its Vd is byte-identical across the two files on purpose; **no test compares
  them**.
- **Metabolites**, N per parent (not one), drawn in parallel off the shared
  parent CL. The route gate is `iv_bolus || oral || iv_infusion` across all
  three **linear** models (no metabolites off an MM parent).
- **`firstPassFraction` (`ffp`)** — oral-only pre-systemic metabolite formation.
- **Phenotype presets** (`variability.phenotypes`) — several illustrative populations
  per compound (procainamide: NAT2 fast/slow), switchable on screen. `applyPhenotype`
  in `derive.ts` is a pure Compound→Compound transform run BEFORE derivation, so **no
  engine change** and no genotype concept crosses the engine boundary. `presets[0]` is
  the default and must override **nothing** — the base values ARE the default
  phenotype, which makes the default render provably the pre-preset compound. Adding a
  preset to a compound is data + citations. See `docs/DATA_GUIDE.md` "Phenotype presets".
- Routes: oral, IV bolus, IV infusion, **transdermal**. Multi-dose via superposition
  (linear) or whole-schedule integration (MM); per-parameter variability bands; Cmax/Tmax
  markers; lin/semi-log toggle; unit toggle.
- **Variability axes** (`VariabilityAxis` in `ui/curve.ts`) — **half-life, Vd, and oral F**,
  each a slider over that parameter's reported range with its own toggleable band. **The
  bands are never merged**, which is a deliberate deviation from §12's "combine them": a
  merged outer edge is a person at the 5th-percentile volume AND the 95th-percentile
  half-life — a pairing no source reports, and the same "don't manufacture populations
  nobody observed" rule that phenotype presets enforce in the data layer. Every axis is a
  RATIO of the derived nominal, so nominal reproduces the pre-feature curve exactly.
  Gated to 1-comp (2-/3-comp have no single Vd or t½; MM has no `disposition` block); F is
  gated to the ENGINE oral route, which correctly excludes transdermal. **F is not a
  clone of Vd**: the two are COLLINEAR on the parent curve (it depends on them only via
  `F·D/Vd` — the classical `V/F` non-identifiability), so the F slider must NOT reuse the
  "X is held constant" copy. Note the limit of that claim, which an advisor pass had to
  correct after it shipped: non-identifiability is about **attribution** (the curve cannot
  tell you *which* parameter moved), NOT about F and Vd being one quantity. They are
  separately measured, vary for unrelated reasons, and their extremes compound — morphine's
  high-F/small-Vd corner is 1.7× the nominal height, outside either band alone, and is a
  coherent person. So the panel instructs neither "add these" nor "never add these": nothing
  in the data gives the F–Vd covariance. Keeping F×Vd unmerged rests on **legibility**, not
  on non-observability; only the t½×Vd pair has the stronger argument (coupled via
  clearance, so a merged corner may be physiologically impossible). F and Vd diverge in
  exactly one place, the oracle pair in `curve.test.ts`: parent Vd **cancels** in metabolite
  formation and F does not.
  **`ka` is deliberately not an axis** — it moves Tmax, invalidating the exact Bateman
  peak instant `criticalTimes` pins.
- **Transdermal (`transdermal`)** — the §12 "more routes" seam, and it added **no engine
  math**: a patch is a ZERO-ORDER input, which `iv_infusion` already is, so `engineRouteOf`
  (`derive.ts`) maps it onto that path and the mode spine covers 1-/2-/3-comp alike. The
  engine's `Route` union stays at the three INPUT TYPES on purpose — a transdermal branch
  there would duplicate `iv_infusion`'s math. The wider clinical vocabulary is `DataRoute`
  (`schema.ts`); "which patch/needle/tablet" is a fact about drugs, which the engine must not
  know. Ships **clonidine** (transdermal-only). `TransdermalRouteSchema` stores a
  `deliveryRate` + `wearDuration` and **deliberately has no `F`** — a patch label's stated
  delivered rate is already the systemic input, so re-applying its separately-reported
  "bioavailability" would double-count and silently put the curve ~40% low; the schema makes
  that unwriteable, as `DispositionMM` does for `halfLife`. The horizon is the wear period
  **exactly** (no decay tail): a patch's post-removal decline runs on the ABSORPTION rate (a
  skin depot), so the window ends at patch-off rather than drawing it wrong. **A worn patch
  has no peak** — the marker reads "End of wear", not Cmax/Tmax.

**A nonlinear compound is NOT pure data** — unlike a linear one. It needs
`dispositionMM`, `linear: false`, and an **explicit cited `ka`** for oral: a Tmax
cannot be inverted without a `ke`, and Tmax itself moves with dose, so
`deriveParamsMM` refuses rather than fabricate the dose it was measured at
(phenytoin therefore ships IV-only; ethanol ships oral). It also has no half-life
slider and no variability band — `VariabilitySlider`'s `NoRangeReason` says *why*,
and "no range reported" would be a falsehood under phenytoin, whose label reports
7–42 h. Optional `illustrativeDoseMg` sets the dose the chart **opens** at, for a
compound whose scale makes the generic 500 mg misrepresent it (ethanol at 500 mg
renders as a plain exponential — the whole point invisible). It is a scale, never
a recommended dose.

**When curating a compound, `docs/DATA_GUIDE.md` is the authority** — it holds
every reusable screen (the `F·D/V` ceiling test, the first-pass timing screen,
the formation-rate-limited recipe, the molar→mass `fm` conversion,
intrinsic-vs-apparent half-life, phenotype-anchoring) and the rejection log for
compounds that were evaluated and excluded or deferred. Check it before adding a
compound; a gate decision must rest on a source actually opened.

A **phenotype preset is not pure data either** — like a nonlinear compound, it has its
own gates. Both populations should come from one study/design (procainamide takes fast
and slow from the same Wierzchowiecki arm); a preset overrides **only** what the
polymorphism actually touches (Vd is acetylator-independent, so neither preset moves
it); each preset's half-life range stays **inside its own phenotype**, because crossing
populations is the preset's job — it swaps t½ and fm atomically, making the mixed state
(one phenotype's half-life, the other's fm) unreachable rather than merely discouraged.
A compound with a half-life preset must **not** store `clearance`: `resolveKe` prefers a
stored CL, so the override would be silently discarded and the curve simply would not
move. The picker's copy is a **bright-line gate**: illustrative populations to look at,
never "select your genotype" — `tests/ui/phenotype-picker.test.tsx` asserts it.

**Two standing traps** (both have bitten before, both are invisible to CI):

- `npm test` proves *structure + derivation*, never *numeric correctness*.
  Magnitude-check a new compound by building the engine curve and comparing peak
  concentration to a reported Cmax. For a zero-order input use `Css = R0/CL` (it
  depends on clearance ALONE, so it is a free check on the data), and check the
  *approach* too — `ke = CL/Vd` against a reported time-to-steady-state.
- **Tests are blind to on-screen prose, and a route ternary silently inherits its
  last branch.** Adding `transdermal` left `PeakNote` explaining a patch with the
  ORAL story ("the peak (Tmax) is where those balance") under a curve that never
  falls — 522 green tests, typechecker happy. **Launch the app** for anything
  route- or phenotype-keyed, and grep for EVERY surface asserting the same thing
  (caption, note, and chart marker were three independent ones).
- Tests, lint, build, and magnitude checks are all blind to whether a citation
  is real. Never ship a source you did not open.
