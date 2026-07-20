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
- **The metabolite AUC-ratio check — a closed form, so never quote it from memory.**
  For any linear parent → metabolite pair, `AUC_p = F·D/CL_p` and
  `AUC_m = fm·F·D/(k_m·Vd_m)`, so the exposure ratio collapses to
  **`molar AUC_m/AUC_p = fm_MOLAR · CL_p/CL_m`** — independent of route, dose, `ka`
  and (for the molar ratio) of the MW conversion, which cancels exactly: the ×MW_m/MW_p
  factor enters via the stored mass `fm` and leaves again converting mass AUC back to
  molar. So the ratio a curator claims in `notes` is *arithmetic*, checkable in one line
  without building anything: procainamide/NAPA is `0.40 × (40.4/9.70) = 1.67`. Two traps
  this closes. (1) **Quote the 0→∞ ratio, and expect the plotted window to read under it**
  — an elimination-limited metabolite is still collecting its tail at the horizon
  (NAPA reads ~1.64 over a 48 h window vs 1.67 to infinity), so a horizon-truncated number
  is not a discrepancy to chase. (2) **"Metabolite exceeds parent" is three different
  claims** — higher Cmax, a crossover, or higher AUC — and they do not imply one another:
  NAPA's peak is *below* procainamide's (1.7 vs 2.9 mg/L) yet it crosses at ~4.5 h and its
  AUC is 1.67×. Say which one you mean. Note `AUC_m` does **not** depend on `CL_p`, so a
  phenotype that changes parent clearance moves the two AUCs by *different* factors (slow
  acetylator: NAPA's AUC exactly halves with `fm` while the parent's rises ×1.5, so the
  ratio falls ~3×, not 2×). Prose claims like these are invisible to every automated
  check — `npm test`, lint and build all pass with a wrong number sitting in `notes`
  (procainamide carried a stale "~1.8×" against a model that always produced 1.67).

## What "linear" means here — and why it no longer means "excluded"

**This section changed on 2026-07-17, when the nonlinear engine landed.** Read it
before re-litigating any `linear: false` verdict below.

`linear` now means exactly one thing: **superposition is valid** — this compound's
doses may be summed as time-shifted single-dose curves (`dosing.ts`). It used to
double as "we do not ship this", because superposition was the only mechanism the
engine had. That is no longer true. `src/engine/modelsMM.ts` integrates a saturable
compound's whole schedule as an ODE, and **phenytoin, ethanol and theophylline now
ship** as `linear: false`.

Three consequences for curation:

- **Linearity is a property of the `model`, not an independent judgement.** The
  schema cross-checks `linear` against `NONLINEAR_MODELS` and rejects a
  contradiction in either direction. Tagging a drug `linear: false` while leaving
  it on a linear model is now a validation error, not a way to shelve it.
- **A nonlinear compound has NO `disposition` block.** It carries `dispositionMM`
  (Vd, Vmax, Km) instead, and the schema *forbids* a `disposition` alongside it.
  A stored half-life on a saturable drug is not an imprecision but a category
  error — the number changes with concentration. If you cannot find Vmax and Km,
  you cannot ship the compound; a half-life is not a substitute.
- **Take Vmax and Km from the SAME source.** They are correlated estimates, and
  for a compound whose payload is the zero-order slope (`Vmax/Vd`), Vd belongs to
  that source too. Mixing a textbook volume into another study's Vmax silently
  moves the one number that must be right — see the ethanol entry.

Still `linear: false` and **not shipped**, because no one has curated Vmax/Km for
them: **high-dose aspirin/salicylate**, **omeprazole**, **MDMA**, **naproxen**,
**ondansetron** (see the notes below). These are no longer exclusions on
principle — they are *un-curated nonlinear compounds*, and each is now a
candidate for the MM engine if a source gives Vmax and Km. Note that omeprazole
(auto-INHIBITION) and naproxen (concentration-dependent protein binding) are
**not** Michaelis–Menten in shape, so they would need a further model, not just
parameters; **salicylate** is now the plausible next MM ship.

**Theophylline shipped 2026-07-17** — it was on that list, and it is the worked
example of what taking a compound off it costs. Wagner 1985's pooled Vmax/Km was
the missing datum; everything else was already in the repo. Two of its lessons
generalise:

- **A single Vmax/Km may be a LUMPED fit — say so.** Theophylline runs three
  parallel capacity-limited pathways (Tang-Liu 1982: Km 2.7 / 9.3 / 14.2 mg/L)
  plus ~10% first-order renal. A sum of MM terms plus a linear term is **not** an
  MM term, so its stored Km (24.1) is a weighted composite that measures no
  enzyme. That is legitimate — Wagner fitted it to observed clearances as an
  empirical whole-body model — but it is a real limit of the curve and belongs in
  `notes`, not in the gap between them. Salicylate has the same shape.
- **Shipping a compound can FALSIFY prose in files you are not touching.**
  `caffeine.json` and `theobromine.json` both asserted theophylline was excluded;
  both had to flip in the same commit. **Nothing in CI sees this** — `loader.test`
  derives each file's own routes and never compares two files' claims. Before
  shipping, grep the repo for the compound's name.
- **A number from a SEARCH SUMMARY is not a citation — and it is often the
  load-bearing one.** Theophylline's competing Vmax (2,640 mg/day) arrived in a
  web-search blurb and reached shipped `notes` in three places before anyone had
  identified the study, let alone opened it. It was not decoration: the whole
  "Wagner is bracketed, not an outlier" argument rested on that second fit
  existing. All three gates were green over it, because *every automated check is
  blind to whether a citation is real*. **The discriminator is simply: does the
  source open?** Fetch it and cite it properly, or delete the number and let the
  argument stand on what you did open — never leave it in as atmosphere. Here it
  opened (Dahlqvist 1984, PMID 6506136) and the argument got *stronger*: the two
  fits bracket both direct clearance measurements. The lesson generalises past
  "verify citations": **the detail you are least sure of is disproportionately
  likely to be the one holding up your confidence.**

### Phenotype presets — curating a polymorphic compound (2026-07-17)

`variability.phenotypes` lets one compound ship SEVERAL illustrative populations
(fast/slow acetylator, poor/extensive metaboliser) and lets the reader switch. It
replaces "anchor one phenotype, put the other in prose" — but it does not replace
**anchoring**, which still governs each preset individually. Shipped on
procainamide (NAT2); `geneticFactors` was a bare label before this and is now
cross-checked against the presets.

**What it is, mechanically.** `applyPhenotype(compound, id)` in `derive.ts` is a
pure Compound→Compound transform applied BEFORE derivation. The engine never
learns what a genotype is — by the time a model function runs, the phenotype has
collapsed into ordinary numbers. Adding a preset needs **no engine change**.

- **The default preset must override NOTHING.** `presets[0]` IS the compound's
  base values (schema-enforced), so the default render is the pre-preset compound
  *by construction* rather than by reconstruction, and `applyPhenotype` returns the
  same object. Put the contrasting phenotype in a later preset. This is what makes
  "presets didn't change the shipped curve" provable instead of hopeful.
- **Every preset is a separately-cited population, not a multiplier.** Each
  override is a full parameter (value + unit + derived + sourceRef + conditions).
  Prefer both phenotypes from ONE study/design — procainamide takes fast 2.4 ± 0.7 h
  and slow 3.6 ± 1.0 h from the same Wierzchowiecki 1980 arm, and declines Bauer's
  longer slow t½ (~5.2 h) precisely to keep the pair comparable.
- **Override only what the polymorphism touches.** Lima 1979 found procainamide's
  Vd unaffected by acetylator status, and NAPA is renally cleared (not acetylated),
  so neither preset touches Vd or NAPA's own disposition. A preset that quietly
  moves an unaffected parameter is inventing data.
- **The half-life band stays inside its own preset** (the pre-existing catch,
  unchanged). Crossing populations is the preset's job — it swaps t½ and fm
  atomically, so the mixed state is unreachable rather than merely discouraged.
- **`clearance` must not be stored on a compound with a half-life preset.**
  `resolveKe` prefers a stored CL over half-life, so the override would be
  silently discarded and the curve would not move. The schema rejects this — but
  note the general shape of the trap: an override that is *ignored* looks exactly
  like a feature that works, since nothing errors.
- **Cross-check the pair for internal coherence.** Procainamide's two presets come
  out consistent: Lima's CL ratio 22.6/34.8 = 0.65 vs the t½-implied 2.4/3.6 = 0.67,
  within 3% — evidence the phenotypes are one model, not two studies stitched
  together. Report it; do NOT store CL to "prove" it (circular).
- **The UI copy is a gate, not polish (bright line).** A control that switches
  genotype-driven curves sits close to the line. It must offer illustrative
  POPULATIONS to look at ("Illustrative population (NAT2)"), never solicit the
  user's own genotype. `tests/ui/phenotype-picker.test.tsx` asserts the copy.

