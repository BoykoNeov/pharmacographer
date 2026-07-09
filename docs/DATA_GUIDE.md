# Data guide — sourcing and adding compounds

Curating the compound database is the real bulk of this project, and the
difficulty is **heterogeneity, not volume**. Sources report different parameters
(some only t½; some CL + Vd; some Cmax/Tmax/AUC; some compartmental
microconstants), and every value is implicitly tied to conditions. "Half-life =
X" is almost always a measured _distribution under specific conditions_ collapsed
to one number. This guide is how we keep that honest.

## Sourcing rules

- **Preferred bulk source: FDA Structured Product Labels.** The _Clinical
  Pharmacology / Pharmacokinetics_ section often lists what we need; the values
  are US public domain and are queryable via the **openFDA** API. EMA SmPCs are a
  good second source.
- **Be careful with DrugBank and commercial clinical references.** The underlying
  numerical _facts_ are not copyrightable, but a curated _table_ as an expression
  often is. **Re-derive and re-key** values from primary labels/papers; do not
  lift tables wholesale.
- **The honest bottleneck is judgement.** Deciding which value to trust, whether
  two sources describe the _same thing_ (same salt? geometric vs arithmetic mean?
  same route? IR vs ER?), and what range is defensible is real pharmacology work.
  Record the reasoning in the compound file's `notes`, not just the number.
- **Never invent a citation.** A computed value gets `derived: true`; a value with
  no defensible source is omitted, not guessed.
- **`range` convention.** When a label reports a mean and an SD, the seed
  compounds record `range = [mean − SD, mean + SD]` (a one-SD band). This is a
  curatorial transform of the reported spread, not a separately reported interval
  — note it in `conditions` (e.g. "mean (SD 0.6 h)"). If a source reports an
  actual range or CI, use that verbatim instead and say so.
- **Model-shape approximations are also a citation issue.** v1 is strictly
  one-compartment. Drugs that are genuinely multi-compartment get collapsed: e.g.
  using a steady-state Vss as the single Vd, or treating a drug with a
  distribution phase / saturable absorption as monophasic. This is faithful to
  the *terminal* slope but distorts the *early* curve shape. When you collapse a
  multi-compartment drug, say so in `notes` — the shape is an approximation even
  when every number is sourced.

## What "linear" means here, and what we exclude

v1 implements linear (first-order) PK, where a single half-life is meaningful and
doses superpose. Tag a drug `linear: false` and **exclude it from v1** if its
elimination is saturable / nonlinear at typical doses — a fixed half-life would be
_wrong_. Known exclusions: **phenytoin, ethanol, high-dose aspirin/salicylate**.
Leave a short note explaining _why_ so the rationale survives to the nonlinear
phase.

### Vetted §14 candidates not shipped in v1

These were on the handoff §14 candidate seed list but did **not** ship after
vetting. The rationale is preserved here so it isn't re-litigated:

- **Omeprazole — excluded, `linear: false`.** Omeprazole inhibits its own
  metabolising enzyme (CYP2C19), so its clearance falls as concentration rises:
  AUC increases _more_ than dose-proportionally above ~40 mg and exposure grows
  on repeated dosing (autoinhibition; at high dose CYP2C19 saturates and CYP3A4
  takes over). That is a genuine superposition violation — the same class of
  problem as phenytoin — so it belongs in the nonlinear phase, not v1.
- **Lisinopril — deferred, not excluded (blocker re-confirmed 2026-07-09).** Its
  kinetics are compatible with the linear model (the terminal ~40 h phase is
  saturable ACE binding that does _not_ accumulate; the accumulation-governing
  **effective half-life is ~12 h**, which is what a superposition model should
  use). It is deferred because a concentration curve needs a volume of
  distribution and **neither the FDA label nor the EMA SmPC states one** — they
  give absorption (~25%, 6–60% range), effective half-life (12 h), and Tmax
  (~7 h), but no Vd/(V/F). The `derived_from_clearance` escape hatch was
  investigated and does **not** cleanly resolve it: the only apparent oral
  clearance found is a **pediatric** popPK value (~10 L/h for a 30 kg child), not
  an adult figure, and the **dual half-life** (40 h saturable-binding terminal vs
  12 h effective) makes a single-compartment V/F = (CL/F)·t½/ln2 ambiguous in
  _which_ t½ — the 40 h phase being the very saturable-binding nonlinearity we'd
  be modelling around. Shipping would stack a pediatric CL/F on a contested t½.
  Stays parked until a clean adult V/F (or apparent oral clearance) surfaces.

