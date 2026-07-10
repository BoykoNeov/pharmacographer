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
- **The `F·D/V` ceiling test — run it BEFORE writing JSON.** For a one-compartment
  model, `F·D/V_reported` is a *hard ceiling* on the peak concentration: an IV
  bolus hits it exactly, and oral / infusion land strictly below it (via the
  Bateman / accumulation factor). So the cheap pre-write gate is: compute
  `F·D/V_reported` and compare to the reported Cmax. If the ceiling sits
  **comfortably above** Cmax, a one-compartment collapse works — pick the volume
  *within the cited source range* that lands the peak on Cmax (the diphenhydramine
  posture) and move on. If the ceiling is **below** Cmax, the drug is too
  distributed for a one-compartment model at that volume — no `ka`/`ke` choice can
  rescue it (the reported Vd is a tissue Vss larger than the plasma-peak volume);
  **defer or model it two-compartment**. This is cheaper than building the curve
  and it is why ciprofloxacin and sildenafil are deferred below. Confirm the final
  peak against the built engine curve regardless — `npm test` proves structure and
  derivation, never magnitude.

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

### Deferred for the `F·D/V` ceiling — ciprofloxacin and sildenafil (genuine multi-compartment)

Both cleared the linearity gate but FAILED the `F·D/V` ceiling test (above), for the
same root cause: the source reports a tissue Vss too large for a one-compartment
curve to reproduce the labeled Cmax, and no clean single-population two-compartment
model was at hand. Documented so they aren't re-litigated:

- **Ciprofloxacin — deferred (needs a two-compartment model).** A clean, familiar
  fluoroquinolone, but genuinely two-compartment. The FDA label gives F ~70%, Cmax
  500 mg = 2.4 mcg/mL, t½ ~4 h, and dose-proportionality (linear), but **no Vd**;
  literature IV Vd is 2.1–2.7 L/kg. A one-compartment collapse cannot fit both
  landmarks: the label Cmax implies an apparent V/F ≈ 1.6 L/kg, while the AUC /
  terminal slope implies ≈ 3 L/kg — a ~2× disagreement, which is exactly the
  two-compartment signature (Vc ≪ Vss). Using Vss ~2.5 L/kg under-predicts the peak
  by ~40%. The available population-PK models are ICU/hospitalised-skewed with wide
  cross-study ranges (Vc ~22–143 L, Vp ~75–212 L), so a coherent single-population
  Vc/Vp/CL/Q set for a healthy adult was not sourceable in this pass. **Levofloxacin
  was shipped instead** as the clean fluoroquinolone (F ~99%, small distribution
  phase, ceiling test clears). Cipro stays parked until a citable single-population
  two-compartment model surfaces.
- **Sildenafil — deferred (one-compartment ceiling fails; not cleanly 2-comp).** A
  clean PDE5-inhibitor label (Viagra): F 41% (25–63%), Vss 105 L, terminal t½ ~4 h,
  Tmax ~1 h, dose-proportional, mean Cmax ~440 ng/mL for 100 mg. But `F·D/Vss =
  0.41·100000 µg / 105 L ≈ 390 ng/mL < 440` — the **ceiling itself is below the
  labeled Cmax**, so no within-source volume works and the drug is mildly
  two-compartment (Vss is tissue volume). The two honest escapes are both worse than
  deferring: (a) overriding to a Cmax-fit V ~80 L trades a visible ~25% peak error
  for a hidden ~50% AUC over-prediction that would distort the multi-dose
  accumulation view; (b) a two-compartment model is not sourceable — the label
  reports a single ~4 h terminal half-life with no distribution phase, so Vc/Vp/Q
  cannot be pinned even diazepam-style. (Do NOT rescue it with "the low peak is
  within the 25–63% F spread" — that conflates inter-individual variability, which
  is the half-life slider's job, with a mean-value miss; a model at mean F and mean
  Vss should reproduce the mean Cmax.) Stays parked pending a citable
  distribution-phase parameterisation. Its active N-desmethyl metabolite (~50%
  potency, plasma ~40% of parent) would also need a citable `fm`, not a plasma
  ratio.

### Metabolite-pair candidates — three shipped, two still deferred

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