**The teaching payoff, and why it justifies the machinery.** Procainamide's two
presets move parent and metabolite in OPPOSITE directions: slow acetylators show
~1.5× the parent exposure (AUC = F·D/CL) but ~0.5× the NAPA (AUC_m = fm·F·D/(k_m·Vd_m),
which is *independent* of the parent's disposition, so the fm ratio alone sets it).
The NAPA/parent AUC ratio flips across the toggle — 1.95 (NAPA dominates) to 0.65
(parent dominates). Both ratios are exact closed forms, so they are oracles rather
than magnitude eyeballs (`tests/data/phenotype.test.ts`). "A slow metaboliser has
more drug in them" is only half true once the metabolite is active, and this is the
compound that shows it.

### Curating a Michaelis–Menten compound — the extra gates

- **Oral needs an explicit, cited `ka`.** Every linear resolver estimates a
  missing ka by inverting `Tmax = ln(ka/ke)/(ka − ke)`. That inversion does not
  exist under saturation: there is no `ke`, and **Tmax is itself dose-dependent**
  (a bigger dose saturates elimination and pushes the peak later), so a reported
  Tmax is a property of the compound *at one dose*. `deriveParamsMM` throws rather
  than fabricate the dose. No citable ka ⇒ omit the oral route (phenytoin) — do
  not substitute a Tmax.
- **Vmax comes in two unit families; store what the source printed.** A mass rate
  (`mg/day`, `mg/kg/day` — phenytoin) or the zero-order concentration slope
  `Vmax/Vd` (`mg/dL/h` — ethanol's forensic β60). `derive.ts` multiplies the
  latter by Vd and records it as derived. Do not pre-convert offline; that hides
  the arithmetic from the reader.
- **The magnitude check is the STEADY STATE, not the peak.** `Css = R0·Km/(Vmax − R0)`
  is exact, algebraic, and contains **no Vd** — so it is the honest test of Vmax
  and Km, and it is unmoved by the volume (often the softest input). Check it
  against the therapeutic range at real maintenance rates. There is no steady
  state at all for `R0 ≥ Vmax`.
- **Set `illustrativeDoseMg` when the generic 500 mg opening would lie.** A
  saturable compound plotted below its Km renders as an ordinary exponential —
  its whole point invisible before the user touches anything. It states scale, not
  a recommended dose.

### Nonlinear / ceiling deferrals — naproxen, ondansetron, escitalopram, sotalol, isoniazid (2026-07-13)

Five candidates evaluated in the 2026-07-13 pass and NOT shipped, each failing a
specific gate. Documented so they aren't re-litigated (a documented defer is a
first-class output, not a failure). The three that DID ship that pass — lorazepam,
zolpidem, glipizide — are in the seed-expansion section below.

- **Naproxen — EXCLUDED, `linear: false` (concentration-dependent protein binding).**
  Naproxen's AUC is dose-proportional only **up to ~500 mg**; above that the unbound
  fraction rises (it is >99% albumin-bound at therapeutic levels, near saturation), so
  total clearance and volume increase and AUC rises _less_ than dose-proportionally.
  Because standard dosing is 500 mg BID, the nonlinearity sits right at the top of its
  own therapeutic range and would corrupt the multi-dose accumulation view — the same
  superposition problem as theophylline/omeprazole. (Contrast **glipizide**, shipped
  this pass, also ~99% protein-bound but LINEAR: its therapeutic plasma levels are
  ng/mL — a thousandfold below binding saturation — so its bound fraction stays constant.
  Same 99%-bound headline, opposite verdict, because of _where_ on the binding curve the
  drug sits.) Secondary reason not to force it: its small-Vd/high-binding axis overlaps
  warfarin's; the only non-redundant framing was the within-NSAID contrast, not enough to
  outweigh the linearity failure.
- **Ondansetron — EXCLUDED, `linear: false` (saturable first-pass metabolism).** A 5-HT3
  antiemetic and a genuinely new class, but its systemic exposure does **not** rise
  proportionally to dose: the FDA label reports the 16 mg AUC is ~24% greater than
  predicted from 8 mg, because first-pass metabolism saturates as dose increases (so oral
  bioavailability climbs with dose across 8/16/32/64 mg). That is a superposition
  violation in the therapeutic range — the omeprazole class. (Contrast **zolpidem**,
  shipped this pass, whose first-pass loss is a _fixed_ ~30% across its therapeutic range.)
- **Escitalopram — DEFERRED (F·D/Vss ceiling fails; genuinely two-compartment).** A clean
  linear SSRI (dose-proportional 10–30 mg) with a rare true-IV dataset (Søgaard 2005:
  systemic CL 31 L/h, Vss 1100 L, F ~80%, terminal t½ 27–33 h), and it would have been a
  strong long-t½ accumulation teacher. But it **fails the `F·D/V` ceiling test** exactly
  like sildenafil: the observed single-dose 10 mg Cmax is ~9.85 ng/mL, while `F·D/Vss =
  0.80·10000 µg / 1100 L ≈ 7.3 ng/mL` — the one-compartment ceiling sits _below_ the
  observed peak. Reproducing the peak in one compartment needs V ~840 L (the central
  volume), which then forces an implied CL of ~19 L/h vs the measured 31 → a hidden ~60%
  AUC over-prediction that would distort the multi-dose view. It is genuinely
  two-compartment and no clean single-population two-compartment set was sourced. Parked
  pending a citable distribution-phase parameterisation. (Its weakly-active desmethyl
  metabolite S-DCT is low-concentration and not worth a line even if it shipped.)
- **Sotalol — DEFERRED (explicitly two-compartment; oral-collapse not vetted).** A clean,
  linear (dose-proportional 160–640 mg/day), renally-cleared β-blocker/class-III
  antiarrhythmic with no metabolism, no protein binding and no active metabolite — it would
  have been a tidy renal counterpoint to procainamide (hepatic acetylation + active NAPA).
  But the FDA label describes it as two-compartment (central + peripheral), and unlike
  glipizide the distribution volume is not negligibly close to Vss, so the oral
  one-compartment collapse (procainamide/cefotaxime posture) would need a proper ceiling +
  Cmax check that was not completed this pass. Parked as a plausible future ship (oral-only
  1-comp, once the collapse is vetted), not an exclusion.
- **Isoniazid — DEFERRED (linearity unconfirmed + redundant + weak differentiator).** It
  is a one-compartment antitubercular whose NAT2 acetylator polymorphism (fast t½ ~1 h /
  slow ~3 h) tempts a reprise of procainamide's phenotype-anchoring. Three problems: (1)
  acetylation is saturable and isoniazid shows dose-dependent kinetics at higher doses, so
  therapeutic-dose linearity would need explicit confirmation; (2) it **re-teaches
  procainamide's exact lesson** (NAT2, bimodal half-life, one illustrative phenotype) — the
  set already has that exemplar; (3) the intended differentiator ("its acetyl metabolite is
  inactive, unlike active NAPA") is shaky — acetylisoniazid can be hydrolysed back, and the
  hepatotoxic species (acetylhydrazine) and the acetylator↔hepatotoxicity link are contested.
  Parked; a compound in a truly new class is a stronger use of a slot than this reinforcement.

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
  clearance-defined. **Oral shipped 2026-07-17** — see the age-anchoring section below, which
  also corrected `Vc` 0.3 → 0.25 L/kg.
- **Procainamide → NAPA — SHIPPED 2026-07-11** (`compounds/procainamide.json`; the 40th
  compound and the pharmacogenetics pair — reverses this former rejection, see the procainamide
  section below). Both original objections dissolved: (1) the "2-compartment" objection was an
  IV-only property — procainamide given ORALLY reads as one-compartment (absorption masks the
  ~5 min distribution phase, the cefotaxime/ibuprofen collapse), so it ships oral-only 1-comp and
  the biphasic IV route is omitted; (2) the "bimodal fm" is handled by anchoring a single
  illustrative FAST-acetylator phenotype (fm 0.40 formation-clearance, Lima 1979) with the
  slow-acetylator case as documented prose contrast — the polymorphism becomes the teaching point,
  not a disqualifier. NAPA's own disposition is directly measured (it was marketed as acecainide),
  so no assumed-volume problem.
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
  shape, opposite systemic/first-pass split. **UPDATE (2026-07-10):** the `firstPassFraction` engine
  now *can* represent a purely-pre-systemic metabolite, so the mechanism is no longer the blocker —
  but oseltamivir was then rejected on the **first-pass timing screen** (its carboxylate is
  formation-rate-limited, Tmax ~6 h ≫ parent 0.5 h; the single-`ka` model would invert its shape).
  See "Oral first-pass metabolism" below for the full timing-screen rejection; morphine shipped in
  its place.

The multi-compartment §12 engine extension unblocked diazepam, and cefotaxime then shipped as a
one-compartment collapse; allopurinol→oxypurinol now adds the oral-parent path (all above).
**Procainamide still waits** — not on the parent's compartmental structure (now representable) but
on a citable single-value `fm` (procainamide→NAPA formation is acetylator-bimodal, 7–34% urinary
recovery, so `fm` is not one number).

### The age/covariate-anchoring screen — diazepam oral (2026-07-17)

A reusable screen for any **multi-source compartmental set** (a 2-/3-comp compound whose CL, Vc,
α and β come from different papers). Diazepam is the worked example, and it caught a real defect.

**The screen.** When a source publishes its parameters as **regressions on a covariate** (age,
weight, renal function) rather than as single numbers, don't read off a "representative" value —
**invert your existing values through the regressions and check every parameter implies the SAME
covariate value.** A set that silently mixes two ages is not one population, and the file's own
"keep all inputs to one population" rule is then broken invisibly.

Diazepam's set was constructed from Klotz 1975 (structure, β), Greenblatt 1980 (CL) and CHEMM/FDA
(α). Klotz's Table II publishes each parameter against age, so the inversion is arithmetic:

| parameter | file's value | Klotz regression | implied age |
| --- | --- | --- | --- |
| t½(β) | 33 h | `t½(β) = 1.094·age + 2.26` | **~28 y** |
| CL | 27.3 mL/min | `CL = 32.52 − 0.186·age` | **~28 y** |
| Vc (V1) | 0.30 L/kg | `V1/kg = 0.0061·age + 0.08` | **~36 y** ✗ |

Two parameters agreed on 28 y; `Vc` sat at 36 y. It was the one input carrying **no source** — a
"customary young-end value" — and it was *documented as illustrative*, which is exactly why it
survived: **an honest caveat is not a substitute for a source, and it stops protecting you the
moment the parameter becomes load-bearing.** While only IV shipped, Vc merely scaled an early peak
nobody checked. Adding oral made Vc set the *oral peak* — a landmark with citable values — and the
inconsistency became visible immediately. Fix: `Vc = 0.0061·28 + 0.08 = 0.25 L/kg`, `derived: true`
(computed from a published regression, not read off), with Q and Vp re-derived from it.

**Carry-forwards, each of which cost a wrong turn to learn:**

- **Re-derive the dependent parameters when you move a parameter.** A first sweep varied `Vc` while
  holding `Q`/`Vp` fixed — but the file *derives* `Q`/`Vp` **from** `Vc`. That sweep showed Cmax
  peaking ~370 ng/mL and concluded the target was unreachable at any `Vc` — a **false deferral**.
  Re-deriving `Q`/`Vp` per candidate made Cmax monotonic in `Vc` and reachable. An
  internally-inconsistent sweep will happily "prove" a compound is impossible.
- **Don't fit the parameter to the landmark you're checking against.** `Vc = 0.20 L/kg` reproduces
  Locniskar's 394 ng/mL Cmax to within 1% — tempting, and wrong: 0.20 is Klotz's V1 at **age 20**,
  which drags t½(β) to ~24 h and contradicts the file's 33 h. Fitting also makes the magnitude check
  **circular**. Source the parameter independently, then *report* the resulting Cmax.
- **Check a reported Cmax against the SPREAD, not a single study.** Klotz's own oral arm reports
  peaks of **221–440 ng/mL** — a 2× inter-individual range. Locniskar's 394 is one study near the
  top of it, so a model at 255 ng/mL is not "35% wrong", it is mid-spread. A same-paper,
  same-population range beats a tighter cross-population point estimate.
- **Name the quantity before storing it.** Klotz's F ≈ 75% is **bioavailability** (oral-vs-IV AUC);
  the FDA label's ">90%" is **absorption**. They are not in conflict and must not be averaged — they
  reconcile at ~15–20% first-pass loss. The engine's `F` is bioavailability.
- **Moving a disposition parameter edits every shipped route.** `Vc` sets IV-bolus `C(0) = D/Vc`
  (333 → 400 ng/mL here) and feeds the metabolite formation modes — verify all routes, not the new
  one. Here it is self-validating: `V1` is *defined* as `Dose/C(0)`, so Klotz's V1 sets `C(0)`.
- **Record the residual.** Taking α from CHEMM/FDA (~1 h) rather than Klotz leaves `k12/k21 = 2.99`
  vs Klotz's reported 2.75 (~9%), and Vss 1.00 vs Klotz's own 0.90 at age 28. Klotz-internal
  consistency would imply α t½ ≈ 1.5 h. Accepted and written down; α is now the set's softest input.
- **A dead citation URL is invisible to every check.** The `fda_label` URL 404'd; the live label
  (DailyMed `setid=554baee5`) had to be re-found and the entry corrected — and it turned out to say
  Vd(ss) **0.8–1.0 L/kg**, not the "~1 L/kg" the file paraphrased, and the stored range `[0.7, 1.3]`
  matched no source at all. Re-open cited URLs when you touch a compound.

Two oral simplifications are documented rather than hidden: absorption is modelled single-`ka`
though Klotz found it **biphasic** (an "absorption nose"), and the oral nordiazepam line forms
**systemically only** — cleared on Klotz's observation that oral desmethyldiazepam's profile "was
comparable to that observed after intravenous", and `ffp` is unavailable anyway because nordiazepam
peaks at 24–48 h vs the parent's 1 h (it fails the first-pass timing screen below). With `F = 0.75`
that line sits ~25% under the IV one — bounded, directional, and stated in the compound notes.

### Oral first-pass metabolism — engine capability LANDED (`firstPassFraction`); first compound: oral morphine (2026-07-10)

The engine now models **pre-systemic (first-pass) metabolite formation** — the wall that had
DEFERRED oseltamivir and every oral route whose bioavailability loss is first-pass conversion to a
metabolite (oral morphine, oral nicotine, oral ketamine, psilocin). It is an **engine-first spike**
(the metabolite / oral-2c / 3c-Stage-B rhythm): engine + oracles + collapse regression green, **no
compound curated this pass** — the flagship candidates (oseltamivir, oral morphine) are a separate
advisor-reviewed curation pass against the honesty gate below.

**The mechanism.** `F` was always the *systemic* bioavailable fraction; the `(1 − F)` lost to
first-pass simply vanished (became nothing) and metabolites formed only from the *systemic* parent
(`fm·CL·C_p`). So first-pass is only ever *visible* through a metabolite line. The new optional
per-metabolite **`firstPassFraction` (`ffp`)** routes the pre-systemic mass to the metabolite: a
fraction `ffp` of the oral dose appears as an oral-absorption input directly into the metabolite
compartment, at the **parent's absorption rate `ka`** (hepatic conversion is fast relative to
absorption — the standard simplification, stated in the engine header). It is a single additive
Bateman term `batemanMode(ka·ffp·D, ka, k_m, t)/Vd_m`, **oral-route only** (IV bypasses first-pass,
so the bolus/infusion metabolite paths ignore `ffp`). Total oral metabolite exposure is therefore
`AUC_m = (fm·F + ffp)·D/(k_m·Vd_m)` — the systemic term plus the pre-systemic term, the latter
independent of `ka`. **Collapse anchor:** `ffp` absent/0 reproduces every current curve *byte-for-
byte*, which is what protects all 39 shipped compounds (an oracle test asserts `.toBe`, not
`.toBeCloseTo`). A **purely pre-systemic** metabolite (`fm = 0, ffp > 0`) — the oseltamivir shape,
parent barely circulates — computes cleanly; the derive guard now allows `fm = 0` when `ffp`
carries the formation.

**The honesty gate (the load-bearing curation rule).** The question is **"is `ffp` for *this
specific* metabolite citable?"** — the same cite-or-defer posture as `fm`. Partial attribution is
fine *if sourced*: if nicotine's first-pass mass splits across cotinine + other products, cotinine
gets only its *sourced* share, not all of the extracted mass (attributing the whole extraction to
one modelled product over-predicts — the `F·D/V`-ceiling-test discipline). Two mass-balance rules
for the curator:
- **Do NOT also shave `F`.** `F` is already the systemic fraction; `ffp` is purely additive to the
  metabolite. "Accounting for" first-pass by *also* reducing `F` double-counts the same extracted
  mass. Leave `F` at the sourced systemic bioavailability and add `ffp` on top.
- **Mass balance bounds it:** `ffp ≤ 1 − F − f_unabsorbed`. The extracted-and-converted fraction
  cannot exceed what was absorbed but did not reach systemic circulation. The engine does **not**
  enforce this (it is a curation-pass check) — verify it by hand when curating a first-pass pair.
- **MW-adjust a molar fraction to mass**, exactly like `fm` (the caffeine/morphine convention): the
  engine's `ffp` multiplies parent *mass*, so a molar first-pass fraction is `× MW_m/MW_parent`.

**The first-pass TIMING screen (the `ffp` analogue of the `F·D/V` ceiling test — check it FIRST,
before sourcing anything else).** The `ffp` term routes the pre-systemic mass at the *parent's*
absorption rate `ka`, i.e. it assumes **hepatic conversion is fast relative to absorption**, so the
modelled metabolite peaks near the *parent's* Tmax. Before committing to an `ffp` pair, confirm the
real data agree: **metabolite Tmax ≈ parent Tmax** (within, say, ≲1.5×). If the metabolite's
appearance is *formation-rate-limited* (it peaks much later than the parent), the single-`ka`
instant-conversion model **inverts its shape** — drawing an early spike where reality is a slow rise
— and no prose caveat rescues a chart that teaches the wrong temporal story. This is a
*refuse-don't-mislead* screen, not a document-with-caveat one. It killed the flagship candidate
(oseltamivir, below); it passed morphine (glucuronidation is fast: subcutaneous glucuronide Tmax
~0.25–0.6 h ≈ parent). One datum decides it.

The honesty panel renders `ffp`: `metaboliteProvenanceEntries` emits a **"First-pass fraction (ffp)"**
row (between fm and Vd) with its measured/derived badge + citation, so a sourced `ffp` reaches the
bibliography exactly like `fm`. (This was wired with the engine — a sourced parameter whose citation
never rendered would silently undercut the gate above.)

**`ffp` is an illustrative population constant** (a literature fraction, like the 70 kg reference
subject), not a patient covariate — the bright line holds. Frame it that way in the compound prose.

**First shipped `ffp` compound: oral morphine → M3G + M6G (2026-07-10).** Oral morphine was added to
the already-shipped IV morphine as the first `ffp` curation — and the *general* case (`fm > 0` AND
`ffp > 0`: systemic glucuronidation *plus* first-pass), stronger than oseltamivir's degenerate
`fm ≈ 0` would have been. Each glucuronide's `ffp` is derived from the **same single population** as
its `fm` (Hasselström 1993): `ffp_i(molar) = fm_i(molar) × (1 − F)` — the first-pass loss `1 − F`
(F = 29.2%) apportioned by that glucuronide's molar formation-clearance share — then MW-adjusted
`×1.617`: **M3G 65.6%, M6G 11.9%**. `fm·F + ffp = fm` is a **construction identity** (because
`ffp := fm·(1−F)`), so the built-curve match (oral M3G AUC 2.159 ≈ IV 2.158) is an engine-*wiring*
check — the oral systemic + pre-systemic paths sum correctly — **not** a validation of the `ffp`
value. That rests on the assumption that first-pass UGT2B7 selectivity matches systemic; it doesn't
exactly (first pass is purely hepatic, no renal-unchanged escape), so real first-pass glucuronidation
is a slightly larger share and `ffp` here is a **mild under-estimate** — real oral glucuronide sits
modestly *above* IV, not equal. Independent magnitude check (Osborne 1990): modelled oral
M3G:morphine AUC ratio ~29 (mass) sits at/below the reported ~30 molar (~50 mass), so the glucuronide
total exposure is **conservative, not over-drawn** — the tall ~500 ng/mL M3G Cmax is only the
intrinsic-t½ compressing that AUC into a sharp peak (the documented no-enterohepatic caveat, same as
IV). Mass balance closes (`ffp` molar 0.480 ≤ 1 − F = 0.708). See `compounds/morphine.json` notes.

**Oseltamivir → carboxylate — still DEFERRED, now for a sharper reason (the timing screen, not the
engine).** The `ffp` engine *can* represent a purely-pre-systemic metabolite (`fm ≈ 0`,
`ffp` ≈ ≥75%-of-dose carboxylate), so the engine limit is gone — but oseltamivir **fails the
first-pass timing screen above**: its carboxylate is formation-rate-limited (single-dose oral
data: carboxylate Tmax ~6 h, t½ 6.2 h, vs **parent Tmax 0.5 h**), an ~8–12× violation on the
*dominant* line. The single-`ka` model would peak the carboxylate at ~0.8 h — inverting its
signature slow-rising, persistent shape into an early spike. (AUC stays faithful, Cmax lands only
~24% high, but the *shape* is wrong.) Deferred pending a future `ffp` extension that **decouples the
metabolite input rate from the parent `ka`** (a separate formation rate). This was evaluated as the
intended flagship `ffp` compound and rejected on the timing datum — the reason morphine was shipped
in its place.

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

### Transdermal route — nicotine and fentanyl DEFERRED (2026-07-17), on the input-type screen

The §12 "more routes" seam names transdermal, and the mode spine already computes a
zero-order input (`infusionConcentrationFromModes`), so a patch looks nearly free: it is an
IV infusion with `F < 1`. **Two candidates were gated against opened sources and both failed.**
Recorded so the "a patch is just an infusion" intuition isn't re-litigated from the armchair.

**The screen (reusable — apply it to any extravascular route).** The question is NOT "does the
drug have a depot tail" or "what is its half-life" — it is **what absorption input TYPE did the
source actually fit?** That one fact picks the driver, and it decides ship-vs-defer:

| Input type the source fit | Driver | Verdict |
| --- | --- | --- |
| zero-order (+ lag) with `F` | `infusionConcentrationFromModes`, `r0·F` | ships |
| first-order from a depot (`ka_td`) | `oralConcentrationFromModes`, IV-like `F`, no first pass | ships |
| transit chain / Weibull / multi-phase / parallel paths | neither | **defer** |

- **Nicotine transdermal — DEFERRED (parallel dual release + a transit chain + time-varying CL).**
  The tempting case: `Gisleskog 2021` is ALREADY the file's IV disposition source and its title
  covers transdermal, so the parameters looked in-hand, and a patch bypasses first pass entirely —
  which would dodge the pre-systemic-cotinine problem that deferred oral nicotine (the oseltamivir
  criterion). The source was opened (PMC8016787, free full text; the PubMed abstract alone is not
  enough — the sub-model is a different section). It fits **two parallel release pathways** —
  a fraction `Fr1` first-order at `Krel` 0.146/h, the remainder zero-order — each with its own lag
  (**Lag1 0.53 h, Lag2 4.06 h**), feeding a **chain of transit compartments** (`Ktrs` 3.62/h, mean
  transit time 1.1 h), with **product-specific** parameters (Nicorette `Fr1` 40% / `Frdur1` 44.5%
  vs Invisipatch 71.9% / 96.2%) — so there is no single "nicotine patch" — and a **clearance that
  rises 11.6% from 24 h**, which is not even time-invariant (superposition across a multi-day patch
  schedule would not hold). Transdermal `F` = 75.8%. Three rows down the table at once. The
  alternative source is no better: **Linakis 2017** (PMC5698581) fits an explicit **Weibull**
  absorption (α 3.72, β 1.53) into a depot, and its 1-comp CL 90.4 L/h contradicts Gisleskog's
  67.4 L/h anyway. nicotine.json's standing note — "transdermal ... complex absorption not modelled
  here" — is hereby CONFIRMED with specifics, not overturned.
- **Fentanyl transdermal — DEFERRED (skin depot ⇒ the washout is absorption-rate-limited).** The
  best-looking zero-order case, because the label states the input as a constant rate outright
  (25–100 µg/h) — the zero-order input handed over as data. It fails on the tail: a **cutaneous
  depot** (1.07 ± 0.43 mg still in skin at removal) keeps absorbing after the patch is off, so the
  post-removal apparent t½ (~17 h, range 13–22 h; **43 h in the elderly vs 20 h in the young**) is
  the ABSORPTION rate, not fentanyl's own elimination — flip-flop, the intrinsic-vs-apparent trap
  (morphine/digitoxin). A rectangular window would draw that tail on the wrong rate. Note the
  honesty asymmetry: the patch-ON rise is faithfully zero-order, only the washout is not.

**The seam is NOT dead — the clean case is a continuously-worn patch, and CLONIDINE SHIPPED IT**
(below). If the patch stays on for the whole plotted window, removal is never in frame and the depot
tail cannot be drawn wrong; the curve is the honest "patch = wearable infusion → plateau at `R0/CL`".
Scopolamine (72 h constant delivery) remains an untested candidate on the same screen — a stated
constant delivery rate is necessary but NOT sufficient (fentanyl had one).

### Transdermal SHIPPED — clonidine, the first patch (2026-07-17, 525 tests)

`compounds/clonidine.json` — compound #47 and a new class (central α2-agonist antihypertensive).
**Transdermal-only.** It passes the input-type screen where nicotine and fentanyl failed: the
Catapres-TTS label states the input outright — *"programmed to release clonidine at an approximately
constant rate for 7 days"* — and, worn continuously, its curve never has to draw the part that is
not zero-order. Everything below is from one opened source (DailyMed SPL, setid
`d4a55825-7041-42f4-b3b2-dd7a25dbe793`).

**The engine gained nothing, by design.** `engineRouteOf` (derive.ts) maps `transdermal` →
the engine's `iv_infusion`, and the mode spine computes it for 1-, 2- or 3-comp alike. The engine's
`Route` union deliberately does **not** gain a member — its vocabulary is INPUT TYPES, and a
transdermal branch there would duplicate `iv_infusion`'s math. `DataRoute` (schema.ts) is the wider,
clinical vocabulary; the type split is what stopped a clinical route leaking into an engine call
(the compiler flagged all ~15 sites).

**MAGNITUDE — the free double check (reusable for any zero-order input).** For a zero-order input
`Css = R0/CL` depends on **clearance ALONE, not Vd**. The label's CL (177 mL/min = 10.62 L/h)
against its three stated rates gives 0.392 / 0.785 / 1.18 ng/mL; the label independently reports the
measured steady states as ~0.4 / 0.8 / 1.1. Three for three, from numbers in different paragraphs.
Then check the **approach**, which is where Vd re-enters: `ke = CL/Vz = 0.054/h` → ~90% of plateau by
~2 days, steady state ~3 — against the label's *"steady-state levels are obtained within 3 days"*.
Plateau AND rise both reproduce ⇒ the one-compartment model is earned.

**Why 1-comp is faithful for a patch and would NOT be for a tablet** (the reusable screen). The
label calls clonidine biphasic (distribution t½ ~20 min, terminal 12–16 h) and gives only Vz and CL —
not enough for 2-comp. It doesn't matter here: a zero-order input this slow **never probes the
central compartment** (the 20-min phase equilibrates ~40× over before the concentration moves), so
Vz IS the operative volume. A fast oral absorption does probe it. Generalises: *the slower the input,
the fewer compartments you need.*

- **THE 60% TRAP — made unwriteable, not warned about.** The label states BOTH *"deliver 0.1, 0.2 and
  0.3 mg of clonidine per day"* AND *"absolute bioavailability … approximately 60%"*. Reading those as
  a dose and its bioavailability gives Css 0.235 vs a reported 0.4 — a **~40% low curve that looks
  entirely plausible** and that no test can see. The delivered rate is ALREADY systemic (the Css
  arithmetic proves it), so `TransdermalRouteSchema` **has no `F` field at all** — the same posture as
  `DispositionMMSchema` refusing a `halfLife`. What the 60% IS relative to is deliberately **not
  written down**: the obvious gloss dies on its own numbers (2.5 mg content over 7 days ≈ 0.36 mg/day;
  ×0.6 = 0.21, not 0.1). Record the narrow verified claim, never the plausible gloss.
- **REMOVAL IS OUT OF FRAME — the honesty design.** Clonidine HAS a skin depot: after removal the
  label reports levels persisting ~8 h then declining at an apparent **~20 h** half-life, LONGER than
  its own 12–16 h, because absorption continues. So the horizon is the wear period **exactly** — no
  `niceCeil`, no generic "+5 half-lives" tail, which would draw that decline on the wrong rate
  constant. A test pins it, because on screen that tail would look fine. `displayNote` says so.
  **Clonidine passes not because it has no depot, but because the honest curve never shows it.**
- **ORAL — DEFERRED (fails `F·D/Vz`, and its one source was opened and rejected).** Reported oral
  Cmax ~1 ng/mL for 0.2 mg against a ceiling of `0.2/197` = **1.02 ng/mL even at F = 1** — no
  headroom, the ciprofloxacin/sildenafil failure, and the same cause as the 1-comp screen above (an
  oral dose sees the central compartment). Recorded as pending a source rather than as a settled
  number: the candidate bioequivalence paper (Alsarra 2016, LC-MS) reports **Tmax 30 h and t½ 120 h
  for a REFERENCE immediate-release tablet** (vs the label's 12–16 h) and **contradicts itself** —
  its own AUC∞ of 353 ng/mL·h for 0.2 mg implies CL/F ≈ 0.57 L/h against a tabulated 23.6 L/h, a
  40× gap. The honest fix is 2-comp, not a smaller Vd.
- **A PATCH HAS NO PEAK — caught only by launching the app.** `PeakNote`'s route ternary let
  `transdermal` fall through to the ORAL branch, so the app explained a patch as "rises as it is
  absorbed and falls as it is eliminated; the peak (Tmax) is where those balance" — under a curve
  that never falls. 522 tests and the typechecker were green. **Adding a route to a chain keyed on
  route silently inherits the last branch.** Three surfaces asserted it independently (caption,
  PeakNote, and the chart's marker dot + toggle); fixing fewer would have left the chart
  contradicting the caption. All now read **"End of wear"** — deliberately not "plateau", which is
  true of clonidine (~13 half-lives) but would be false for a future short-wear patch; the marker
  copy is keyed on route, so it must hold for every patch.

**Right-sizing note: "more routes" is mostly data/UI, not engine.** The mode spine already computes
both input types — infusion IS zero-order-in, oral IS first-order-in, and `batemanMode`'s `ka ≈ λ`
guard already covers `ka < ke` flip-flop. What is actually missing is small: `F < 1` on the
zero-order path, an optional lag/time-shift, and a first-order route that skips first pass. An
SC/IM depot route is therefore the **oral driver** with IV-like `F` — a `Route` value, UI, data,
and framing, with no new engine math. Do not bank a new route as new engine capability.

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
nonlinearity that then excluded phenytoin (an exclude-with-rationale, not a ship-with-caveat).
**Both exclusions are SUPERSEDED** — phenytoin shipped 2026-07-17 with the Michaelis–Menten
engine and theophylline followed it the same day (see the nonlinear sections above). The
reasoning above is kept as the record of what was true before that engine existed.

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

### Phase-7 seed expansion (clean linear CNS + antidiabetic) — 3 compounds added 2026-07-13 (431 tests)

A 2026-07-13 pass added **lorazepam, zolpidem, glipizide** (40 → 43 compounds; 431 tests
green). All three are clean linear one-compartment drugs, advisor-reviewed before any JSON was
written, and each magnitude-checked against the built engine curve. The pass also produced five
documented deferrals (naproxen, ondansetron, escitalopram, sotalol, isoniazid — see the
nonlinear/ceiling deferral note near the top of this guide); the advisor's steer was to gate-check
every candidate's disqualifier _first_ and build only the survivors, and four of the original
candidates fell to a linearity or ceiling gate.

- **Lorazepam (`compounds/lorazepam.json`) — the CLEAN one-compartment benzodiazepine, the
  counterpoint to diazepam.** Where diazepam is two-compartment and draws an active metabolite
  (nordiazepam), lorazepam is single-compartment with an **inactive** 3-O-glucuronide and no
  metabolite line — the teaching contrast is "same drug class, very different kinetic picture,
  because of how the liver handles it (CYP oxidation vs Phase-II glucuronidation)." The FDA Ativan
  label reports a single Vd (1.3 L/kg), single terminal t½ (14 ± 5 h) and a matching CL
  (1.1 ± 0.4 mL/min/kg) that are mutually **one-compartment-consistent**: ke·Vd ≈ 1.07 mL/min/kg ≈
  the measured 1.1 (the honest reason it ships 1-comp where escitalopram, over-determined the other
  way, is deferred). Oral (F ~90%, Tmax 2 h, fast ka) + IV bolus (a real clinical route — status
  epilepticus, alcohol-withdrawal seizures, pre-op sedation), both 1-comp; the IV bolus uses Vss so
  the shallow early distribution phase is a mild documented approximation (cefotaxime posture; no
  infusion route offered, which is where the ICU two-compartment behaviour would appear). Sources:
  FDA Ativan label, Greenblatt 1979 (bioavailability), CHEMM. Magnitude: 2 mg oral → 17.9 ng/mL
  @ 2 h (reported ~20); 2 mg IV bolus → C(0) 22 ng/mL.
- **Zolpidem (`compounds/zolpidem.json`) — the 'Z-drug' hypnotic; the SHORT-half-life end of the
  CNS-depressant spectrum.** A rock-solid one-compartment case where nothing is derived offline and
  no caveats are needed: the FDA label gives a short t½ (2.5 h), clean Tmax (1.6 h), constant
  concentration-independent protein binding (92.5%), explicit **linear** kinetics over 5–20 mg, and
  a hard Cmax anchor (121 ng/mL after 10 mg); the clinical PK review (Salvà & Costa 1995) adds
  F ~70% and Vd 0.54 L/kg. Its ~30% first-pass loss goes entirely to **inactive** metabolites (no
  metabolite line) and is a _fixed_ fraction across the therapeutic range — the honest contrast to
  ondansetron (deferred, saturable first-pass). Oral only. Magnitude: 10 mg oral → **118.8 ng/mL**
  @ 1.6 h, matching the label's mean Cmax of 121 ng/mL within ~2% (the tightest label anchor in the
  set).
- **Glipizide (`compounds/glipizide.json`) — the set's first SULFONYLUREA (a genuinely new
  class: an insulin secretagogue, distinct from metformin's biguanide mechanism).** A clean,
  short-half-life oral one-compartment drug with an unusually small volume (Vd ~0.167 L/kg, ~11.7 L)
  from ~98–99% protein binding — the same small-Vd/high-binding axis as warfarin, but reached via a
  different class and story. Two teaching points make it non-redundant: (1) **why it stays linear
  while naproxen doesn't** — both are ~99% bound, but glipizide's therapeutic plasma levels are
  ng/mL (a thousandfold below albumin saturation) so its bound fraction is constant, whereas
  naproxen's are mg/L (near saturation) → dose-dependent clearance; (2) **concentration is not
  effect** — the curve is plasma glipizide, but its action (glucose-dependent insulin secretion) is
  time-shifted and dose-timed to a meal (a warfarin-style honesty caveat). It is technically
  two-compartment, but the distribution volume (~10 L) is barely below Vss (~11.7 L), so the oral
  collapse to 1-comp is essentially exact (unlike escitalopram/sotalol, deferred, where the volumes
  differ enough to matter). Metabolites are **inactive** (no line); oral only (no marketed IV).
  Sources: FDA Glucotrol label, Wåhlin-Böll 1982 (Clin Pharmacokinet). Magnitude: 5 mg oral →
  302 ng/mL @ 1.5 h (reported ~300–450).

### Illicit / recreational compounds — 5 added 2026-07-10 (398 tests)

A sixth 2026-07-10 pass added a slate of illicit / recreational drugs (30 → 35 compounds):
**LSD, psilocin, methamphetamine, dextroamphetamine** (four clean linear one-compartment
singles) and **ketamine → norketamine** (a two-compartment parent + drawn active metabolite —
the metabolite centerpiece). Advisor-reviewed before writing; each ceiling/killer-param vetted
from a source opened this session, then magnitude-checked against the built engine curve. Two
recreational-route notes recur: the **apparent-volume convention** (F = 1, use V/F — LSD and
psilocin) and **inferred IV** (`available: false` on an oral-only stimulant whose IV disposition
is nonetheless real — methamphetamine, dextroamphetamine, the acamprosate/warfarin posture).

- **LSD (`compounds/lsd.json`) — the microgram-dose axis; a modern-psychedelic single.** Curated
  from the Liechti-group controlled human PK (Dolder 2016/2017, Holze 2021). Clean LINEAR
  one-compartment oral: Dolder 2017 states "dose-proportional pharmacokinetics and first-order
  elimination" over 100–200 µg, Holze 2021 confirms dose-proportional microdose (5–20 µg) kinetics.
  Apparent-volume convention (V/F ~40 L, F folded in; true F ~71%); t½ 2.6 h main phase (a
  low-amplitude ~8.9 h terminal is documented, not rendered — the warfarin dual-half-life posture);
  Tmax 1.5 h. Exercises the low end of the dose (0.0002 g) and concentration (~1–4 ng/mL) axes.
  Magnitude: 200 µg oral → 3.35 ng/mL at 1.5 h (Dolder 3.1–4.5). Concentration ≠ effect (LSD
  effect lags/outlasts plasma — hysteresis).
- **Psilocin (`compounds/psilocin.json`) — model the ACTIVE species, not the prodrug.** Psilocybin
  is a phosphate-ester prodrug dephosphorylated to psilocin almost entirely PRE-SYSTEMICALLY (plasma
  psilocybin barely detectable — the oseltamivir situation), so psilocin is modelled as a single oral
  compound and the prodrug relationship is surfaced via `displayNote` (dose = psilocybin, curve =
  psilocin). THE UNITS TRAP resolved cleanly: doses are quoted as psilocybin (MW 284.3) but the
  plotted species is psilocin (MW 204.3, molar ratio 0.719); because the source Vz/F and CL/F are
  normalised to the psilocybin dose while measuring psilocin, the molar conversion AND the ~55%
  bioavailability are ALREADY folded into the apparent V/F — so entering the dose as psilocybin mg
  with F = 1 reproduces plasma psilocin directly, with no explicit 0.719 or 0.55 factor (applying
  either would double-count). Linear/dose-proportional 7–59.2 mg; t½ 3 h, Vz/F ~900 L (large — psilocin
  is lipophilic), Tmax 2 h. Source: 2025 systematic review (PMC11762572) + Holze 2023 (CPT). Magnitude:
  25 mg psilocybin → free-psilocin ~17.5 ng/mL at 2 h.
- **Methamphetamine (`compounds/methamphetamine.json`) — the long-t½ illicit stimulant + a urine-pH
  teaching axis.** d-Methamphetamine ("crystal meth", Schedule II; also Desoxyn). Clean one-compartment
  (with lag) per Schepers 2003; linear over the studied range. Vd 3.73 L/kg (IV elimination-phase,
  Cruickshank 2010), t½ ~10 h at normal urine pH — but the half-life is strongly URINE-pH DEPENDENT
  (weak base, partly renally excreted unchanged: ~6–12 h neutral/acidic, 16–31 h alkaline), a CONDITIONAL
  value modelled at ~10 h and documented (lamotrigine-comedication posture), NOT a dose-nonlinearity.
  Oral F ~0.67 (softest input — bracketed by the measured intranasal 79% / smoked 67%). Oral (Desoxyn)
  available; IV bolus inferred. The meth→amphetamine metabolite link is NOT drawn (CYP2D6-genotype-bimodal
  fm — the procainamide disqualifier); amphetamine ships as its own single compound. Magnitude: 10 mg oral
  → 21.6 ng/mL at 2.5 h (Schepers band 14.5–33.8).
- **Dextroamphetamine (`compounds/dextroamphetamine.json`) — the clean-label stimulant sibling.** d-Amphetamine
  ("speed", Schedule II; also Dexedrine). A firm FDA-label Cmax anchor (15 mg → 36.6 ng/mL at 3 h) next
  to methamphetamine's forensic literature. Linear one-compartment; Vd 4.4 L/kg (Cmax-consistent within the
  cited ~3–5 L/kg, F 0.9 — diphenhydramine posture), t½ ~10 h (d-enantiomer, urine-pH conditional like meth).
  Oral (Dexedrine) available; IV bolus inferred. Onward metabolites have no citable fm (no drawn pair; the
  meth→amphetamine link is bimodal). Magnitude: 15 mg oral → 35.6 ng/mL at 3 h (label 36.6, ~3% under).
- **Ketamine → norketamine (`compounds/ketamine.json`) — the metabolite centerpiece; a two-compartment
  parent + drawn active metabolite on IV/IM.** Dissociative anaesthetic (Ketalar, 1970) and major
  recreational drug ("Special K", Schedule III). The diazepam template: genuine TWO-COMPARTMENT parent
  (α t½ ~10–15 min / β t½ 2.5 h) + a drawn active metabolite. Curated from the FDA Ketalar label
  (DailyMed) + Clements 1982 + Mion 2013 + Kamp 2020. **Why IV/IM only:** oral ketamine has huge hepatic
  first-pass (F ~17%), so orally most norketamine forms PRE-SYSTEMICALLY (the oseltamivir disqualifier) —
  representable only on IV/IM (Ketalar's real route), where formation is systemic. Oral omitted (diazepam
  posture). **disposition2c:** CL 1.13 L/h/kg (Mion, ~79 L/h) and Vc 1.0 L/kg (~70 L) sourced; Q 1.305
  L/h/kg and Vp 1.86 L/kg (= Vss−Vc) derived offline from CL/Vc/Vss/β so the engine round-trips α t½ ~14.5
  min (label 10–15) and β t½ 2.5 h, and Vc+Vp = 2.86 L/kg reproduces Vss ~200 L. **Metabolite:** fm ~80% is
  a SINGLE citable number (N-demethylation, CYP2B6/3A4 — far cleaner than cocaine's or procainamide's soft/
  bimodal fm); norketamine active (~⅓ potency), t½ ~5 h (> parent → elimination-rate-limited, accumulates and
  outlives the parent, the oxypurinol story); Vd 1.39 L/kg derived from CL_m/t½_m (nordiazepam posture).
  Drawn on iv_bolus AND iv_infusion (both real routes). **Timing caveat (allopurinol posture):** the label
  observes norketamine peaking ~30 min (rapid formation during the high-concentration α phase), but the
  single-compartment systemic-formation model peaks LATER (~3.3 h) because a slow (5 h) metabolite is
  accumulation-dominated by the sustained β-phase parent — the magnitude (~0.44 µg/mL for a 100 mg bolus) and
  the long active tail are faithful, only the peak timing runs late. Magnitude: 100 mg IV bolus → C(0) = 1.43
  µg/mL (= Dose/Vc exact), norketamine ~0.44 µg/mL.

### Illicit / recreational candidates NOT shipped — cocaine (defer), MDMA / THC / heroin

Documented so they aren't re-litigated (defers/exclusions are first-class output):

- **Cocaine → benzoylecgonine — DEFERRED (nonlinear clearance + genuinely two-compartment; a double
  disqualifier).** The most tempting illicit metabolite pair — benzoylecgonine (BE) is the long-lived,
  inactive metabolite that urine drug screens detect, the forensic-marker story. But two independent gates
  fail. (1) **Dose-dependent clearance:** human IV data give a clearance that FALLS with dose (a reported
  regression CL ≈ 2.51 − 0.67·dose L/kg/h — saturable esterase hydrolysis by butyrylcholinesterase/CE-1),
  the same superposition-breaking nonlinearity that excludes phenytoin and MDMA. (2) **Genuinely
  two-compartment:** Vc ~1.3 L/kg with CL 32.7 mL/min/kg implies a ~0.46 h half-life, but the observed
  terminal is ~1.1 h (Vβ ~2.7 L/kg, Vss ~1.96 L/kg) — a one-compartment collapse would miss the early peak
  ~2× (the ciprofloxacin ceiling failure). Either alone would defer it; both together park it firmly. Had the
  clearance been dose-independent, BE was representable off a 2-comp parent (diazepam template): fm ~40–45%
  (CE-1 hydrolysis, systemic — passes the pre-systemic screen; IV cocaine actually passes cleaner than
  allopurinol, no first-pass), BE t½ ~6.0 h, and a BE Vd ~0.75 L/kg that reproduces the measured BE:cocaine
  AUC ratio of 10.1 (an AUC-anchored volume — magnitude-correct by construction, so the parent curve C₀=D/Vc
  is the independent check). **Ketamine → norketamine was shipped as the clean metabolite pair in cocaine's
  place** (explicitly linear, single citable fm). Cocaine stays parked pending a source establishing
  dose-independent clearance over a narrow single-dose range.
- **MDMA (ecstasy) — EXCLUDED, `linear: false`.** MDMA inhibits its own metabolising enzyme (CYP2D6), so
  clearance falls as concentration rises and AUC increases MORE than dose-proportionally (autoinhibition;
  de la Torre 2000/2004). A genuine superposition violation — the same class as omeprazole and phenytoin —
  so it belongs in the nonlinear phase, not v1.
- **THC (Δ9-tetrahydrocannabinol) — DEFERRED.** Highly lipophilic, deep multi-compartment with a days-long
  terminal half-life driven by slow release from fat; the active metabolite 11-OH-THC adds a second layer.
  No clean single-population linear model with citable micro-parameters over a plotted range; parked (the
  amiodarone/thiopental class of unsourceable/nonlinear multi-compartment drug).
- **Heroin (diamorphine) → 6-MAM → morphine — DEFERRED.** A two-step SEQUENTIAL metabolite cascade
  (heroin → 6-monoacetylmorphine → morphine), which the engine cannot represent: it forms any number of
  metabolites in PARALLEL from the parent (single-STEP), but not a metabolite OF a metabolite (a chain). Heroin itself is ultra-short-lived (t½ ~3 min). Parked pending
  a metabolite-cascade engine extension. (Codeine → morphine is separately out: CYP2D6-bimodal fm.)

### Methylxanthines — caffeine → paraxanthine metabolite + theobromine standalone (2 added/expanded 2026-07-10, 399 tests)

A seventh 2026-07-10 pass addressed caffeine's metabolism and shipped **theobromine** (35 → 36
compounds). Caffeine was already in the set as a plain one-compartment drug with no metabolite; it
now draws all three of its parallel demethylation metabolites, and theobromine — both a caffeine metabolite *and* the principal
methylxanthine of chocolate — ships as its own standalone. Both are anchored to **Lelo et al. 1986**
(Br J Clin Pharmacol 22:177-182, PMID 3756065, the comparative-PK paper), which measured caffeine
AND all three demethylated metabolites (paraxanthine, theobromine, theophylline) in the **same six
healthy male volunteers** — the one-population source — plus the companion partial-clearances paper
(PMC1401107, PMID 3756066) for the metabolic split and Baggott et al. 2013 (PMID 23420115) for
theobromine's oral Tmax.