### Metabolite-pair candidates — one shipped, two still deferred

The metabolites engine (`engine/metabolite.ts`) originally modelled an **IV-bolus
parent** as a mono-exponential input to a Bateman-shaped metabolite, which **requires
a one-compartment parent**; the multi-compartment §12 engine extension generalised the
formation input to the parent's α/β **modes**, so a two-compartment parent is now
representable. Rationale preserved so it isn't re-litigated:

- **Diazepam → nordiazepam (N-desmethyldiazepam) — SHIPPED** (`compounds/diazepam.json`;
  the first real 2-comp compound and the first parent→metabolite pair). It was the
  original deferral: a pronounced 2-compartment structure (distribution t½ ~1 h, terminal
  t½ ~20–48 h) that the one-compartment metabolite spike could not represent — the
  decisive disqualifier — plus an uncited `fm`. The 2-comp engine resolves the structure;
  the `fm` blocker was resolved by the **IARC monograph** figure that ~50–60% of diazepam is
  N-demethylated to nordiazepam (attributing Bertilsson et al. 1990). Curation carry-forwards:
  the schema stores CL/Vc/Q/Vp, but Q and Vp are rarely reported directly, so only **CL**
  (Greenblatt 1980, 0.39 mL/min/kg young males) and **Vc** (Klotz 1975, V1 ~0.3 L/kg) are
  sourced and **Q, Vp are derived offline** (`derived: true`) from the citable macro-observables
  CL, Vc, distribution t½(α)~1 h and terminal t½(β)~33 h — with the full micro-constant
  arithmetic in the compound `notes`. Cross-check with care: Vc + Vp = 1.02 L/kg reproduces the
  FDA ~1 L/kg Vd(ss), but that agreement validates CL and β (Vβ = CL/β) and is nearly blind to
  Vc — any Vc in 0.2–0.4 L/kg lands Vss near ~1, while C(0) = Dose/Vc swings the distribution
  peak ~2×. So **Vc is the softest input and the early-peak amplitude is illustrative** (0.3 L/kg
  is a representative young-end value; Klotz reports V1 only as an age regression, not a single
  number). Keep all four inputs to **one population** (young healthy adult) — diazepam
  kinetics drift strongly with age, so a mixed-population set breaks the α/β/Vss algebra. The
  metabolite Vd is derived from CL_m/t½_m (not measured), making nordiazepam exposure
  clearance-defined. Oral is omitted (2-comp oral is deferred; leaving it out keeps the picker
  from offering a route the engine throws on).
- **Procainamide → NAPA — out, 2-compartment + genotype-dependent fm.** Parent is a
  2-compartment model; NAPA formation is acetylator-dependent (urinary recovery
  7–34%, bimodal fast/slow), so `fm` is not a single citable number.
- **Cefotaxime → desacetylcefotaxime — SHIPPED 2026-07-09** (`compounds/cefotaxime.json`;
  the second parent→metabolite pair and the FIRST shipped compound to exercise the
  engine's ORIGINAL one-compartment-parent Bateman-metabolite path — diazepam's parent
  is two-compartment). Modelled as **one-compartment** (a documented monophasic collapse,
  the same posture as ibuprofen): its distribution phase is shallow and the reported
  healthy-volunteer numbers form a self-consistent 1-comp set — Vd 33 L, CL 341 mL/min/1.73m²,
  terminal t½ 1.13 h (Vβ = CL/β ≈ 33 L), from PMC352911. Choosing 1-comp (over back-deriving
  soft 2-comp micro-parameters) keeps every parent number a direct measurement and lets the
  clean 1-comp metabolite math apply. **fm was the honesty-critical parameter**: the only
  directly-cited figure is desacetylcefotaxime's **urinary recovery, 19 ± 4%** of dose
  (Ings 1985, PubMed 4057054), which is a LOWER BOUND on the fraction formed (the metabolite
  is further eliminated, not fully recovered). So `fm` is stored as 25% (a conservative
  estimate near the cited floor) with range 19–40% and an explicit note that 19% is the
  measured lower bound — deliberately NOT the bare "~33%" the earlier draft quoted without a
  resolvable citation. Metabolite: observed (apparent) t½ 2.3 h > parent's 1.13 h, so it is
  elimination-rate-limited (its own slower disposition governs the terminal); Vd 56 ± 24 L
  (wide). Drawn for both IV routes.

