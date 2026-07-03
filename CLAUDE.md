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
landed as a spike; the **multi-compartment (2-compartment) §12 engine extension**
landed AND is wired into the app (bolus/infusion/oral + metabolites); the first
2-comp compound (diazepam→nordiazepam) shipped; the **3-compartment (Stage B)
engine extension** landed (cubic eigenvalues via bracketed bisection, RK4-cross-checked);
and that 3-comp model is now **fully wired through data + UI with the first 3-comp compound
shipped — remifentanil (Minto model), IV bolus + infusion (308 tests)**. See the per-milestone
notes below.**

**Multi-compartment (2-compartment) §12 engine extension — engine + glue + tests
landed AND wired into the app (246 tests).** The linear 2-comp model (central +
peripheral, elimination from central), for **IV bolus + IV infusion**, unblocks
the real metabolite compounds whose parents are all 2-compartment (diazepam→
nordiazepam etc.). Design spine: the central concentration is a sum of exponential
**modes** `Σ coef_λ·e^(−λt)` (`engine/types.ts` `ExpMode`), which unifies the
parent bolus/infusion curves and the metabolite (a superposition over the parent's
modes). Landed and green: (1) **`engine/models2c.ts`** — clinical params
(`TwoCompParams`: CL/Vc/Q/Vp) → micro-constants (`k10=CL/Vc`, `k12=Q/Vc`,
`k21=Q/Vp`) + eigenvalues α,β; `twoCompModes`, `singleDose2cConcentration`
(bolus + infusion; oral throws — deferred), `concentrationCurve2c`. **`models.ts`
left untouched.** (2) **`engine/metabolite.ts`** — extracted `batemanMode(amplitude,
inputRate, elimRate, τ)`; the KEY subtlety is the metabolite formation amplitude
carries the parent **CL** (via `k10`), decoupled from the mode rates α/β — so
`singleDoseMetaboliteConcentration` (1-comp) is the single-mode special case of
`metaboliteConcentrationFromModes`, and `singleDose2cMetaboliteConcentration`/
`metabolite2cConcentrationCurve` drive it off the parent's α/β modes. `AUC_m =
fm·D/(k_m·Vd_m)` is UNCHANGED (parent-disposition-independent) — a free regression
anchor. (3) **`engine/pk.ts`** — `initialConcentration2c` (D/Vc), `singleDoseAuc2c`
(D/CL), `terminalRate2c` (β). (4) **`schema.ts`** — `two_compartment_first_order`
model + optional `disposition2c` block (CL/Vc/Q/Vp full-provenance), required iff
the model is 2-comp (superRefine). (5) **`derive.ts`** — SPLIT linearity gate
(`deriveParams` still 1-comp; new `deriveParams2c`); `deriveMetaboliteDisposition`
extracted (model-agnostic) with `deriveMetaboliteParams` wrapping it. (6)
**`ui/curve.ts`** — `buildCurve2c` (returns `TwoCompartmentCurveResult`): horizon
on the terminal β, **distribution-phase grid densification** (`criticalTimes2c`
log-spaces samples over the first α half-lives so the fast knee isn't aliased),
metabolite modes wired. Oracles: `C(0)=D/Vc`, `AUC=D/CL`, terminal slope `−β`, coef
sum, infusion continuity + `R0/CL` plateau, **collapse-to-1c** (`Q→0` reproduces the
1-comp curve AND the 1-comp metabolite exactly), metabolite AUC/terminal/superposition.
**Wired into the app:** `CurveResult` is now a discriminated union on `model`;
`buildCurve` DISPATCHES (2-comp → `buildCurve2c`); `ModelCaption` branches (α/β
distribution + terminal t½); the variability slider is gated to 1-comp (varying one
half-life is ill-defined across two eigenvalues); `loader.test.ts`'s integration
guard is model-aware. So a `two_compartment_first_order` JSON in `data/` renders its
parent curve today. **The first real 2-comp compound has now SHIPPED:
`compounds/diazepam.json` (diazepam→nordiazepam) — 247 tests, 9 compounds.** It is also
the first parent→metabolite pair. Curation spine (details in `docs/DATA_GUIDE.md` and the
compound `notes`): the schema stores CL/Vc/Q/Vp, but Q and Vp are rarely reported
directly, so only **CL** (Greenblatt 1980, 0.39 mL/min/kg) and **Vc** (Klotz 1975, V1
~0.3 L/kg) are sourced and **Q, Vp are derived offline** (`derived: true`) from the
citable macro-observables CL, Vc, α t½~1 h, β t½~33 h via the standard micro-constant
algebra (arithmetic in `notes`); the engine round-trips them back to α t½ 1.00 h / β t½
33.0 h, and Vc+Vp = 1.02 L/kg matches the FDA ~1 L/kg Vd(ss) — but that cross-check
validates CL/β (Vβ = CL/β), NOT Vc, which is the softest input: C(0)=Dose/Vc swings the
distribution peak ~2× across the plausible 0.2–0.4 L/kg range with little effect on Vss,
so the early-peak amplitude is deliberately illustrative (0.3 L/kg is a representative
young-end value; Klotz reports V1 only as an age regression). Keep all inputs to ONE
population (young healthy adult). The `fm` blocker (uncited in the old
rejection log) was resolved by the IARC monograph's ~50–60% N-demethylation figure
(Bertilsson et al. 1990); the metabolite Vd is derived from CL_m/t½_m (not measured).
Oral omitted for diazepam (no defensible young-adult Tmax curated; omitting it stops the
picker offering a route with no sourced absorption input).

**Oral 2-compartment parent — Stage A LANDED (engine + glue + tests; NO compound shipped).**
The tri-exponential oral parent (the two disposition modes α, β plus the absorption mode
ka) now works end-to-end. The mode drivers were extracted into a shared spine so a route is
model-independent: (1) **`engine/modes.ts`** (new) — `batemanMode` (moved down from
`metabolite.ts`, re-exported there to keep its import name) + `batemanModeDerivative` +
`sumModes` + `infusionConcentrationFromModes` + `oralConcentrationFromModes`; the oral curve
is the convolution of first-order absorption with the disposition impulse response = one
`batemanMode` per mode: `C(t)=Σ batemanMode(ka·F·D·g_λ, ka, λ, t)`, inheriting the `ka≈λ`
flip-flop guard for free. Import DAG stays cycle-free (models→{}; modes→models;
models2c→models+modes; metabolite→modes+models2c). (2) **`models2c.ts`** — `twoCompOralConcentration`
+ `oralPeakTime2c` (numeric `dC/dt=0` root; no closed form). (3) **`derive.ts`** —
`kaFromTmax2c` (inverts a reported Tmax to ka via the 2-comp peak solve; flip-flop `ka<β`
warning + F-assumed-1 warning). (4) **`curve.ts`** — `buildCurve2c` oral branch: horizon adds
~3 ka half-lives, `criticalTimes2c` densifies over the faster of α/ka and pins the exact
Bateman peak. Oracles: `C(0)=0`, oral `AUC=F·D/CL`, terminal slope `−min(ka,β)`, F linear
scaling, `kaFromTmax2c`↔`oralPeakTime2c` round-trip, and **collapse-to-1c** (oral matches the
one-compartment oral Bateman 12-digit). Verified in the running app (throwaway 2-comp oral
compound): picker offers Oral, curve renders as a proper tri-exponential (absorption→α knee→β
tail), Cmax marker lands at the target Tmax, derived-ka provenance row shows. **Metabolite-from-
oral-parent stays deferred** (the metabolite gate is still `route==='iv_bolus'`).

**Three-compartment parent — Stage B LANDED (engine + tests; NO compound shipped; 301 tests).**
The mode-based spine paid off: the ONLY new disposition code is `models3c.ts` computing three
`ExpMode`s; bolus/infusion/oral all fall out of the shared `modes.ts` drivers unchanged, and
the metabolite core already takes arbitrary modes. Where 2-comp eigenvalues are a QUADRATIC, the
three eigenvalues α > β > γ are the roots of the characteristic **CUBIC** `p(λ)=λ³−a₂λ²+a₁λ−a₀`.
**Solved by bracketed bisection, NOT Cardano/trig** (advisor call): the closed-form trig solution's
fragility (arccos drifting outside [−1,1]→NaN, cancellation at the widely-separated PK regime
α≫β≫γ) lands exactly where the oracles can't see it, and numeric roots violate nothing since
correctness rests on analytic ORACLES (AUC=D/CL, C(0)=D/Vc, terminal=−γ). The key: `p'(λ)` is a
QUADRATIC (closed form) whose two roots strictly separate the three cubic roots, so each sits in a
guaranteed-sign-change bracket and bisects out ORDERED (auto α/β/γ) — reusing `oralPeakTime2c`'s
200-iter idiom. Landed: (1) **`engine/types.ts`** — `ThreeCompParams` (CL/Vc/Q2/Vp2/Q3/Vp3 + oral/
infusion). (2) **`engine/models3c.ts`** — `threeCompRates` (micro-constants k10/k12/k21/k13/k31 +
cubic bisection via the derivative-quadratic brackets), `threeCompModes` (residue coefficients
`g_λ=(k21−λ)(k31−λ)/[Vc·Π_{μ≠λ}(μ−λ)]`, whose Σ=1/Vc by a Lagrange divided-difference identity ⇒
C(0)=D/Vc; degeneracy guard DROPS a coinciding mode since its numerator also →0 at every physical
collapse edge, same defensive posture as 2-comp's α≈β fallback), route dispatch + `oralPeakTime3c`
+ `concentrationCurve3c`. `models.ts`/`models2c.ts` UNTOUCHED. (3) **`engine/metabolite.ts`** —
`singleDose3cMetaboliteConcentration` + `metabolite3cConcentrationCurve` (drive the existing
mode-core off `threeCompModes`). Import DAG stays acyclic (models3c→models+modes;
metabolite→modes+models2c+models3c). Oracles (collapse written FIRST): **Q3→0 reproduces the 2-comp
curve AND 2-comp metabolite exactly (12-digit) for every route; Q2,Q3→0 reproduces the 1-comp curve
AND 1-comp metabolite exactly** (the double-zero-root degeneracy the guard must drop cleanly); plus
C(0)=D/Vc, Σg=1/Vc, AUC=D/CL, terminal=−γ, infusion continuity/plateau, oral peak, superposition.
**Critical de-risking catch (2nd advisor pass):** the Vieta / "root of the cubic" tests are
CIRCULAR (they confirm the solver found roots of the polynomial we wrote, not that it's the true
characteristic one), AUC pins only a₀, and the collapse tests zero out a₁'s coupling terms — so a₁
(the coefficient carrying the 3-comp coupling) was UNVERIFIED. Fixed with an independent **RK4
integration of the defining compartment ODEs** matching `A1(t)/Vc` to the analytic curve
(bypasses all coefficient algebra); mutation-tested (flipping a₁'s `e2·e3` sign makes ONLY the RK4
check fail while the circular tests pass) — so the cubic is genuinely de-risked, not just
self-consistent. **Scope held to a pure-engine spike** (like the metabolite / oral-2c spikes): NO
`schema.ts`/`derive.ts`/`ModelCaption`/`ModelAssumptionsNote` wiring, NO compound — 3-comp linear
compounds with citable single-population params are scarce (amiodarone/thiopental are nonlinear /
unsourceable). The data+UI wiring waits for a real compound.

**3-compartment DATA + UI wiring — LANDED, and the first 3-comp compound SHIPPED: remifentanil
(Minto model), IV bolus + infusion, 308 tests.** A real citable compound finally justified wiring
the Stage-B engine through the data/UI layers; it mirrors the 2-comp wiring almost line-for-line.
(1) **`schema.ts`** — `three_compartment_first_order` in `ModelSchema` + optional `disposition3c`
block (CL/Vc/Q2/Vp2/Q3/Vp3 full-provenance; field names `centralVd`,
`interCompartmentalClearance2`/`peripheralVd2`, `interCompartmentalClearance3`/`peripheralVd3`),
required iff the model is 3-comp and rejected on other models (superRefine + the six sourceRef
cross-checks). (2) **`derive.ts`** — `deriveParams3c` (reuses `resolveVolumeParam`/
`resolveClearanceParam`; IV-only — **oral 3-comp derivation THROWS a clear message**, deferred like
diazepam's oral). (3) **`curve.ts`** — `ThreeCompartmentCurveResult` added to the `CurveResult`
union; `buildCurve` dispatches 3-comp → `buildCurve3c` (horizon on terminal γ, `criticalTimes3c`
densifies the fast α/β knees, α/β/γ half-lives for the caption). (4) **`App.tsx` `ModelCaption`** +
**`ModelAssumptionsNote`** — 3-comp branches ("Three-compartment model", α/β/γ; "Three
compartments" central + rapid + deep peripheral). The variability slider auto-excludes 3-comp (App
computes `halfLifeRange` only for one-compartment). Provenance panel is model-agnostic (reads the
base `disposition` + routes), so the six `disposition3c` params are NOT surfaced there — at parity
with `disposition2c`. Tests: schema `Disposition3cSchema` block (6 cases), the loader integration
guard's 3c branch, and the engine was smoke-tested on the REAL Minto regime FIRST (advisor call —
widely-separated eigenvalues α≫β≫γ, the Cardano-fragile regime the bisection is built for) before
any wiring. **CURATION (`compounds/remifentanil.json`, `docs/DATA_GUIDE.md`):** remifentanil is the
clean 3-comp case — genuinely LINEAR (dose-independent CL/Vss; esterase metabolism, no saturable
enzyme) and directly PARAMETERISED (Minto 1997 reports V1/V2/V3 + Cl1/Cl2/Cl3 outright, so unlike
diazepam NOTHING is derived offline — all six read straight from the model). It is the FIRST compound
in absolute L / L·min⁻¹ units (all prior used per-kg; `units.ts` L/min ×60 + absolute-L paths verified).
Reference individual = the Minto covariate-centred point (age 40, LBM 55 kg → the equation intercepts
V1=5.1, V2=9.82, V3=5.42 L; CL=2.6, Q2=2.05, Q3=0.076 L/min), adopted AS the 70 kg illustrative
subject. `disposition.halfLife` carries the ENGINE-computed terminal γ (51 min; the three eigenvalues are
α t½ 0.67 min / β t½ 6.5 min / γ t½ 51 min) — but the teachable point is AMPLITUDE, not just the
values: for an IV bolus C(0) splits 88.9% α / 11.0% β / **0.09% γ** (γ≈k31, residue nearly vanishes;
verified against the engine). So the terminal γ (~51 min) is a real eigenvalue but a sub-0.1%
deep-compartment tail — NOT the observable terminal decline (the β ~6.5 min phase, which the quoted
"~10–20 min terminal t½" tracks) and NOT what governs clinical offset (the ~3 min context-sensitive
half-time). Reading a single "half-life" off this drug misleads three ways — the honesty thesis
(an earlier draft overclaimed 51 min as "the honest terminal t½ / literature is truncated"; advisor
caught it, reframed to the amplitude split). `disposition.vd` = ΣVi = 20.34 L (mammillary Vss; reported ~30 L cross-check doesn't move
the shape). Routes: iv_infusion available (TCI is its real route), iv_bolus inferred (rigidity risk),
no oral. Verified via throwaway UI-glue tests (C(0)=Dose/V1 exact, tri-phasic ordered, inferred-route
warning on bolus only) — the metabolite `<Line>` deferral is unaffected (remifentanil has no
metabolite). 

**Metabolite `<Line>` rows — LANDED (pure-UI; both models; 308 tests unchanged).** The metabolite
curves were already COMPUTED end-to-end (`buildCurve`/`buildCurve2c` populate `metabolites:
MetaboliteCurve[]` on `CurveResultBase`); they are now DRAWN. Two files: (1) **`ui/App.tsx`** passes
`curve.value.metabolites` + `parentName={compound.names.inn}` to the chart, and folds each
metabolite's `warnings` into the shared `WarningsStrip` (dormant for diazepam — fm 55% is in range —
but honest plumbing so a metabolite caution is never dropped). (2) **`ui/components/ConcentrationChart.tsx`**
— a dashed `<Line>` per metabolite (hue cycled from `METABOLITE_COLORS`, distinct from the parent
blue and the yellow Cmax marker), a top `<Legend>` (only when metabolites present) naming the parent
and each metabolite as "… — active metabolite"/"… — metabolite", and tooltip rows for each. Design
spine (advisor-reviewed): the chart is **model-agnostic** — it consumes the identical `MetaboliteCurve[]`
whichever path built it, so "both models" falls out with NO `model` branch. Metabolites zip to `points`
by INDEX (both build paths evaluate them over the same `times` array — no merge-on-`t`). The
load-bearing gotcha: **every metabolite has `C(0)=0` (an oracle)**, so its t=0 sample is nulled on the
semi-log axis exactly like the main line (`isLog && !(c>0) ? null : c`) — else semi-log blanks/dives
the metabolite; and metabolite positives are added to the log-domain `positives` (nordiazepam
accumulates ABOVE the parent late, so it would overflow otherwise). Scope held to lines+legend+tooltip:
the `provenance.ts`/`ProvenancePanel` metabolite rows were a SEPARATE item that has since LANDED (the
metabolite's per-parameter `derived`/source rows are now surfaced in the honesty panel — see the
ProvenancePanel metabolite-provenance rows note below). Verified in the running
app (throwaway Playwright driver): diazepam/iv_bolus draws the solid-blue parent + dashed-orange
nordiazepam with a top legend; tooltip shows both (nordiazepam 0.50 vs parent 0.031 mg/L at t=250 h —
the late crossover); **semi-log renders both across the full decade range without blanking**; the
metabolite line DROPS on iv_infusion (the `route==='iv_bolus'` gate) and is absent for a no-metabolite
compound (caffeine — single line, no legend); no console errors.