- **Caffeine → paraxanthine + theobromine + theophylline — all THREE parallel metabolites drawn.**
  CYP1A2 demethylates caffeine into THREE primary metabolites in parallel — paraxanthine (~80% of
  total clearance), **theobromine (~11%)**, and **theophylline (~4%)** — with ~15% going to
  8-hydroxylation (trimethyluric acid, not a demethylation product, not drawn). The metabolite engine
  is **N-metabolite, not single-metabolite** (an earlier note here wrongly claimed it "draws only ONE
  line" — `buildCurve` maps over `compound.metabolites` producing one `MetaboliteCurve`/`<Line>` each,
  4 cycled colours + legend + per-metabolite provenance group), and each metabolite is an INDEPENDENT
  Bateman formed from the shared parent clearance (formation rate `fm_i·CL·C_p`) — exactly the physics
  of parallel metabolism. So all three are drawn, a faithful picture of caffeine's fate. The three make
  a clean **formation- vs elimination-rate-limited** teaching set: paraxanthine t½ 3.1 h < parent 5 h ⇒
  formation-limited (peaks lower/earlier, tail tracks the parent, no accumulation), whereas theobromine
  (t½ 7.2 h) and theophylline (t½ 6.2 h) both exceed the parent ⇒ elimination-limited (they linger past
  it). Parent disposition kept from the FDA label (t½ 5 h, Vd 0.6 L/kg, already shipped); metabolite
  params all from Lelo (paraxanthine t½ 3.1 h/Vd 0.59, theobromine 7.2 h/0.75, theophylline 6.2 h/0.50
  L/kg = CL·t½/ln2). Built curves (200 mg oral): parent 4.15 mg/L @ 1 h, paraxanthine 1.02 @ 6 h,
  theobromine 0.17 @ 9 h, theophylline 0.08 @ 8 h. **Theophylline is drawn HERE as a LINEAR line and
  ALSO ships as a MICHAELIS-MENTEN standalone** (2026-07-17) — no contradiction, and the tie is exact:
  as a ~3.4% metabolite it peaks ~0.1-0.2 mg/L, ~100-300× below its Km (24.1 mg/L), and at `c ≪ Km`
  the saturable rate `Vmax·c/(Km+c)` collapses to `(Vmax/Km)·c`, so this line **is** the standalone's own
  low-concentration limit — the same tie the engine's `Km ≫ C` collapse test pins. It must still not be
  read as endorsing a linear plot of a *therapeutic* theophylline dose. Byte-identical Vd (0.5 L/kg) holds
  the two files together; the standalone's dilute-limit t½ (7.2 h) sits inside the 5-9 h range stored here.
  Theobromine ALSO ships as its own standalone (below), byte-identical disposition.