The multi-compartment §12 engine extension unblocked diazepam, and cefotaxime has now
shipped as a one-compartment collapse (both above). **Procainamide still waits** — not on
the parent's compartmental structure (now representable) but on a citable single-value `fm`
(procainamide→NAPA formation is acetylator-bimodal, 7–34% urinary recovery, so `fm` is not
one number).

### Flip-flop (ka < ke) candidate — acamprosate (found, pending a curation judgment call)

The engine gained a flip-flop-aware oral horizon (all three `curveHorizon*` size the oral
tail on `min(ka, terminal rate)`), but no shipped compound is flip-flop. A signature search
(oral terminal t½ > IV terminal t½) surfaced **acamprosate** as the cleanest documented case:
IV Vd ~1 L/kg and IV terminal t½ ~3 h (the true elimination rate), oral F ~11%, Tmax ~7 h,
no metabolism, renally excreted unchanged (BDDCS Class 3). A single-ka 1-comp model reproduces
Tmax 7 h with **ka ≈ 0.08/h < ke 0.23/h — a genuine flip-flop** (oral terminal ~8.7 h > IV 3 h).
The catch: Campral is a **delayed-release-only** product and its full reported 20–33 h oral
tail is formulation-driven — no single ka reproduces both Tmax 7 h AND a 33 h tail. That is the
"a sustained/delayed-release formulation bends 'curate drugs not formulations'" judgment call,
which was put to the user, who chose to **ship it with the caveat documented**.