- **Allopurinol → oxypurinol — SHIPPED 2026-07-10** (`compounds/allopurinol.json`; the third
  parent→metabolite pair and the FIRST to exercise the engine's **oral-parent** metabolite path
  on real data — cefotaxime's parent is IV, diazepam's is 2-comp). The flagship "active
  metabolite dominates" case: allopurinol is short-lived (t½ ~1.5 h) and largely a prodrug for
  oxypurinol, which peaks later, higher (~6.5 vs ~3 µg/mL for a 300 mg oral dose) and outlives
  it by more than a day (t½ ~18 h). Curated from the FDA Zyloprim label (absorption ~90%, peak
  timing and levels, half-lives, renal elimination) + the Day & Graham 2007 clinical-PK review
  (bioavailability, volumes, fraction converted, dose-proportionality). The three gates: (1)
  **linearity** clears with a documented edge — dose-proportional over 100–300 mg, oxypurinol
  steady-state linear 50–600 mg/day with only a "weak indication of saturation" at 900 mg/day
  (its tubular reabsorption is urate-like; propofol-style clinical-range approximation). (2)
  **allopurinol's own Vd** — the review's apparent Vd/F 1.31 L/kg *under*-predicts the labeled
  Cmax, so a Cmax-consistent ~0.65 L/kg true volume (with F = 0.90 explicit) is used (the
  diphenhydramine posture). (3) **fm** is citable — the review's "90 mg oxypurinol per 100 mg
  allopurinol" (~90%), a single number, not a urinary-recovery floor. **The honesty-critical
  caveat is pre-systemic conversion:** allopurinol is metabolised by xanthine oxidase / aldehyde
  oxidase, present in gut and liver, so some oxypurinol forms first-pass rather than from
  circulating parent — a component the systemic-formation engine cannot separate. It shows up two
  ways, both documented in the compound `notes`: the modelled metabolite peaks later (~7 h vs the
  label's ~4.5 h), and the metabolite apparent volume is set ~20% below the review's ~0.53 L/kg
  to reach the measured Cmax. The reconciliation: the model is anchored to the label's directly
  measured oxipurinol Cmax, so the plotted magnitude matches even though the mechanism is partly
  pre-systemic. This is the **screening property** for prodrug→active pairs: conversion must be
  substantially systemic (allopurinol IN — parent genuinely circulates, ~90% absorbed) not
  first-pass (oseltamivir OUT — see below).
- **Oseltamivir → oseltamivir carboxylate (Ro 64-0802) — DEFERRED (pre-systemic conversion, not
  representable).** A tempting prodrug→active-metabolite antiviral pair, but the FDA Tamiflu label
  disqualifies it structurally: "at least **75% of an oral dose** reaches the systemic circulation
  **as oseltamivir carboxylate**, while exposure to oseltamivir is **less than 5%** of the total
  exposure after oral dosing," with ~90% conversion by **hepatic** carboxyl esterases (first-pass).
  The engine forms the metabolite from the **systemic** parent's elimination, but here the parent
  barely circulates (<5%) and ≥75% of the metabolite arises pre-systemically — so a systemic-
  formation model would show a tiny parent line and could not legitimately produce a metabolite
  that is 75% of the dose. (Separately, "75% of dose" is a fraction-of-dose ≈ fm·F, not the engine's
  fm = fraction of parent *elimination*.) This is the mirror image of allopurinol: same prodrug
  shape, opposite systemic/first-pass split. Stays parked — the mechanism, not a number, is the
  blocker.

The multi-compartment §12 engine extension unblocked diazepam, and cefotaxime then shipped as a
one-compartment collapse; allopurinol→oxypurinol now adds the oral-parent path (all above).
**Procainamide still waits** — not on the parent's compartmental structure (now representable) but
on a citable single-value `fm` (procainamide→NAPA formation is acetylator-bimodal, 7–34% urinary
recovery, so `fm` is not one number).

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

### Phase-7 seed expansion (antimicrobials) — 3 compounds added 2026-07-10

A third pass added **metronidazole, levofloxacin, acyclovir** (20 → 23 compounds; 384 tests
green), all clean linear one-compartment antimicrobials. This pass introduced the `F·D/V`
**ceiling test** (see Sourcing rules) as an explicit pre-write gate — it decided all three
of these AND the two deferrals (ciprofloxacin, sildenafil) above. Each shipped compound was
magnitude-checked against the built engine curve.

- **Metronidazole (`compounds/metronidazole.json`) — clean linear one-compartment, oral +
  IV, ~100% oral bioavailability.** A distinct antibacterial class (5-nitroimidazole) and a
  near-textbook clean drug: complete, food-insensitive absorption means oral and IV Cmax
  nearly coincide (the ~100%-F teaching point, contrast atenolol ~50% and acamprosate ~11%).
  FDA Flagyl tablets label for disposition + oral params (t½ ~8 h, Tmax 1–2 h,
  dose-proportional 250→6 / 500→12 / 2000→40 mcg/mL, <20% protein binding); Vd from the
  Clinical Pharmacokinetics of Metronidazole review (label prints none). Vd 0.55 L/kg — near
  the low end of the reported 0.51–1.1 L/kg Vss range, the Cmax-consistent choice: the engine
  500 mg oral peak is 11.4 mcg/mL vs the labeled ~12 (a shallow distribution phase makes Vss
  slightly overstate the plasma-peak volume). The active hydroxy metabolite is noted but NOT
  modelled — the label gives no clean single fraction-formed (a plasma/AUC presence, not fm),
  the same reason procainamide→NAPA stays deferred.
- **Levofloxacin (`compounds/levofloxacin.json`) — the clean fluoroquinolone (shipped in
  ciprofloxacin's place).** FDA Levaquin label throughout: F ~99%, Tmax 1–2 h, Cmax 5.1 mcg/mL
  (500 mg) / 9.3 mcg/mL (750 mg), Vd 74–112 L (stored in absolute litres, like the 3-comp
  compounds), t½ ~6–8 h, 24–38% protein binding, explicitly linear. **This is the ceiling
  test's positive case:** `F·D/V = 0.99·500/82 ≈ 6 mg/L`, comfortably above the 5.1 mcg/mL
  Cmax, so the one-compartment collapse reproduces the peak (engine 500 mg oral peak 5.08 vs
  5.1) — where cipro's ceiling failed. Vd 82 L is the Cmax-consistent value within the labeled
  74–112 L range; the 500 mg Cmax is the magnitude anchor (the 750 mg datum is slightly
  supra-proportional in that dataset, wide SDs). Oral + IV both real; near-identical exposure
  (like metronidazole).
- **Acyclovir (`compounds/acyclovir.json`) — an antiviral (new class); shipped IV-ONLY.** A
  renally-cleared IV drug reinforcing the atenolol/vancomycin/gentamicin renal-elimination
  thread. FDA acyclovir-injection label (t½ 2.5 h at CrCl >80; steady-state peak/trough 9.8 /
  0.7 mcg/mL for 5 mg/kg q8h 1-h infusion; dose-proportional; 9–33% protein binding; 62–91%
  renal); Vd ~0.7 L/kg Vss from the de Miranda & Blum clinical-pharmacology review (label
  prints none). Vd 0.55 L/kg is the Cmax-consistent value below the tissue Vss (engine
  steady-state peak 8.9 vs labeled 9.8 mcg/mL, ~9% under; acyclovir is mildly two-compartment).
  Two deliberate route choices: **oral is OMITTED** because oral acyclovir has *saturable*
  absorption (F falls with dose — the valacyclovir rationale; a plainly-linear oral line would
  be quietly wrong on the absorption side, though disposition stays linear); and **iv_bolus is
  `available: false` (inferred)** because acyclovir must be infused slowly — a rapid bolus can
  crystallise in the renal tubules. Clearance is deliberately NOT stored (fixed Vd + t½ makes
  ke = CL/Vd a circular cross-check — the cetirizine rule).

### Phase-7 seed expansion (new classes + teaching axes) — 3 compounds added 2026-07-10

A fourth pass added **ethosuximide, famotidine, warfarin** (24 → 27 compounds; 390 tests
green), all clean linear one-compartment drugs, each earning a *distinct* teaching slot. Every
value was pulled from a source opened this session (labels/SmPC/reviews — the sourcing gate);
each was ceiling-tested pre-write and magnitude-checked against the built engine curve.
**Theophylline was evaluated and excluded** in the same pass — it has capacity-limited
(Michaelis–Menten) elimination at/above the therapeutic range, the same superposition-breaking
nonlinearity that excludes phenytoin (an exclude-with-rationale, not a ship-with-caveat).

- **Ethosuximide (`compounds/ethosuximide.json`) — a new class (succinimide) and the very-long-
  half-life accumulation teacher.** The first-line absence-seizure drug: near-complete oral
  absorption (F >90%), negligible protein binding (so the volume is unconfounded), first-order
  dose-proportional kinetics. The FDA Zarontin label's Clinical Pharmacology section is thin
  (therapeutic range + mechanism only — no Vd/t½/Tmax), so disposition comes from the **EMC
  SmPC** (t½ adults 40–60 h / children 30 h, Tmax 1–7 h, negligible binding) and the **ethosuximide
  StatPearls chapter** (F >90%, Vd ~0.7 L/kg attributed to Patsalos 2008, ~80% hepatic CYP3A4 /
  ~10–20% renal unchanged, linear). Models the **adult** case (one population, the diazepam/
  lamotrigine discipline). The lesson is accumulation: a 500 mg single-dose peak is ~9 mcg/mL,
  far below the 40–100 mcg/mL therapeutic range because that range is a *steady-state* level —
  and the model reproduces the label's own anchor (20 mg/kg/day ≈ 1400 mg/day lands Css in
  40–100; engine once-daily SS peak ~90 mcg/mL). Oral only (no marketed IV; F≈1 means an inferred
  IV would add little — the lamotrigine posture). Complements phenobarbital/lamotrigine as the
  classic absence drug; NTI flagged (educational annotation).
- **Famotidine (`compounds/famotidine.json`) — a new class (H2-blocker) and the ~43%-F middle
  point.** A textbook clean linear one-compartment renally-cleared drug (65–70% excreted
  unchanged), reinforcing the renal thread (atenolol/vancomycin/gentamicin/acyclovir) with a GI
  indication. FDA **Pepcid label** for disposition + oral params (F 40–45%, Tmax 1–3 h, t½
  2.5–3.5 h, PB 15–20%, linear — "plasma levels after multiple dosages are similar to those
  after single doses"); Vd 1.0–1.3 L/kg from the **Echizen & Ishizaki review** (label prints
  none), as tabulated in StatPearls. Ceiling test clears: `F·D/V = 0.43·40/80.5 ≈ 214 ng/mL`
  above the reported oral Cmax; Vd 1.15 L/kg (mid-range) is the Cmax-consistent choice — engine
  20 mg oral peak 67 ng/mL matches the reported ~67 ng/mL, 40 mg peak 135 ng/mL is
  dose-proportional. Its ~43% F is a useful middle between metronidazole (~100%) and acamprosate
  (~11%): oral Cmax sits well below the IV level (~497 ng/mL C0 for 40 mg) yet exposure is
  dose-stable (absorption incomplete-but-constant, not saturable). One-compartment collapse of a
  shallow biexponential IV profile (metronidazole/cefotaxime posture). The **S-oxide active
  metabolite is NOT modelled** — no citable fraction-formed (metabolic elimination is only 30–35%
  overall, no single fm), the metronidazole-hydroxy / procainamide→NAPA deferral. Oral + both IV.
- **Warfarin (`compounds/warfarin.json`) — the SMALL-VOLUME / HIGH-BINDING axis and a
  three-caveat honesty showcase.** Vd **~0.14 L/kg** (~9.8 L, barely above plasma volume) because
  warfarin is ~99% albumin-bound and stays intravascular — the opposite extreme from propofol's
  Vss ~260 L. A canonical linear one-compartment PK example (CYP2C9/1A2/3A4 metabolism well below
  saturation; the classic teaching dataset). All from the FDA **Coumadin label** (Vd, F "essentially
  completely absorbed", PB 99%, peak <4 h, dual half-life) plus a **single-dose enantiomer study**
  (PMC3555060) for the concentration magnitude (25 mg racemic → ~2.7 mcg/mL total, R 1.34 + S 1.37;
  engine 2.42 mg/L, ~10% under) and enantiomer half-lives. **Three documented caveats** make it the
  showcase: (1) *dual half-life* — the label gives a ~1 week terminal AND a 20–60 h (mean ~40 h)
  *effective* half-life; the file models the **effective ~40 h** because that governs accumulation
  (the lisinopril "use the accumulation-relevant half-life" reasoning; the ~1 week terminal is a
  low-amplitude tail a single-compartment effective model doesn't render). (2) *racemate collapse* —
  one racemic ~40 h collapses R ~51 h / S ~33 h (the atenolol enantiomer note). (3) **the honesty-
  critical one — concentration is NOT effect**: warfarin acts by depleting already-synthesised
  clotting factors, so the label notes peak anticoagulant effect is *delayed 72–96 h*, long after
  the ~3 h concentration peak. The plotted curve is faithful to plasma warfarin and says nothing
  about INR — the clearest case in the set that concentration and effect must not be conflated.
  Oral (F=1, the standard route) + an INFERRED iv_bolus (`available: false` — IV warfarin is no
  longer reliably marketed since the 2020 Coumadin discontinuation, but the disposition is real and
  makes the small-volume high-C0 point cleanly, ~510 ng/mL C0 for 5 mg; the acamprosate/acyclovir
  inferred-IV posture); no infusion. Modeling the effective 40 h over the 1-week terminal is
  clearance-forced (CL = ln2·Vd/t½ ≈ 0.17 L/h at 40 h is warfarin's real ballpark; the 1-week
  terminal with Vd 0.14 would imply an implausible ~0.04 L/h). CYP2C9/VKORC1 recorded under
  `variability` for context (they drive dose requirement and effect, never used to produce a dose).
  NTI flagged.

### Phase-7 seed expansion (renal / metabolite / ion axes) — 3 compounds added 2026-07-10

A fifth 2026-07-10 pass added **pregabalin, allopurinol (+oxypurinol), lithium** (27 → 30
compounds; 392 tests green). Each was advisor-reviewed before any JSON was written, ceiling-
tested where applicable, and magnitude-checked against the built engine curve. Allopurinol is
covered in the metabolite-pair section above (the third shipped pair, first oral-parent
metabolite); **oseltamivir was evaluated and deferred** in the same pass (pre-systemic
conversion — see the same section).

- **Pregabalin (`compounds/pregabalin.json`) — the LINEAR counterpoint to gabapentin's saturable
  absorption.** About as clean a one-compartment drug as exists: no plasma protein binding at all,
  ~90% renal excretion as unchanged drug (negligible metabolism), rigorously linear kinetics. The
  teaching axis is the gabapentin contrast — gabapentin is absorbed by a saturable intestinal
  transporter so its oral F *falls* with dose (dose-DEPENDENT, nonlinear, keeps it out of a linear
  model), whereas pregabalin's F is ">=90% and independent of dose" (FDA Lyrica label) and Cmax/AUC
  "increase linearly" across 25–900 mg. Same indication and molecular target (α2δ calcium-channel
  subunit), dose-stable superposable curve. All from the FDA label except a bioequivalence-study
  Cmax anchor. Vd 0.5 L/kg, t½ 6.3 h, Tmax 1.5 h, F 0.9, oral only. Magnitude: 300 mg oral →
  engine peak 6.5 µg/mL vs reported ~7.4–7.8 (~13% under — pregabalin absorbs fast and eliminates
  slowly, so the real Cmax sits right at the F·D/V ceiling and a smooth single-ka Bateman lands just
  below it; acyclovir posture, documented). Like lithium, **no metabolite** (renally cleared
  unchanged) — a clean feature, not a gap.
- **Lithium (`compounds/lithium.json`) — the only INORGANIC ION in the set; a new class (mood
  stabilizer) and the archetypal renal / NTI drug.** Modelled **two-compartment** (user's choice)
  so the real distribution phase is faithful; it complements digoxin (the other distribution-phase
  teacher) on the opposite axis — digoxin has a huge tissue Vd, lithium's is tiny (~total body
  water). Three distinct teaching points: (1) **not metabolized** — an element, neither metabolized
  nor protein bound, excreted unchanged renally in proportion to serum level, so there is NO
  metabolite line and no hepatic variability (the limiting-case counterpoint to the metabolite
  compounds); (2) **renal / sodium-dependent NTI** — filtered by the glomerulus, ~80% reabsorbed in
  the proximal tubule with sodium, so Na depletion / thiazides / dehydration raise levels (therapeutic
  0.6–1.2 mEq/L, toxicity not far above); (3) **the standardized 12-h serum sample** — drawn at 12 h
  by convention precisely to wait out the distribution phase (α t½ ~1.4 h) modelled here. Curated
  from the FDA lithium-carbonate label + **Arancibia et al. 1986** (Int J Clin Pharmacol Ther
  Toxicol; PMID 3089949 — eight healthy volunteers, the directly-reported two-compartment
  micro-parameters). CL and Vc are read straight from that paper (ClB 0.0241 L/h/kg, Vc 0.224 L/kg);
  Q and Vp are **derived offline diazepam-style** from the self-consistent subset (α t½ 1.40 h,
  β 0.0435/h → k10 0.1076, k21 0.2002, k12 0.2308 → Q 0.05171 L/h/kg, Vp 0.2583 L/kg; the engine
  round-trips α t½ 1.40 h / β t½ ~15.9 h, and Vc+Vp 0.482 reproduces the paper's Vss 0.445 L/kg).
  **Units are a documented modeling choice** (and an extra honesty point): lithium's clinical
  quantity is the Li+ ION in mEq/L (=mmol/L), dosed as lithium CARBONATE (two Li+ per formula unit),
  so the engine models **elemental lithium in mg** and the mmol/L conversion is /6.94 (1 mEq/L =
  6.94 mg/L; a 300 mg Li₂CO₃ tablet = 56.4 mg elemental Li). Magnitude: 900 mg/day Li₂CO₃ → SS
  peak ~0.73 mmol/L (1200 mg/day → ~0.97), single 300 mg → transient peak ~0.36 mmol/L at 1 h then
  the distribution-phase fall. Oral, immediate-release only. (Curation note: the compartmental
  micro-values were initially mis-attributed to an unverified from-memory citation; caught in
  advisor review and re-sourced to the verified Arancibia 1986 paper — never ship a citation you
  did not open.)

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