- **THE fm MW CONVENTION (reusable precedent — this pass's key lesson).** Lelo's "79.6% of total
  clearance" is a **MOLAR** fraction (partial clearance ÷ total clearance is dimensionless — the
  fraction of caffeine *molecules* on that path). But the engine's `fm` multiplies parent **MASS**
  eliminated (`dA_m/dt = fm·CL·C_p`, all in mg, **no MW factor** — the schema has no MW field). Each
  mg of caffeine (MW 194.19) cleared to paraxanthine yields only 180.16/194.19 = 0.928 mg paraxanthine
  (MW 180.16), so the **mass-basis fm = 0.796 × 0.928 = 0.74** (stored 74%, `derived: true`). This is
  NOT a new rule — it matches the existing convention: allopurinol stores `fractionFormed: 90` from
  Day 2007's "90 mg oxypurinol per 100 mg allopurinol" (a MASS ratio), and the psilocin note folds its
  284→204 molar ratio in explicitly. **Whenever an fm is sourced as a clearance/molar fraction, convert
  to the mass basis by MW(metabolite)/MW(parent) before storing.** (Caffeine was more exposed than
  allopurinol because paraxanthine's Vd is sourced independently from Lelo and the magnitude falls where
  it lands — nothing back-fits the metabolite volume to a measured Cmax to silently absorb a units error.)