**SHIPPED** (`compounds/acamprosate.json`) — the first flip-flop compound. Modelled 1-comp:
true ke = ln2/3 h ≈ 0.231/h from the IV disposition (Vd ~1.3 L/kg, IV t½ 3 h); ka inverted from
oral Tmax 7 h → **ka ≈ 0.081/h < ke — a genuine flip-flop**. IV bolus is offered as INFERRED
(available: false — no marketed IV product, but the IV disposition is real and is the source of
the true ke, so the true-vs-apparent half-life contrast can be shown); oral (F ~11%) is the real
route. Documented caveat: matching Tmax gives a modelled oral terminal ~8.7 h, SHORTER than the
label's 20–33 h — the single-ka model captures the flip-flop qualitatively but underestimates the
DR prolongation (a deliberate approximation, like ibuprofen's monophasic collapse). Verified:
IV decays on the fast 3 h t½ while the oral curve rises to its 7 h peak and outlasts the IV curve.

### Phase-7 seed expansion — 7 compounds added 2026-07-09

Beyond the metabolite/flip-flop work above, the seed set grew from 10 → 17 compounds in one
pass: **levetiracetam, fluconazole, phenobarbital** (clean linear one-compartment, oral + IV —
renal clearance, long-t½ loading-dose rationale, and very-long-t½ accumulation respectively;
phenobarbital deliberately included as the LINEAR counterpoint to excluded phenytoin);
**digoxin** (the first oral two-compartment compound — the canonical distribution-phase teacher,
from the directly-parameterized Konishi 2014 popPK model, oral + IV bolus); **vancomycin,
gentamicin** (IV two-compartment TDM archetypes, representative normal-renal-function parameters
documented diazepam-style); and **cefotaxime** (above). All validated against the engine and
magnitude-checked against reported concentrations.

### Phase-7 seed expansion (continued) — 3 compounds added 2026-07-10

A second expansion pass added **atenolol, lamotrigine, propofol** (17 → 20 compounds; 377
tests green). Each cleared the four killer-parameter gates (linear at therapeutic doses?
citable Vd or CL+t½? single citable fm if a metabolite pair? single-population
micro-constants if compartmental?) from a real source *before* any JSON was written, and each
was magnitude-checked by building the engine curve and comparing the peak to reported
concentrations.

- **Atenolol (`compounds/atenolol.json`) — clean linear one-compartment; the RENAL
  counterpoint to metoprolol.** The seed set already carries metoprolol (lipophilic,
  hepatic CYP2D6, genotype-bimodal t½, saturable first-pass F~50%). Atenolol is the
  deliberate same-class contrast: hydrophilic, renally cleared essentially unchanged (>85%
  of an IV dose in urine, minimal hepatic metabolism), low protein binding (6–16%), no
  metabolic polymorphism — its ~50% oral F is a permeability/absorption limit, not saturable
  first-pass, so exposure is dose-stable and superposition holds. Disposition + oral params
  from the FDA Tenormin label (F ~50%, Tmax 2–4 h, t½ 6–7 h); the label prints no numeric
  Vd, so the volume (~0.8 L/kg, the racemate mean of the enantiomer terminal volumes 0.79 /
  0.88 L/kg from a Journal of Pharmaceutical Sciences enantiomer PK study) is the softest
  input — treated as a true volume with F=0.5 explicit (a value below total body water would
  be implausible, arguing these are IV-derived true volumes, not oral V/F). Magnitude check:
  100 mg oral → Cmax ~0.65 mg/L (~650 ng/mL) at 3 h, within the reported single-dose band.
  Both IV routes offered (Tenormin IV is a real slow-push product).
- **Lamotrigine (`compounds/lamotrigine.json`) — clean linear one-compartment; a long
  half-life whose VALUE depends on comedication (the epistemic-honesty teacher).** FDA
  Lamictal label + Garnett 1997 review: absolute oral F ~98%, Tmax 1.4–4.8 h, apparent Vd/F
  0.9–1.3 L/kg (~1.1; treated as a true volume with F=0.98 since F≈1, the ~2% apparent-vs-true
  gap negligible — the fluconazole posture), ~55% protein binding, linear/dose-proportional.
  The teaching point is the CONDITIONALITY of the half-life: the modelled value is the
  MONOTHERAPY case (~25 h), but the same molecule runs at ~14 h alongside enzyme inducers
  (carbamazepine/phenytoin/phenobarbital/primidone induce its glucuronidation) and ~60–70 h
  alongside valproate (inhibits glucuronidation). A single stored number is only true under
  stated conditions — documented, NOT auto-applied (no comedication input, no dose output).
  Oral only (no marketed IV product; F≈1 means an inferred IV would add little contrast).
  Magnitude check: 200 mg oral → Cmax ~2.4 µg/mL at 2.5 h (single-dose peaks ~1.5–3 µg/mL;
  chronic steady-state 3–15 µg/mL accumulates higher).
- **Propofol (`compounds/propofol.json`) — the SECOND three-compartment compound; see the
  three-compartment section below.**

### Three-compartment compounds — remifentanil and propofol shipped

The 3-compartment model (§12, Stage B) is now wired through data + UI, with two compounds
shipped: **remifentanil (`compounds/remifentanil.json`), the Minto 1997 model, IV bolus +
infusion**, and **propofol (`compounds/propofol.json`), the Schnider 1998 model, IV bolus +
infusion.** Remifentanil is the clean 3-comp case and worth studying as a template:

- **Genuinely linear + directly parameterised.** Remifentanil's clearance and Vss are
  dose-independent (esterase metabolism — no saturable enzyme), and Minto 1997 reports
  V1/V2/V3 and Cl1/Cl2/Cl3 outright. So, unlike diazepam (whose Q/Vp were back-computed
  offline), **nothing is derived** — all six `disposition3c` parameters are read straight
  from the model. It is also the first compound stored in **absolute litres and L/min**
  rather than per-kg forms.
- **Reference individual = the illustrative subject.** The Minto parameters are covariate
  functions of age and lean body mass. Rather than pick a specific person, the file uses
  the model's own centred reference point (age 40, LBM 55 kg), at which each equation
  collapses to its intercept — the canonical, unambiguous "Minto reference" values —
  adopted as the project's 70 kg illustrative subject.
- **The three half-lives, by amplitude — the teachable moment.** The engine finds
  α t½ ~0.67 min, β t½ ~6.5 min, γ t½ ~51 min, but for an IV bolus the initial
  concentration splits **88.9% / 11.0% / 0.09%** across them (γ ≈ the deep back-rate
  k31, so its residue nearly vanishes). So the terminal γ (~51 min) is a real eigenvalue
  but a sub-0.1% deep-compartment tail — *not* the observable terminal decline; the β
  phase (~6.5 min) carries that and is what the commonly-quoted "~10–20 min terminal
  half-life" tracks; and neither governs clinical offset, which is the ~3 min
  **context-sensitive half-time**. `disposition.halfLife` carries the terminal γ
  (definitionally the terminal eigenvalue), but the lesson is that reading a single
  "half-life" off this drug misleads three different ways — this project's honesty thesis.
  (The amplitude split is computed from the stored parameters, not cited.)
- **Routes.** IV infusion is marked available (continuous/TCI is its real clinical route);
  IV bolus is offered as inferred (a rapid bolus risks chest-wall rigidity); oral is not
  offered (remifentanil is not given orally, and oral 3-comp derivation is deferred — the
  engine supports it, only the ka-from-Tmax inversion is unwired).

**Propofol (Schnider 1998) — the second 3-comp compound, a deliberate teaching contrast to
remifentanil.** Same directly-parameterized template (V1/V2/V3 + Cl1/Cl2/Cl3 read straight
from the model, nothing derived offline; absolute L / L·min⁻¹ units), taken at the Schnider
covariate reference point (age 53, weight 77 kg, height 177 cm, LBM 59 kg — where the
covariate equations reduce to intercepts): V1 4.27, V2 18.9, V3 238 L; Cl1 1.89, Cl2 1.29,
Cl3 0.836 L/min. Params keyed to the Sahinovic 2018 *Clin Pharmacokinet* review (PMC6267518),
which tabulates the Schnider model and discusses linearity + context-sensitive half-time.
Why it earns a slot next to remifentanil, not redundant with it:

- **The amplitude lesson, where it is CLINICALLY famous.** The engine finds α t½ ~0.72 min,
  β t½ ~15.2 min, γ t½ ~287 min (~4.8 h); an IV-bolus C(0) splits **~97.4% / ~2.4% / ~0.17%**
  across α/β/γ — even more α-dominated than remifentanil. This is *why a patient wakes within
  ~5–10 min of a single induction bolus despite the hours-long terminal half-life*: the
  post-bolus fall is α REDISTRIBUTION into muscle/viscera, not elimination. The magnitude
  check makes it vivid — a 150 mg bolus into V1=4.27 L peaks at ~35 µg/mL, redistributes to
  ~2.6 µg/mL (anaesthetic range) by 3 min, and to ~0.6 µg/mL (sub-anaesthetic) by 10 min.
- **The infusion contrast.** Propofol's large deep fat compartment (V3=238 L) fills during a
  long infusion, so its context-sensitive half-time GROWS with duration — the opposite of
  remifentanil's flat ~3–4 min CSHT. The infusion view illustrates this accumulation.
- **Both IV routes are genuinely available** (unlike remifentanil's inferred bolus): an
  induction bolus and a maintenance/TCI infusion are both standard clinical practice. No oral.
- **Linearity is a documented approximation.** Propofol is modelled linear exactly as the
  Schnider model and all TCI systems do (standard and well-validated over the clinical range);
  real clearance is partly hepatic-blood-flow-dependent with mild nonlinearity at extremes, so
  `linear: true` is faithful to the clinical-range shape, not a claim of exact
  dose-proportionality at all concentrations (the ibuprofen-collapse / acamprosate-single-ka
  documented-approximation posture).

## The schema (one JSON file per compound)

Each parameter is an object carrying provenance. Disposition parameters (Vd, t½,
CL) are route-independent and live under `disposition`; route-specific parameters
(F, ka, Tmax) live under `routes`. The `model` field is the discriminator that
lets future model types slot in, and `linear: false` means superposition is
invalid (such compounds are excluded from v1).

Real compound files are **strict JSON** — no comments and no trailing commas, so
`JSON.parse` accepts them. Curator reasoning therefore goes in the `notes` field,
never inline. Abbreviated shape (full example: handoff §8):

```json
{
  "id": "acetaminophen",
  "schemaVersion": 1,
  "names": { "inn": "Paracetamol", "usan": "Acetaminophen", "synonyms": ["APAP"] },
  "model": "one_compartment_first_order",
  "linear": true,
  "disposition": {
    "halfLife": {
      "value": 2.5,
      "range": [1.9, 3.0],
      "unit": "h",
      "derived": false,
      "sourceRef": "fda_label",
      "conditions": "healthy adults"
    },
    "vd": {
      "value": 0.95,
      "range": [0.8, 1.0],
      "unit": "L/kg",
      "derived": false,
      "sourceRef": "fda_label",
      "conditions": "..."
    }
  },
  "routes": {
    "oral": {
      "available": true,
      "F": {
        "value": 0.88,
        "unit": "fraction",
        "derived": false,
        "sourceRef": "fda_label",
        "conditions": "IR tablet, fasted"
      },
      "ka": { "value": 3.0, "unit": "1/h", "derived": true, "sourceRef": "derived_from_tmax" }
    },
    "iv_bolus": {
      "available": true,
      "F": { "value": 1.0, "unit": "fraction", "derived": false, "sourceRef": "definition" }
    }
  },
  "flags": { "nonlinear": false, "narrowTherapeuticIndex": false },
  "sources": {
    "fda_label": {
      "type": "FDA label",
      "title": "...",
      "url": "https://...",
      "accessed": "2026-06-15"
    }
  },
  "notes": "Curator reasoning: chose geometric-mean t½ from healthy-volunteer studies; ER excluded."
}
```

### Rules the loader/validator enforces

- Every numeric parameter has a `unit`, a `derived` boolean, and a `sourceRef`.
- A `sourceRef` must resolve to a key in `sources`, or be a recognised sentinel:
  `definition` (e.g. IV `F = 1`), `derived_from_tmax` (ka estimated from a
  reported Tmax), or `derived_from_clearance` (apparent Vd computed from `CL/F`
  and the half-life when the source reports no volume).
- A route with `available: false` (or missing required params) may still get an
  inferred curve, but the UI **must** label that line "inferred, not based on
  route-specific data".
- `derived: true` anywhere on a displayed line → the UI marks it computed.
- `linear: false` → multiple-dose superposition is disabled (and such compounds
  do not ship in v1).

## The derivation layer

`src/data/derive.ts` turns a raw compound into the `PkParams` the engine needs,
and returns a list of what it derived (so the UI can show it):

- `ke` from `halfLife` if no clearance; if both `clearance` and `vd` exist,
  compute `ke = CL/Vd` and warn if it conflicts with `halfLife` beyond tolerance.
- Scale `vd` (L/kg) to absolute L using the reference subject weight.
- Estimate `ka` from `Tmax` only if `ka` is absent (mark it derived).

## Adding a compound — checklist

1. Pick a **linear**, well-characterised drug with clean label PK (see the v1
   seed list in handoff §14).
2. Create `src/data/compounds/<id>.json` following the schema above.
3. Source each parameter from a primary label/paper; set `derived`, `sourceRef`,
   `unit`, `conditions` honestly. Add every source under `sources`.
4. Write the curator reasoning in `notes` — especially any judgement calls about
   which value or range you chose and why.
5. Run `npm test` (schema validation + derivation against the engine) and the app
   to eyeball the curve.