**ProvenancePanel metabolite-provenance rows — LANDED (pure-UI; both models; 317 tests).** The metabolite
line's own numbers now come clean in the honesty panel, at parity with the parent rows. Two files: (1)
**`ui/provenance.ts`** — new `metaboliteProvenanceEntries(compound, plotted)` returning one
`MetaboliteProvenanceGroup` per PLOTTED metabolite (`{id, name, active, rows}`), each with its fraction-
formed / Vd / half-life rows built by the SAME `makeRow`/`classify`/`resolveSource` machinery as the parent
(measured-vs-curator-derived badge + citation + conditions), and the metabolite's axis-2 runtime derivations
grouped under their input row via `metaboliteDerivationTargetKey` (`vdM`→Vd, `keM`→half-life — like the
parent's `ke`, `keM` has no row of its own —, `fractionFormed`→fm). `provenanceEntries` is UNCHANGED (kept
the flat `ProvenanceRow[]` API so the ~15 existing provenance tests stand). (2) **`ui/components/
ProvenancePanel.tsx`** — a new optional `metabolites` prop; renders each group under a `— active
metabolite`/`— metabolite` subheading (mirrors the chart legend wording) and folds the metabolite rows into
`citedSources` so metabolite-only citations reach the bibliography. Design spine (advisor-reviewed): the panel
keys off the BUILT `curve.value.metabolites` (not `compound.metabolites`), so it is route-truthful for free —
metabolites compute only for `route==='iv_bolus'`, so an infusion draws no line AND shows no rows, and when
oral-parent metabolites eventually widen the gate the rows follow with no change. Structural two-source join:
the raw provenance-carrying `CompoundParameter`s come from `compound.metabolites` (by `id`), the axis-2
`DerivedNote`s from the plotted `MetaboliteCurve` — so `provenance.ts` need not import the UI curve type
(minimal `PlottedMetabolite = {id, derived}` input). The observable win: for diazepam/iv_bolus the panel now
surfaces `iarc_monograph` (fm) and `chemm` (metabolite Vd) — sources that previously appeared NOWHERE.
Verified via a throwaway Playwright driver (metabolite group renders with badges + derivations, IARC/CHEMM in
Sources, group drops on iv_infusion; no console errors) and a `ProvenancePanel` render test with the real
diazepam pair. App passes `curve.value.metabolites` to the panel.

Deferred follow-on still open: oral-PARENT metabolites (needs residue-form
parent modes; the metabolite gate is still `route==='iv_bolus'`), and oral 3-comp derivation
(`deriveParams3c` throws on oral; the engine supports it via `oralPeakTime3c`, only the `kaFromTmax3c`
inversion is unwired). **DONE:** the ProvenancePanel metabolite-provenance rows (above); the metabolite `<Line>` rows; the 3-comp DATA+UI wiring; the
`ModelAssumptionsNote` compartment caveat is now model-aware (`fix(ui)`, commit `6dc022a`) — a 2-comp
compound gets a "Two compartments" bullet (central/peripheral split, α→β phases) instead of the
contradictory hardcoded "One compartment"; branched on `compound.model`, verified in the running app.

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
so a long-lived metabolite isn't clipped. **Since landed:** the React `<Line>` rows are now
DRAWN (see the "Metabolite `<Line>` rows" note above) and a real demo compound shipped
(diazepam→nordiazepam), and the `provenance.ts`/`ProvenancePanel` metabolite
rows now surface the metabolite's own per-parameter provenance (see the ProvenancePanel note above). **No real compound shipped** — the mono-exponential-parent assumption needs
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