- **Theobromine (`compounds/theobromine.json`) — the chocolate methylxanthine, a clean linear
  one-compartment standalone.** The principal methylxanthine of cocoa (dark chocolate ~200-300 mg
  theobromine vs ~25-35 mg caffeine per 40 g) — a slower, gentler xanthine than caffeine (lower
  clearance 1.20 vs 2.07 mL/min/kg, longer t½ ~7.2 vs ~4-5 h). Disposition from Lelo's directly-measured
  theobromine dosing (t½ 7.2 h, Vd = CL·t½/ln2 = 0.75 L/kg — the cefotaxime coherent-1-comp posture);
  Tmax ~3 h from Baggott 2013 (pure capsules). Apparent-volume convention (F = 1, Vd/F used). **No
  metabolite line** — its downstream products (7-/3-methylxanthine, 3,7-dimethyluric acid) have no single
  dominant citable fm (pregabalin/lithium clean-feature posture). **Cross-reference:** theobromine is
  also caffeine's ~10%-mass-fm metabolite, drawn as one of caffeine.json's three parallel metabolite
  lines with a byte-identical Lelo-measured disposition — this standalone is the same molecule entered
  from the dietary direction, so the two files can never disagree.
  **Linearity teaching pair — both now shipped:** theobromine (linear) vs its isomer theophylline (M-M
  nonlinear, shipped 2026-07-17) — two dimethylxanthine isomers on opposite sides of the superposition
  line, so switching between them changes the **model**, not just the numbers. Ceiling test
  clears: 500 mg oral F·D/V ceiling ~9.5 mg/L, built peak 7.1 mg/L @ 3 h (oral only — the dietary route).

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

**Nicotine (Gisleskog 2021) → cotinine — the third 3-comp compound, and the FIRST shipped
compound whose metabolite forms from a 3-compartment parent.** A toxin + drug + metabolite-pair
in one file (`compounds/nicotine.json`): the addictive tobacco alkaloid, a historical
insecticide, an NRT drug, and a potent acute poison. Same directly-parameterized template as
remifentanil/propofol — the Gisleskog 2021 *Clin Pharmacokinet* 930-subject population model fit
IV nicotine to a three-compartment model and reports the typical 70 kg values outright (CL 67.4
L/h; V1 117, V2 130, V3 53.4 L; Q2 38.6, Q3 216 L/h), so nothing is derived offline. Why it earns
a slot:

- **The terminal-half-life lesson, INVERTED from remifentanil.** Engine eigenvalues: α t½ ~6.7
  min, β t½ ~57 min, γ t½ ~4.5 h, with an IV-bolus amplitude split **~39% / ~45% / ~16%**. Two
  points: (1) the textbook "nicotine half-life ~2 h" is an *apparent* terminal — limited-duration
  classic studies (Feyerabend 1985) blend the true β (57 min) and γ (4.5 h) into one ~2 h slope;
  the rich Gisleskog sampling resolves the slower γ. So a single quoted half-life here *under*-reports
  the true terminal (remifentanil was the opposite — its quoted terminal *over*-stated a
  0.09%-amplitude tail). (2) "Fast" is set by Q/V, not the label: Q3 (216 L/h) is the *largest*
  inter-compartmental clearance, but because V3 is small that compartment equilibrates *fastest*
  and drives the α phase — the deep-sounding "compartment 3" is the quick one.
- **First 3-comp-parent metabolite (cotinine).** Exercises `metabolite3cConcentrationCurve` with
  real data (previously engine-capability-only). fm MW-adjusted from the 70–80% MOLAR conversion:
  mass-fm ≈ 80% = molar × 176.21/162.23 = molar × **1.086** — a factor GREATER than 1 because
  cotinine is HEAVIER than nicotine, the opposite direction from caffeine's lighter dimethylxanthine
  metabolites (a clean second worked example of the molar→mass rule). Cotinine's Vd (56.5 L) and
  t½ (12.2 h) are De Schepper 1987's directly-measured IV values. Because cotinine (12 h) outlives
  nicotine's terminal (~4.5 h) it is elimination-rate-limited and lingers — the disposition reason
  blood/saliva cotinine, not nicotine, is the exposure biomarker.
- **IV-BOLUS ONLY — oral deferred on the oseltamivir criterion.** `iv_bolus available:true` (the
  disposition IS the IV arm of the population study — measured, not inferred; there is simply no IV
  nicotine *medicine*). **Oral is deliberately NOT offered:** nicotine's ~40% oral bioavailability
  is largely first-pass conversion to cotinine that happens PRE-systemically, which a
  systemic-formation engine cannot represent (it would draw the oral cotinine line ~2–3× too low on
  the default view). That is exactly the oseltamivir deferral criterion — so oral is dropped rather
  than shipped with a misleading metabolite curve, keeping the IV route where cotinine is faithful.

**Morphine → M3G (major, inactive) + M6G (minor, active) — the parallel-glucuronidation
centrepiece (`compounds/morphine.json`).** The first compound with an active AND an inactive
metabolite drawn together (M3G is the FIRST `active: false` metabolite shipped — chart legend
reads "— metabolite", not "— active metabolite"). Single-population sourcing: morphine disposition
and BOTH formation fractions from Hasselström & Säwe 1993 (PMID 8491060, healthy volunteers);
each glucuronide's OWN disposition from a direct-IV-metabolite study (M6G Hanna 1991 PMID 1997044;
M3G Penson 2001 PMID 11745739). Key curation calls:

- **One-compartment EFFECTIVE parent, not 2-comp.** Morphine's measured CL (1.27 L/h/kg) and Vss
  (2.9 L/kg) give an *effective* half-life ln2·Vd/CL = 1.58 h (≈ the FDA label's "effective ~2 h"),
  which carries essentially all its AUC. The sensitive-assay ~15.1 h terminal is a low-amplitude
  deep phase and CANNOT be used as a 1-comp half-life (pairing 15 h with Vss 2.9 implies CL ~10×
  too low → AUC ~10× too high). The macro-parameters are mutually consistent only for the effective
  phase, so 1-comp at 1.58 h is the honest read; the 15 h tail is documented-not-modelled
  (remifentanil/nicotine terminal-honesty + warfarin dual-half-life posture). CL not stored
  (circular with the derived t½).
- **Metabolite disposition = TRUE intrinsic, not apparent (the decisive call, advisor-reviewed).**
  The glucuronides' APPARENT post-morphine half-lives (M3G 11.2 h, M6G 12.9 h; Hasselström) are far
  LONGER than their INTRINSIC elimination (M3G 1.66 h; M6G 2.05 h; direct-IV studies). The long
  apparent tails are formation-rate limitation (paced by morphine's ~15 h deep phase) PLUS
  enterohepatic recirculation — neither representable by a linear systemic superposition engine.
  Three options: (A) store true intrinsic disposition; (B) store the apparent ~12 h as the
  metabolite's "elimination"; (C) build a multi-comp parent carrying the 15 h phase. **A shipped.**
  B was rejected because it corrupts the honesty panel (presenting a formation/enterohepatic
  artefact as M6G's elimination) and breaks the renal-accumulation teaching (M6G matters because its
  OWN elimination slows in renal failure — storing 13 h makes that incoherent). C was rejected
  because the 15 h phase is ~1% amplitude (won't reproduce the observed tail anyway) and
  enterohepatic cycling is still unmodelable — a fabricated ill-conditioned parent for no gain. The
  metabolite AMOUNTS stay faithful (AUC_m = fm·D/CL_m, parent-disposition-independent); only the
  shape's long tail — the unmodelable part — is shortened, and that discrepancy becomes the teaching
  caveat in the metabolism prose. **General rule this establishes:** when a metabolite's apparent
  post-parent half-life is a formation/enterohepatic artefact and its intrinsic elimination is
  separately measured (direct-IV), store the intrinsic value — the honesty panel must show real
  disposition, not a lumped apparent constant. (Contrast cefotaxime/desacetyl, where the apparent
  2.3 h IS elimination-rate-limited — longer than the parent — so the apparent value is honest.)
- **fm mass-conversion (recurring precedent).** Hasselström's formation clearances are MOLAR; both
  glucuronides (MW 461.46) are HEAVIER than morphine (285.34), so mass-fm = molar × 461.46/285.34 =
  ×1.617: M3G 57.3% → **92.7%**, M6G 10.4% → **16.8%**. Their sum >100% (109.5%) is EXPECTED and
  correct for heavier metabolites (molar sum 67.7% < 100%) — do not "fix" it. Same direction as
  cotinine (×1.086), inverse of caffeine's lighter xanthines (×0.928).
- **ORAL + IV BOLUS (oral ADDED 2026-07-10 via the `ffp` engine — the deferral is reversed).**
  Morphine's ~29% oral F is largely first-pass glucuronidation, so much of M3G/M6G forms
  PRE-systemically — previously the oseltamivir/nicotine deferral criterion, now *represented* by the
  per-metabolite `firstPassFraction` term (M3G 65.6%, M6G 11.9%; see the Oral first-pass section
  above for the derivation, the fm·F + ffp = IV-fm anchor, and the timing screen morphine passes but
  oseltamivir failed). Oral is morphine's centrepiece contribution twice over: the parallel-glucuronide
  pair *and* the first shipped general-case (`fm > 0` + `ffp > 0`) first-pass compound.
- **Magnitude (built engine):** IV 10 mg → C(0) 49 ng/mL; M3G peaks 151 ng/mL @2.3 h, M6G 24 ng/mL
  @2.6 h (AUC ratio 5.7, ≈ the mass-fm ratio) — M3G ≫ M6G, both peaking just after the fast parent.
  ORAL ~22.5 mg base (≈30 mg sulfate) → parent Cmax ~22.8 ng/mL @0.8 h (reported ~28.5), and the
  glucuronides tower over it (M3G ~22×, M6G ~3.3× the parent) peaking ~0.9–1.1 h — the visible
  first-pass teaching contrast. Oral glucuronide AUC = IV glucuronide AUC (2.159 vs 2.158 built).

**Acetaminophen → glucuronide + sulfate — the FORMATION-rate-limited metabolite recipe (added
2026-07-10, advisor-reviewed; `compounds/acetaminophen.json`).** The two major conjugates were added
to the already-shipped IV-only acetaminophen (glucuronide 55%, sulfate 30% of dose). This establishes
the **third reusable metabolite screen**, alongside the `F·D/V` ceiling and the first-pass timing
screen — the recipe for a metabolite the kidneys clear FASTER than the liver forms it:

- **THE RECIPE (a formation-rate-limited metabolite whose Vd is unidentifiable).** When a metabolite
  is cleared faster than it is formed, its plasma decline tracks the PARENT and its own volume is NOT
  identifiable from parent-dosing data (population PK models FIX it, e.g. to 18% of parent central
  volume). You still ship it honestly: **(1) cite `fm`** (urinary recovery); **(2) cite `CL_m`** — the
  metabolite's elimination clearance; for a renally-cleared conjugate that IS its renal clearance;
  **(3) ASSUME `Vd_m`** (extracellular-water order ~0.2 L/kg for a polar conjugate), `derived: true`
  with conditions stating plainly it is *assumed because unidentifiable* — NOT dressed as measured (the
  lithium lesson); **(4) DERIVE `t½_m = ln2·Vd_m/CL_m`.** Because t½ is derived to PRESERVE CL_m, the
  Vd assumption **cancels** in `AUC_m = fm·D/CL_m` — the EXPOSURE is exact; the assumed Vd shifts only
  the peak HEIGHT. This is the diazepam→nordiazepam posture (metabolite Vd derived, not measured),
  applied where the volume is genuinely unidentifiable rather than merely unreported.
- **THE GATE (run it with the ACTUAL numbers BEFORE writing).** The derived `t½_m` must come out
  SHORTER than the parent's t½ — the formation-rate-limited regime, where the whole curve is pinned by
  the two citable clearances and the metabolite correctly tracks the parent tail. If `t½_m` comes out
  LONGER than the parent's, STOP: the metabolite is elimination-rate-limited, the Vd assumption
  dominates the tail, and it is NOT shippable without a directly-measured metabolite disposition (the
  morphine-needs-direct-IV situation). Acetaminophen passes: glucuronide 1.51 h, sulfate 0.94 h, both
  ≪ parent 2.4 h.
- **Store INTRINSIC, not apparent (the morphine rule, inverted).** The long apparent conjugate
  half-lives (~15–26 h) come from RENAL-FAILURE patients where the renally-cleared conjugates
  accumulate — do not store them. Store the intrinsic (short) value; formation-rate-limitation then
  emerges naturally (terminal slope = min(k_parent, k_m) = k_parent). Contrast cefotaxime/desacetyl
  (elimination-rate-limited: apparent t½ LONGER than parent, so apparent IS honest) — acetaminophen's
  conjugates are the opposite regime, and morphine's glucuronides a third case (apparent long but an
  enterohepatic artefact, intrinsic stored from direct-IV data).
- **Parameters.** fm molar 55%/30% (NBK526213 monograph) MW-adjusted ×2.165/×1.530 → **119.1% /
  45.9%** (mass; sum >100% expected for heavier conjugates). CL_m = Morris & Levy 1984 renal-clearance-
  to-creatinine ratios (glucuronide 0.890, sulfate 1.43; 8 healthy adults) × standard CrCl ~120 mL/min
  = **6.4 / 10.3 L/h** (sulfate faster — active tubular secretion, ratio >1). Vd_m assumed **0.2
  L/kg**. Linearity + route-independence cross-checked against Clements/Prescott 1984. Magnitude
  (built, 1000 mg IV): glucuronide mass AUC ~3.0× parent (molar ~1.4×, conservative low end of the
  reported ~1.5–3), sulfate ~0.7× parent — glucuronide the dominant line, both peaking ~2–2.7 h then
  tracking the parent tail.
- **NAPQI stays in PROSE, never a line (refuse-don't-mislead).** The ~8–10% oxidative pathway forms
  NAPQI, a reactive intermediate consumed at its site of formation (hepatic glutathione) — it does not
  circulate, so it has NO citable plasma Vd/t½. Drawing it would require FABRICATED disposition. It is
  named in the metabolism prose instead — itself a teaching point (the most toxicologically important
  metabolite is invisible in plasma). General rule: a reactive/tissue-consumed intermediate with no
  plasma disposition is a prose subject, never a Bateman line.
- **Engine catch — the `fm > 1` guard was widened.** Acetaminophen glucuronide (mass-fm 119%) was the
  first SINGLE metabolite exceeding 100%, tripping `derive.ts`'s `fractionFormed ∈ [0,1]` plausibility
  WARNING (a warning, not a throw — it would have surfaced confusingly on the chart via `WarningsStrip`,
  not failed a test — which is exactly why it needed a built-curve `warnings`-array check, not just a
  passing loader test). The guard now uses a mass-basis ceiling (`MAX_PLAUSIBLE_MASS_FRACTION = 3`):
  mass-fm legitimately exceeds 1 for a metabolite heavier than the parent (moles conserved on
  conjugation, not mass), so `[0,1]` was simply the wrong bound for this engine's mass-based `fm`. The
  same widening was applied to `ffp`.

**Procainamide → NAPA — the PHARMACOGENETICS pair + phenotype-anchoring pattern (the 40th
compound, 2026-07-11, advisor-reviewed; `compounds/procainamide.json`).** A NEW compound (user-
authorised expansion beyond the "metabolites for existing compounds" task — the best pair in the
acetylator/CYP2D6 category). Procainamide is acetylated to NAPA, an ACTIVE metabolite, at a
genetically-polymorphic rate (NAT2 fast vs slow acetylators) — the textbook pharmacogenetics story.

- **It is the CEFOTAXIME pattern, NOT the acetaminophen recipe (don't blur them).** NAPA t½ ~7 h >
  parent ~2.4 h → **elimination-rate-limited** (its own slower disposition governs its decline;
  terminal slope = min(k_parent, k_m) = k_m), and NAPA was marketed as the antiarrhythmic
  **acecainide**, so its disposition (Vd ~1.4 L/kg, t½ ~7 h, ~85% renal-unchanged) is **directly
  measured** — NO assumed-volume / identifiability problem. The APAP formation-limited gate does not
  apply; the only special gate is the polymorphic fm.
- **PHENOTYPE-ANCHORING (the reusable pattern for a bimodal/polymorphic fm).** The engine takes one
  fm, but acetylation is bimodal — so anchor a SINGLE illustrative phenotype and keep every input
  consistent to it. Modelled the **FAST acetylator** (the striking case: more NAPA, NAPA exceeds
  parent): fm 0.40 (Lima 1979 formation-clearance fraction) AND parent t½ 2.4 h AND CL 34.8 L/h are
  ALL fast-acetylator values; NAPA's disposition is phenotype-independent. **Bright line:** an
  illustrative phenotype is like the 70 kg reference subject — an educational population choice,
  never patient genotyping.
  **SUPERSEDED IN PART (2026-07-17): the slow case is no longer prose-only** — see "Phenotype
  presets" below. Anchoring, and every consistency rule above, still governs each individual preset;
  what changed is that a compound may now ship SEVERAL anchored phenotypes and let the reader switch.
- **The band-must-stay-within-the-phenotype catch (advisor completion-review — automated checks
  can't see it).** For a 1-comp compound, `disposition.halfLife.range` drives the variability
  slider. An early draft set the range `[2.2, 3.6]` — but 3.6 h is the *slow*-acetylator mean, so the
  slider would have dragged the parent to a slow t½ while fm stayed pinned at the fast 0.40 (an
  inconsistent phenotype state; the 1-comp metabolite reshapes with the plotted ke), silently
  contradicting the "slider varies half-life, not acetylator status" framing. Fixed by narrowing the
  range to the FAST-acetylator variability (2.4 ± 0.7 → [1.7, 3.1]) so the band never reaches the
  slow value. **General rule:** when you anchor one phenotype, the half-life range (which becomes the
  interactive band) must stay WITHIN that phenotype — do not let it span to the other phenotype's
  value, or the slider exposes a state the fixed fm contradicts. **Still the rule under presets** —
  each preset carries its OWN within-phenotype range (fast [1.7, 3.1], slow [2.6, 4.6]), and crossing
  between phenotypes is the preset's job, not the slider's.
  **EXTENDED (2026-07-20): the rule now covers `disposition.vd.range` and `routes.oral.F.range`
  too.** Those two are no longer inert provenance — for a 1-comp compound each drives its own
  slider and its own shaded band (`VariabilityAxis` in `ui/curve.ts`). So the same
  stay-within-the-phenotype discipline applies to all three: a range you write because a review
  quoted it across a mixed population becomes a state the reader can steer the curve into. Two
  consequences when curating:
  - **A `range` is a claim about ONE population.** If the low and high come from different
    phenotypes, study designs, or dose levels, do not store them as a range — that is the
    procainamide catch, generalised.
  - **F ranges are ORAL-only and must not double-count.** An IV `F` is 1 by definition and gets no
    slider; the transdermal schema stores no `F` at all (its delivered rate is already systemic).
    Also check the compound does not store an *apparent* `clearance` (CL/F) or a Vd derived from
    one — those already embed an F, so varying F on top would move the curve twice. No shipped
    F-ranged compound does, and the check is a two-minute scan of `disposition`.
- **1-comp ORAL collapse (reverses the old 2-comp rejection).** IV procainamide is genuinely
  2-compartment (~5 min distribution), but oral absorption masks it, so oral reads 1-comp
  (cefotaxime/ibuprofen posture). Shipped oral-only (F 83%, Tmax 90–120 min → ka); the biphasic IV
  route omitted rather than misrepresented. **No `ffp`:** procainamide is nearly completely absorbed
  and first-pass acetylation is minimal, so the <100% F is malabsorption, not pre-systemic conversion
  — NAPA forms systemically only.
- **fm — mass conversion + lower-bound distinction.** fm = acetylation clearance fraction (fast 0.40),
  MW-adjusted ×277.37/235.33 = ×1.179 (NAPA heavier) → 47.2% mass. The FDA-label "24–33% metabolised
  to NAPA" and Wierzchowiecki's 22.5% urinary NAPA are urinary-recovery LOWER bounds (the cefotaxime
  desacetyl distinction), reflected in the fm range low end.
- **Magnitude (built).** 750 mg oral fast-acetylator: parent peaks ~2.9 mg/L @1.5 h; NAPA peaks
  ~1.7 mg/L @6.5 h (lower and later, elimination-limited), crosses the parent line @~4.5 h, and its
  molar AUC reaches ~1.67× the parent (mass ~1.97×) — reproducing "NAPA exceeds procainamide in fast
  acetylators" in the TAIL and in total exposure, not at the peak. Slow acetylator: NAPA peaks only
  ~0.7 mg/L, crosses @~10.2 h, molar AUC ~0.56×. Sources (all opened): FDA DailyMed
  label, Lima 1979 (PMID 458558, fm), Wierzchowiecki 1980 (PMID 6161089, t½s), acecainide review
  (PMID 1693889, NAPA active/class III), Bauer Applied Clinical PK (F, NAPA Vd).

**Digitoxin — the long-t½ / small-Vd / high-protein-binding counterpoint to digoxin
(`compounds/digitoxin.json`).** Two cardiac glycosides at opposite ends of two axes at once: t½
~6.5 days vs ~1.5 days; Vd ~0.5 L/kg vs ~5–7 L/kg. Digitoxin is far more lipophilic and ~97%
albumin-bound, so it stays in the circulation (small Vd) and is cleared slowly by hepatic
metabolism, not renally. Curation:

- **One-compartment, NOT the 2-comp the vetting note guessed.** MacFarland 1984's specific-assay
  numbers are internally 1-comp-consistent: CL = ln2·Vd/t½ = 0.693 × 0.47 L/kg × 70 / 156 h =
  0.146 L/h = 2.44 mL/min = exactly the reported clearance. No clean single-population α/Vc exists,
  and the 4–6 h distribution phase is negligible against a 6.5-DAY terminal — forcing 2-comp would
  mean inventing a distribution phase, so 1-comp is the honest read (ibuprofen/cefotaxime posture).
- **Linearity anchored to an opened statement (citation-verify).** Ochs 1982 (PMC1427752): the
  accumulation half-life (7.9 d) ≈ single-dose (8 d), and observed SS serum 15.4 ng/mL ≈ 15.3
  predicted from single-dose data — dose/route-independent, so `linear: true`.
- **Parent-only, no metabolite line** (hepatic CYP3A4 → digitoxigenin + minor conversion to
  digoxin; no single dominant citable fm — theobromine/pregabalin posture). Oral (F 81.5% by
  specific assay — the honest value vs the ~98% non-specific-RIA over-estimate) + IV bolus; Tmax is
  a flagged curatorial 1 h (no digitoxin-specific value published, and the ~6.5-day t½ makes the
  curve utterly Tmax-insensitive, ka ≫ ke — the inverse of flip-flop). Digitoxin is largely
  historical/discontinued; modelled purely as an extreme-long-half-life educational example. NTI.
- **Magnitude (built engine):** 1 mg IV → C(0) 30 ng/mL (therapeutic 10–30, ~10× digoxin's
  0.5–2 range, the direct consequence of the ~10× smaller Vd).

## The schema (one JSON file per compound)

Each parameter is an object carrying provenance. Disposition parameters (Vd, t½,
CL) are route-independent and live under `disposition`; route-specific parameters
(F, ka, Tmax) live under `routes`. The `model` field is the discriminator that
lets future model types slot in, and `linear: false` means superposition is
invalid (such compounds are excluded from v1).

Real compound files are **strict JSON** — no comments and no trailing commas, so
`JSON.parse` accepts them. Curator reasoning therefore goes in the `notes` field,
never inline. Abbreviated shape (full example: handoff §8):

### User-facing prose — `description` (required), `metabolism` + metabolite `description` (optional)

Three plain-language fields are surfaced **on screen** for the viewer (distinct
from the curator-only `notes`, which stays technical):

- **`description` (REQUIRED, ~2 sentences, `.max(400)`):** what the compound *is*
  and what it is *typically used for*. Rendered in a **fixed-height "About" box
  above the chart**. The height is fixed on purpose — this is the **curation rule
  that stops the interface jumping** when the user switches compound: the box must
  hold the blurb without changing size, so keep it to about two sentences (the
  schema enforces the length cap). For a **toxin/poison**, describe *what it is* (a
  pesticide, a plant alkaloid, an illicit drug) — **not** a therapeutic use it
  doesn't have — to stay on the educational-not-clinical side of the bright line.
- **`metabolism` (optional, uncapped):** a longer narrative about how the compound
  is metabolised/eliminated and what its metabolites are (which dominates, active
  vs inactive, the teaching point). Rendered **below the chart**, where it may grow
  as long as needed without disturbing the chart or the About box.
- **metabolite `description` (optional, per metabolite, `.max(400)`):** a short "what
  is this metabolite / is it active" blurb, listed under the metabolism section.

Every shipped compound must carry a `description` (a loader-level test enforces
it). Populate it whenever you add a compound.


```json
{
  "id": "acetaminophen",
  "schemaVersion": 1,
  "names": { "inn": "Paracetamol", "usan": "Acetaminophen", "synonyms": ["APAP"] },
  "description": "A widely-used over-the-counter analgesic and antipyretic (pain and fever reducer). One of the most common household medicines; safe at normal doses but toxic to the liver in overdose.",
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

### The nonlinear pass — phenytoin + ethanol added 2026-07-17 (the first `linear: false` ships)

The two compounds this project tagged "exclude" on day one, shipped against the new
Michaelis–Menten engine (43 → 45). Both were advisor-reviewed before any JSON was
written, and both are magnitude-checked *in CI* by `src/ui/curve.mm.test.ts` rather than
by hand — the MM parameters only mean anything together, so a plausible-looking edit to
any one of them silently moves the teaching point. That test is the standing-trap guard
for these two.

- **Phenytoin (`compounds/phenytoin.json`) — the dose→steady-state CLIFF.** Vd 0.95 L/kg,
  Vmax 580 mg/day (baseline, 70 kg), Km 7.9 mg/L, all from **Frame & Beal 1998**
  (Ther Drug Monit; NONMEM, 115 patients, IV) — one source, because Vmax/Km are correlated.
  The FDA DILANTIN label describes the mechanism in its own words but prints **no** Vmax,
  Km, or Vd. Magnitude: `Css = R0·Km/(Vmax−R0)` gives 300 mg/day → ~8.4 mg/L, 400 → ~17.5,
  500 → ~49, and no steady state at all above 580 mg/day. A 33% dose rise crosses the whole
  10–20 mg/L window — the label's own "10% or more" warning.
  **The best find:** the model reproduces the label's half-life *range* from saturation
  alone — t½(c) runs ~15 h at trace to ~43 h at 20 mg/L, bracketing the label's "22 hours,
  range 7 to 42". So the label's single range silently mixes concentration-dependence with
  between-patient variability; only the unreachable 7 h floor is genuinely the latter.
  Two documented caveats: Vd is conditional on albumin 3 g/dL (and, usefully, **cannot**
  affect Css); and Frame & Beal's Vmax is **pre-autoinduction** (Vmax rises after ~59.5 h),
  so the engine — which has no induction term — overstates *chronic* Css. Read the curve for
  the shape of the cliff, not as a chronic prediction (the lamotrigine posture).
  **IV-only:** infusion available, bolus inferred (the rate limit is why), **oral omitted** —
  no citable ka, and a Tmax cannot be inverted under saturation.
- **Ethanol (`compounds/ethanol.json`) — the STRAIGHT-LINE decline.** Vd 35.8 L (Vss),
  Vmax 95 mg/min, Km 27 mg/L, all from **Norberg 2000** (Br J Clin Pharmacol; 16 fasted
  volunteers, 0.4 g/kg IV). Vmax and Vd are taken from one study *deliberately*: their
  ratio is the zero-order slope, 15.9 mg/dL/h — exactly the canonical ~15. That ratio is
  the number that must be right, and `curve.mm.test.ts` pins it.
  **A magnitude check that looked like a failure and wasn't:** Norberg's Vss is ~0.51 L/kg
  at the 70 kg subject, well under Widmark's r ≈ 0.68, so peak BAC looked ~30% "high".
  Widmark's r is a *forensic back-extrapolation factor*, not a measured volume — the two
  independently measured PK volumes here (Norberg ~0.51, Rangno 1981 0.47) agree with each
  other, not with r. Check ethanol against the study's own dose (0.4 g/kg → ~78 mg/dL), not
  against Widmark. Km cross-checks too: Norberg 0.027 g/L vs Rangno 0.03 g/L.
  **Oral ships** with ka 1.29/h (Rangno) and **F assumed 1**, flagged by the derivation's
  own "overestimates exposure" warning — honest here because ethanol's absorption *is*
  essentially complete; the shortfall is first-pass metabolism, which **Oneta 1998** shows
  is governed by gastric emptying rather than being a constant. A single stored F could not
  express that. `illustrativeDoseMg` 28000 (= 0.4 g/kg, ~2 drinks): at the generic 500 mg
  opening, ethanol never approaches Km and draws a plain first-order exponential.
