# Pharmacographer — engineering history (archive)

Narrative record of how the engine, data layer, and UI reached their current
state: milestones, rejected alternatives, and advisor catches. **Not** a
must-follow instruction file — `CLAUDE.md` holds the working conventions and
`docs/DATA_GUIDE.md` holds the curation rules. This exists because the reasoning
(why an approach was rejected) is not recoverable from `git log`.

Newest first; test counts and commit hashes are as-of that milestone.

**THEOPHYLLINE — the third `linear: false` ship, and the first compound that had to CONTRADICT the
repo to be right (2026-07-17, advisor-reviewed, 512 tests, 45 → 46 compounds).** Pure data against the
existing MM engine: `docs/DATA_GUIDE.md` had named theophylline and salicylate "the plausible next MM
ships", needing only a citable Vmax/Km. **Wagner 1985** (Clin Pharmacokinet, PMID 3899457 — pooled
Vmax 1960 mg/day, Km 24.1 mg/L over 10 normal subjects) was the one missing datum; everything else was
already here.

- **Why it earns a slot next to phenytoin (a gentler nonlinearity, at a different SCALE).** Phenytoin's
  Km (7.9 mg/L) sits *below* its therapeutic range — already past half-saturation, cliff violent (+33%
  dose more than doubles Css). Theophylline's Km (24.1) sits just *above* its 10-15 mg/L range: it is
  used **on the bend**, not past it. Doubling 400 → 800 mg/day moves Css 6.2 → 16.6 mg/L (**2.69×**,
  built-curve verified) — supralinear enough to respect, gentle enough to dose against. The commoner
  clinical shape and the softer first lesson.
- **The isomer pair is the real payload.** Theobromine (linear, shipped) and theophylline (M-M) are both
  dimethylxanthines — same formula, same mass, differing only in which two of three nitrogens are
  methylated — on **opposite sides of the superposition line**. Switching between them changes the
  *model*, not the numbers. Nothing else in the set puts that boundary so close together.
- **THE ADVISOR CATCH — shipping a compound FALSIFIED prose in files the diff never had to touch.**
  `caffeine.json` (3 places) and `theobromine.json` both asserted, in shipped `notes`, that theophylline
  was *excluded as a standalone*. The moment it shipped those became false statements inside the
  epistemic-honesty product. **No test could ever see this**: `loader.test.ts` derives each file's own
  routes and never compares two files' claims. The generalised rule now in `DATA_GUIDE.md`: **before
  shipping a compound, grep the repo for its name** — a data-only ship is not a data-only diff.
- **And the flip is a BETTER note than the exclusion was.** The same molecule now ships in two
  representations — linear as caffeine's ~0.1-0.2 mg/L metabolite, nonlinear as the therapeutic-range
  standalone — because Km sits ~150-300× above the metabolite's concentration, where `Vmax·c/(Km+c)`
  collapses to `(Vmax/Km)·c`. The linear line **is** the saturable model's own low-concentration limit,
  the same tie the engine's `Km≫C` collapse test already pins. The `Km≫C` oracle, as data.
- **The discrepancy was owned, not smoothed (advisor).** The first framing — "7.2 h lands inside Lelo's
  5-9 h range, so they agree" — understated it. The honest reading: the pooled dilute-limit CL
  (`Vmax/Km` = 0.81 mL/kg/min) runs **~13% below** two independent direct measurements (Lelo 0.93,
  Gundert-Remy 0.94), same physical regime. The tempting fix — re-deriving Vmax so `Vmax/Km` equals
  Lelo's CL — was **refused**: Vmax and Km are correlated estimates from one fit, and moving one
  produces a saturation curve nobody measured.
- **What actually raised confidence was the FOUR-clearance ordering.** The FDA label's mean adult CL
  (0.65 mL/kg/min, range 0.27-1.03) is an *apparent* CL at therapeutic levels, so under saturation it
  must sit **below** the dilute-limit ceiling — and it does: the model gives 0.81 at c→0, 0.67 at 5 mg/L
  (≈ the label's mean), 0.50-0.57 across 10-15 mg/L. All four figures fall inside the label's own range
  and their *ordering* is what a saturable model predicts. Coherent picture, one named 15% residual.
- **The honesty point: a single Vmax/Km is a LUMPED fit.** Tang-Liu 1982 followed all three products to
  0.020 mg/L and found each pathway saturating separately (Km 2.7 / 9.3 / 14.2 mg/L) plus ~10%
  never-saturating renal. A sum of MM terms plus a linear term is **not** an MM term — so the stored Km
  (24.1) is a weighted composite measuring no enzyme. Wagner published it as exactly that. Right
  resolution for the lesson (clearance falls with dose), wrong resolution for the mechanism.
- **Vd is the one borrowed parameter, and that is argued, not smuggled.** `DATA_GUIDE.md` requires
  Vmax/Km/Vd from one source — but that rule exists for the *ethanol* case, where the payload is the
  zero-order slope `Vmax/Vd`. Theophylline is the *phenytoin* case: `Css = R0·Km/(Vmax−R0)` contains no
  Vd at all. Wagner reports no volume, so Vd comes from Lelo — chosen because it keeps this file
  byte-identical to `caffeine.json`, and corroborated by the label's 0.45 L/kg (0.3-0.7).
- **IV-only is the right landing, not a compromise** — IV aminophylline is a loading dose plus a
  constant-rate maintenance infusion, which is literally the `R0` in the Css relation. Oral is **parked
  on sourcing**, a lighter gate than phenytoin's category error: theophylline oral is real and well
  absorbed, it simply needs a citable *adult* ka (the one candidate found was paediatric, in a source not
  opened). An adult ka drops oral straight in as data.
- **Verification beyond the 512 green tests** (the standing trap): the built RK4 infusion plateau matches
  the algebraic `Css = R0·Km/(Vmax−R0)` to **0.0000%** at every rate — an oracle, not an eyeball — and
  0.4 mg/kg/h lands at 12.57 mg/L, inside the label's own 10-15 target (aminophylline ×0.8 cross-checked).
  A scratch misuse of `firstOrderLimitRateMM` (it returns `ke`, 1/h — *not* clearance) failed the check
  first; the engine was right and the check was wrong.

**PHENOTYPE PRESETS — the `geneticFactors` seam becomes load-bearing (2026-07-17, advisor-reviewed,
511 tests, 45 compounds).** §12's "variability beyond half-life". `geneticFactors` had sat in the
schema as a bare `string[]` on five compounds, rendered nowhere — the data said "CYP2D6 dominates
exposure here" and the app silently ignored it. This pass made a polymorphism selectable, and the
lead compound picked itself: **procainamide already carried both NAT2 phenotypes' numbers in its own
prose** (Lima 1979 fast/slow fm 0.40/0.20; Wierzchowiecki 1980 fast/slow t½ 2.4/3.6 h), so the
feature and its first data point shipped without opening a new citation.

- **It closed a real inconsistency; it is not decoration.** The engine takes ONE fm, so a bimodal
  compound had to anchor one phenotype and prose the other — and the half-life *range* had to be
  hand-narrowed to stay inside it, or the slider would drag the parent to a slow t½ while fm stayed
  pinned at the fast value: a state no real person occupies (the documented procainamide catch).
  Presets make that state **unreachable by construction** — switching swaps t½ and fm atomically.
  The two controls now compose as two levels: **preset = which population, slider = spread within it.**
- **The identity default (advisor catch, and the best idea in the pass).** The first sketch had a
  symmetric `presets[]` + a `default` pointer, which would have forced proving that the "fast" preset
  reconstructs the base values exactly. Inverted instead: `presets[0]` overrides **nothing** and the
  base values ARE the default phenotype (schema-enforced), so `applyPhenotype` returns the *same
  object* and the default render is the pre-feature compound **by construction**. The regression
  anchor became free — `expect(applyPhenotype(c, default)).toBe(c)` for all 45 compounds.
- **Pure Compound→Compound, applied before derivation** — so the engine stays pure and no `derive*`
  signature learned that phenotypes exist. Rejected threading a phenotype option through
  `deriveParams`/`deriveMetaboliteParams`/`buildCurve`: it would have put a genotype concept one
  layer from the engine boundary to achieve the same numbers.
- **The trap the schema now blocks:** `resolveKe` prefers a stored `clearance` over half-life, so a
  half-life override on a compound storing CL would be **silently discarded** — the curve would not
  move and nothing would error. An override that is ignored looks exactly like a feature that works.
- **Advisor corrected, on evidence.** The advisor characterised salicylate as needing an engine
  extension (parallel capacity-limited pathways); `docs/DATA_GUIDE.md` says the opposite in the
  project's own voice — theophylline and salicylate are "the plausible next MM ships", and it is
  omeprazole/naproxen that need a further model. Went with the repo. Separately, the advisor's
  suggestion to mine the rejection log for engine-blocked compounds paid off but **inverted**: the
  2-comp cluster (ciprofloxacin, escitalopram, sildenafil) is parked on *sourcing*, not on the
  engine — "the engine unblocked N compounds" would have been a false claim to build on.
- **The payoff, asserted rather than admired.** Both ratios are exact closed forms, so they are
  oracles: parent AUC ×1.5 (the t½ ratio) and NAPA AUC ×0.5 (the fm ratio — `AUC_m =
  fm·F·D/(k_m·Vd_m)` is *independent* of parent disposition, so the parent's slowing cancels out
  entirely). Verified in the built curve, not just in tests: parent Cmax 2883 → 3331 ng/mL while NAPA
  Cmax 1697 → 738, and the **NAPA/parent AUC ratio flips 1.95 → 0.65**. Launching the app confirmed
  the dashed NAPA line moving from above the parent to a low hump beneath it — parent up, metabolite
  down, in one click. "A slow metaboliser has more drug in them" is only half the story once the
  metabolite is active.

**NONLINEAR (Michaelis–Menten) PK — the excluded compounds ship (2026-07-17, advisor-reviewed, 486
tests, 43 → 45 compounds).** Phenytoin and ethanol were tagged "exclude, `linear: false`" in the
handoff on day one; this pass built the engine that could hold them honestly. It is the only feature
so far that **invalidated the engine's central abstraction** rather than extending it: every other
model is `Σ coef_λ·e^(−λt)` over the shared mode spine, and saturable elimination has no closed form
at all. So `modelsMM.ts` is a deliberate PARALLEL path to `dosing.ts` — the whole schedule integrated
as one RK4 initial-value problem, doses applied as state jumps — not a fourth branch of
`singleDoseConcentration`. Superposition is not approximated here; it is refused, and a test asserts
it *fails* (two doses run >10% above the sum of two single-dose curves), because that failure is the
justification for the whole module.

- **The meaning of `linear` had to change, and that was the subtle part** (advisor catch). The 2c/3c
  passes were clean model-splits because those compounds are `linear: true`; an MM compound *is*
  `linear: false`, which every resolver rejected and every doc equated with "excluded from v1". So
  `linear` narrowed to its literal meaning — *may these doses be superposed?* — the reject moved from
  `!linear` to "no resolver for this model", and linearity became a property **of** the model
  (`NONLINEAR_MODELS`), cross-checked rather than trusted.
- **`dispositionMM` REPLACES `disposition` rather than supplementing it** — unlike the 2c/3c blocks.
  A saturable drug has no half-life, so the schema forbids writing one. This is the pass's sharpest
  honesty decision: a stored `halfLife: 22` on phenytoin would be a category error, not a rounding
  error, and it is now unrepresentable.
- **Oracles, given no closed form.** Pinned by what *is* analytic: the IV-bolus implicit solution
  `Km·ln(C0/C)+(C0−C)=(Vmax/Vd)·t` (exact in the `t(C)` direction — the primary anchor, and what
  calibrated the RK4 step at the zero↔first-order transition where fixed-step is weakest); the AUC
  `(Vd/Vmax)(Km·C0+C0²/2)`; the algebraic steady state `Css = R0·Km/(Vmax−r0)`; **mass balance**
  `∫Vmax·C/(Km+C)dt = F·D` (the only oracle oral has, since MM AUC is genuinely route-dependent —
  slower input means less saturation means *less* exposure); and the `Km≫C` collapse onto the
  oracle-pinned `models.ts`, the MM analogue of the 2c `Q→0` collapse.
- **A failing test that was the test's fault, not the engine's.** Multi-dose mass balance missed by
  2.3e-4. An IV bolus makes the elimination flux genuinely discontinuous, so a trapezoid panel
  straddling a dose over-counts by ~½·dt·Δflux — an O(dt) error no grid refinement fixes. Predicted
  0.28 mg, observed 0.279. Fixed in the *quadrature* (integrate piecewise between doses); the error
  fell to <1e-5 with the engine untouched, which is what proved the diagnosis.
- **A magnitude check that looked like a failure and wasn't** (advisor catch). Norberg's ethanol Vss
  is ~0.51 L/kg vs Widmark's r ≈ 0.68, so peak BAC looked ~30% high. Widmark's r is a forensic
  back-extrapolation factor, not a measured volume — Norberg 0.51 and Rangno 0.47, two independently
  opened sources, agree with each other rather than with r. The lesson generalised into DATA_GUIDE:
  for MM, check the **slope** (`Vmax/Vd`, here 15.9 vs the canonical ~15 mg/dL/h) and the **steady
  state** (Vd-free), not the peak against a different model's fitting constant.
- **The defect only *running the app* could find.** Everything was green — 486 tests, lint, build,
  and a curve built from the real JSON — and ethanol still rendered as a textbook first-order
  exponential, because the interface opens every compound at 500 mg and half a gram of ethanol never
  approaches its Km (~7% saturated). The compound's entire point was invisible before the user
  touched anything. Hence optional `illustrativeDoseMg` (scale, explicitly not a recommended dose);
  ethanol opens at Norberg's own 0.4 g/kg. CLAUDE.md's standing trap says tests never prove magnitude
  — this pass adds that they never prove *pedagogy* either.
- **The honesty panels had to invert, not soften.** `ModelAssumptionsNote` said saturable drugs "are
  excluded here" — true until this pass, false the moment it landed. Under an MM curve the linearity
  bullet now states the opposite. `VariabilitySlider` gained a `NoRangeReason`, because its old "the
  source reports no half-life range" would be a plain **falsehood** under phenytoin, whose label
  reports 7–42 h — we decline to store it. A note that explains a deliberate omission as a missing
  datum is exactly the dishonesty the panel exists to prevent.
- **The find worth keeping.** The model reproduces the DILANTIN label's own half-life range from
  saturation alone: t½(c) = (Vd/Vmax)(Km·ln2 + c/2) runs ~15 h at trace to ~43 h at 20 mg/L,
  bracketing the label's "22 hours, range 7 to 42 hours" — one paragraph above the label's own
  explanation of why it cannot be a constant. The range mixes concentration-dependence with
  between-patient variability, and the model separates them; only the unreachable 7 h floor is
  genuinely the latter.
- **Deferred:** metabolites off an MM parent; 2-comp saturable (ethanol and phenytoin are both
  mildly 2-comp, collapsed); enzyme autoinduction (phenytoin's Vmax rises after ~59.5 h — documented,
  so the engine overstates chronic Css); and the non-MM nonlinearities (omeprazole's autoinhibition,
  naproxen's concentration-dependent binding) which need a different model, not just parameters.

**ORAL MORPHINE → M3G + M6G via `ffp` — FIRST first-pass compound SHIPPED (2026-07-10, advisor-reviewed,
422 tests).** The `ffp` curation pass. Oseltamivir was EVALUATED as the intended flagship and REJECTED
on a NEW reusable screen — the **first-pass TIMING screen** (the `ffp` analogue of the `F·D/V` ceiling
test): the `ffp` term routes pre-systemic mass at the PARENT's `ka` (conversion-fast-vs-absorption
assumption), so it is faithful only when **metabolite Tmax ≈ parent Tmax**. Oseltamivir's carboxylate is
formation-rate-limited (single-dose oral: carboxylate Tmax ~6 h ≫ parent 0.5 h, an ~8–12× violation on
the DOMINANT line — the single-`ka` model would invert its slow-rise into an early spike), a
refuse-don't-mislead case; deferred pending an `ffp` extension that decouples the metabolite input rate
from the parent `ka`. **MORPHINE passed** (glucuronidation is fast; SC glucuronide Tmax ~0.25–0.6 h ≈
parent) and is the STRONGER validation — the GENERAL case (`fm>0` AND `ffp>0`: systemic glucuronidation
PLUS first-pass), not oseltamivir's degenerate `fm≈0`. Oral added to the already-shipped IV morphine
(routes now oral + iv_bolus; **default landing route now ORAL** — matches every oral+IV compound; IV curve
byte-identical, `ffp` oral-only). Each glucuronide's `ffp` = `fm_i(molar)·(1−F)` MW-adjusted ×1.617 →
**M3G 65.6%, M6G 11.9%**, all from single-population Hasselström 1993 (`fm` + F 29.2%). KEY HONESTY CATCHES
(advisor completion-review): (1) `fm·F + ffp = fm` is a CONSTRUCTION IDENTITY (`ffp:=fm·(1−F)`), so the
built-curve match (oral M3G AUC 2.159 ≈ IV 2.158) is an engine-WIRING check, NOT a validation of `ffp` —
reworded from "elegant anchor"; (2) first pass is purely HEPATIC (no renal-unchanged escape), so `ffp` is
a MILD UNDER-estimate and real oral glucuronide sits modestly ABOVE IV, not equal (direction documented);
(3) magnitude checked vs Osborne 1990 (model oral M3G:morphine AUC ~29 mass ≤ reported ~30 molar/~50 mass
→ glucuronide exposure CONSERVATIVE; the tall ~500 ng/mL M3G Cmax is the intrinsic-t½ compressing a
conservative AUC into a sharp peak — the documented no-enterohepatic caveat, same as IV). New source
`osborne_1990` + `atrux_tallau_2022` (oral Tmax 0.8 h). Seed set unchanged at 39 (route add, not new
compound). **Oseltamivir's deferral is now the TIMING screen, not the engine.**

**ORAL FIRST-PASS METABOLISM — engine capability LANDED (2026-07-10, advisor-reviewed, 419 tests;
engine-first spike, NO compound at capability-landing).** Removes the wall that DEFERRED oseltamivir + every oral
route whose bioavailability loss is first-pass conversion (oral morphine/nicotine/ketamine, psilocin).
New optional per-metabolite **`firstPassFraction` (`ffp`)** routes the pre-systemic (gut/hepatic
first-pass) mass to the metabolite as a single ADDITIVE oral-only Bateman term
`batemanMode(ka·ffp·D, ka, k_m, t)/Vd_m` — the pre-systemic mass appears as an oral-absorption input
into the metabolite compartment at the PARENT's `ka` (hepatic conversion fast vs absorption, the
standard simplification, stated in the engine header). Oral-only (IV bypasses first-pass — the bolus/
infusion metabolite paths ignore `ffp`); total oral metabolite `AUC = (fm·F + ffp)·D/(k_m·Vd_m)`, the
`ffp` term ka-independent. **Collapse anchor:** `ffp` absent/0 reproduces every current curve BYTE-FOR-
BYTE (oracle asserts `.toBe`) — protects all 39 shipped compounds. A PURELY pre-systemic metabolite
(`fm = 0, ffp > 0`, the oseltamivir shape) computes cleanly; the derive guard now allows `fm = 0` when
`ffp` carries formation (invariant: `fm + ffp > 0`, each in [0,1]). Files: `types.ts`
(`MetaboliteDisposition.firstPassFraction?`), `metabolite.ts` (`presystemicMetaboliteConcentration` +
oral-path add + header), `schema.ts` (optional `firstPassFraction` param + sourceRef check), `derive.ts`
(resolve `ffp`, reworked plausibility guard). `curve.ts` unchanged — `ffp` rides on the derived
`MetaboliteDisposition`. **`provenance.ts` DID change** (advisor completion-review catch): `ffp` is a
new sourced full-provenance parameter, so `metaboliteProvenanceEntries` now emits a `firstPassFraction`
row (label "First-pass fraction (ffp)", between fm and Vd) with its own citation + percent→fraction
derivation grouping — else the citation would live in the JSON but never render, silently undercutting
the "is `ffp` citable?" honesty gate (acute for oseltamivir, whose whole story IS the first-pass
carboxylate). Oracles (metabolite.test.ts): collapse `ffp→0` exact; new-term AUC ka-independent;
**unified RK4 on the COMBINED ODE `dA_m/dt = fm·CL·C_p + ka·ffp·D·e^(−ka·t) − k_m·A_m`** (checks BOTH
terms' sign+superposition at once); IV-ignores-ffp; pure-pre-systemic case. **HONESTY GATE (curation,
docs/DATA_GUIDE.md):** the real gate is "is `ffp` for THIS specific metabolite CITABLE?" — partial
attribution fine IF sourced (cotinine gets only its share); **do NOT also shave `F`** (double-counts —
`ffp` is purely additive); mass balance `ffp ≤ 1 − F − f_unabsorbed` (curation check, NOT engine-
enforced); MW-adjust molar→mass like `fm`. `ffp` is an illustrative population constant (bright line
holds). **Oseltamivir's deferral is now a CURATION decision, not an engine limit.**

**MORPHINE (→ M3G + M6G) + DIGITOXIN (2026-07-10, advisor-reviewed, 408 tests):** 38th + 39th
compounds — the two vetted-next candidates. **morphine** = the parallel-glucuronidation centrepiece
and the FIRST compound with an active AND inactive metabolite drawn together (**M3G is the FIRST
`active: false` metabolite shipped** — legend reads "— metabolite"). One-comp EFFECTIVE parent
(CL 1.27 + Vss 2.9 → t½ 1.58 h ≈ FDA "effective ~2 h"; the ~15 h sensitive-assay terminal is a
low-amplitude deep phase, CANNOT be a 1-comp t½ [would force CL ~10× too low], documented-not-modelled
— remifentanil/warfarin posture); IV-BOLUS ONLY (oral deferred, oseltamivir criterion — ~29% oral F
is pre-systemic first-pass glucuronidation). **KEY CURATION CALL (Option A):** the glucuronides'
APPARENT post-morphine half-lives (M3G 11.2 / M6G 12.9 h, Hasselström) are formation-limited +
enterohepatic artefacts (unmodelable by a superposition engine); their INTRINSIC elimination
(M3G 1.66 h Penson 2001 / M6G 2.05 h Hanna 1991, direct-IV) is stored instead — B (store apparent
as "elimination") REJECTED because it corrupts the honesty panel + breaks the renal-accumulation
teaching; C (multi-comp parent) REJECTED (~1% amplitude phase + still unmodelable enterohepatic).
AMOUNTS stay faithful (AUC_m=fm·D/CL_m); only the shape's tail is shortened → teaching caveat.
**General rule:** intrinsic > apparent for the honesty panel; contrast cefotaxime where apparent IS
elimination-limited (honest). fm ×1.617 (glucuronides HEAVIER, MW 461.46 vs 285.34): M3G 57.3→92.7%,
M6G 10.4→16.8%, sum >100% expected. Single-population: Hasselström 1993 (parent + both molar fm).
10 mg IV → C(0) 49 ng/mL, M3G 151 / M6G 24 ng/mL (AUC ratio 5.7). **digitoxin** = long-t½ / small-Vd /
high-protein-binding (~97%) counterpoint to digoxin (t½ 6.5 d vs 1.5 d; Vd 0.5 vs 5–7 L/kg). ONE-COMP
(MacFarland 1984 specific-assay CL/Vd/t½ internally 1-comp-consistent: CL=ln2·Vd/t½=2.44 mL/min exactly;
NOT the 2-comp the old vetting note guessed — no clean α/Vc, distribution negligible vs 6.5-DAY terminal).
linear:true anchored to Ochs 1982 (accumulation t½ 7.9 d ≈ single-dose 8 d; SS 15.4 ≈ predicted 15.3).
Parent-only (no dominant citable fm). Oral (F 81.5% specific-assay, honest vs ~98% RIA over-estimate) +
IV bolus; Tmax flagged curatorial 1 h (none published; ka≫ke makes curve Tmax-insensitive). Largely
historical/discontinued. NTI. 1 mg IV → C(0) 30 ng/mL (10–30 range, ~10× digoxin).

**ON-SCREEN COMPOUND PROSE (2026-07-10, 405 tests, `feat(ui)` `138f045`, pushed):** three
user-facing text fields, distinct from the curator-only `notes` — `description` (REQUIRED,
schema `.max(400)`: what the compound is + typical use), rendered in a **FIXED-HEIGHT "About" box
ABOVE the chart (the fixed height is the no-jump mechanism — switching compound never moves the
chart top)**; optional compound-level `metabolism` (uncapped) + per-metabolite `description`,
rendered BELOW the chart (free to grow). New `CompoundInfo.tsx` (`CompoundAbout`+`CompoundMetabolism`),
`.about`/`.metabolism` CSS, `tests/ui/compound-info.test.tsx` pins the no-jump contract. Backfilled
`description` on all 36 prior compounds. **RULE: every compound MUST carry a `description`** (see
Conventions + docs/DATA_GUIDE.md "User-facing prose"); for a toxin say what it IS, not a therapy.

**NICOTINE → COTININE (2026-07-10, advisor-reviewed):** 37th compound — a toxin + drug + metabolite
in one. Directly-parameterized THREE-comp (Gisleskog 2021 popPK, 930 subjects; CL 67.4 L/h, V1 117,
V2 130, V3 53.4 L, Q2 38.6, Q3 216 L/h — nothing derived offline, remifentanil template), **IV-BOLUS
ONLY** (oral DEFERRED on the oseltamivir criterion — ~40% oral F is pre-systemic first-pass to
cotinine the systemic engine can't represent). **FIRST shipped 3-comp-PARENT metabolite** (cotinine,
`metabolite3cConcentrationCurve` with real data). Teaching point INVERTS remifentanil: γ t½ ~4.5 h
carries a REAL ~16% amplitude (α ~39% / β ~45% / γ ~16%), and the textbook "~2 h" is an APPARENT
terminal blending β+γ from limited sampling — a single half-life UNDER-reports here (remifentanil
over-reported). Q3 largest but V3 small ⇒ compartment 3 is the FAST one (α phase). fm MW-adjusted
mass ≈80% = molar 70–80% × 176.21/162.23 = ×**1.086** (>1: cotinine HEAVIER than nicotine — inverse
of caffeine's lighter metabolites). Cotinine Vd 56.5 L + t½ 12.2 h = De Schepper 1987 IV (directly
measured); elimination-limited (12 h ≫ 4.5 h) = the biomarker teaching point. C(0)=Dose/V1: 2 mg IV
→ 17 ng/mL, cotinine peaks ~17 ng/mL @7 h. VETTED-NEXT (docs/DATA_GUIDE.md): morphine→M6G+M3G
(parallel glucuronides), digitoxin (long-t½ foxglove toxin).**

**Earlier Phase 7 state (unchanged below):** SEED SET was 36 compounds. A seventh 2026-07-10 pass (METHYLXANTHINES, 35→36, 399 tests green,
advisor-reviewed; later EXTENDED to draw ALL THREE caffeine metabolites — see next para) gave the
existing `caffeine` its metabolites and shipped `theobromine`:
caffeine→`paraxanthine`+`theobromine`+`theophylline` (CYP1A2 makes THREE parallel metabolites —
paraxanthine ~80% / theobromine ~11% / theophylline ~4% molar of total clearance; **the metabolite
engine is N-metabolite, NOT single** — `buildCurve` maps over `compound.metabolites` → one
`MetaboliteCurve`/`<Line>` each, 4 cycled colours + legend + per-metabolite provenance group — so all
three demethylation products draw as independent Batemans off the shared parent CL [`fm_i·CL·C_p`], the
physics of parallel metabolism; theobromine ALSO ships standalone; theophylline drawn HERE [low-conc,
linear-valid ~0.1–0.2 mg/L] but EXCLUDED as a STANDALONE [M-M nonlinear at therapeutic 10–20 mg/L] — no
contradiction); anchored to Lelo 1986 (caffeine + all 3 metabolites in the SAME 6 volunteers, the
one-population source) + its partial-clearances companion. **KEY REUSABLE PRECEDENT — the fm MW
conversion:** Lelo's "79.6% of total clearance" is a MOLAR fraction, but the engine's fm multiplies
parent MASS (no MW field), so mass-fm = molar × MW(metabolite 180.16, all 3 are dimethylxanthine
isomers)/MW(caffeine 194.19) = ×0.928: paraxanthine 0.74, theobromine 0.10, theophylline 0.034 (stored
74/10/3.4, derived:true) — matches allopurinol's stored mass ratio "90 mg per 100 mg"; whenever fm
is sourced as a clearance/molar fraction, MW-convert before storing. paraxanthine formation-rate-limited
(t½ 3.1<parent 5 h, peaks 1.02 @6h); theobromine + theophylline BOTH elimination-limited (t½ 7.2/6.2 >5 h,
peak 0.17 @9h / 0.08 @8h for 200 mg oral) — a clean formation- vs elimination-limited teaching set.
`theobromine` = the chocolate methylxanthine, clean linear 1-comp standalone (Lelo t½ 7.2 h,
Vd 0.75 L/kg=CL·t½/ln2; Baggott 2013 Tmax 3 h; apparent-volume F=1; NO metabolite line [no dominant
citable fm — pregabalin posture]; cross-ref: also caffeine's ~10%-mass-fm metabolite, byte-identical
disposition between the two files; linear counterpoint to excluded theophylline isomer; oral only;
500 mg → 7.1 mg/L). The earlier
sixth 2026-07-10 pass added an ILLICIT / RECREATIONAL slate (30→35, 403
tests green, advisor-reviewed): four clean linear 1-comp singles — `lsd` (Liechti-group human PK,
Dolder 2016/2017 + Holze 2021; apparent-volume convention V/F ~40 L, true F ~71%; the microgram-dose
/ ~1–4 ng/mL axis; dose-proportional 5–200 µg; ~2.6 h main phase + documented-not-rendered ~8.9 h
terminal; 200 µg → 3.35 ng/mL), `psilocin` (model the ACTIVE species, not the psilocybin prodrug —
psilocybin dephosphorylates pre-systemically, oseltamivir posture; `displayNote` says dose=psilocybin/
curve=psilocin; the MW 284→204 molar 0.719 AND ~55% F are BOTH folded into the psilocybin-normalised
apparent Vz/F ~900 L so F=1 with no explicit factor; dose-proportional 7–59 mg; 25 mg → 17.5 ng/mL),
`methamphetamine` (Desoxyn/crystal meth; 1-comp per Schepers 2003; Vd 3.73 L/kg IV, t½ ~10 h that is
URINE-pH CONDITIONAL 6–31 h [lamotrigine posture, not a dose-nonlinearity]; oral F ~0.67 softest;
oral available + iv_bolus inferred; meth→amphetamine NOT drawn — CYP2D6-bimodal fm, procainamide
disqualifier; 10 mg → 21.6 ng/mL), `dextroamphetamine` (Dexedrine/speed; firm FDA-label anchor 15 mg
→ 36.6 ng/mL; Vd 4.4 L/kg Cmax-consistent, t½ ~10 h; oral + iv_bolus inferred; 35.6 ng/mL built) —
plus the METABOLITE centerpiece `ketamine`→norketamine (Special K; 2-COMP parent α t½ ~14.5 min/β 2.5 h
via diazepam-style offline Q/Vp from CL/Vc/Vss/β; FDA Ketalar + Clements 1982 + Mion 2013 + Kamp 2020;
IV/IM ONLY because oral first-pass F ~17% makes norketamine pre-systemic [oseltamivir]; fm ~80% a SINGLE
citable N-demethylation number; norketamine active ⅓-potency, t½ ~5 h > parent = elimination-limited/
accumulates, Vd 1.39 L/kg derived nordiazepam-style; drawn on iv_bolus AND iv_infusion; TIMING CAVEAT —
model peaks ~3.3 h vs label ~30 min [slow metabolite accumulation-dominated by β-phase parent; magnitude
+ long tail faithful, peak late, allopurinol posture]; 100 mg IV → C0 1.43 µg/mL, norketamine ~0.44).
NOT shipped, documented in docs/DATA_GUIDE.md: `cocaine`→benzoylecgonine DEFERRED (double disqualifier —
dose-dependent CL≈2.51−0.67·dose saturable-esterase nonlinearity AND genuinely 2-comp; ketamine shipped
in its place; the BE forensic-marker pair was representable off a 2-comp parent [fm ~40–45%, BE t½ ~6 h,
BE Vd ~0.75 L/kg from the measured BE:cocaine AUC ratio 10.1] had CL been dose-independent), `mdma`
EXCLUDED (linear:false — CYP2D6 autoinhibition, dose-disproportionate AUC, omeprazole class), `thc`
DEFERRED (deep multi-comp, days-long fat-driven terminal), `heroin`→6-MAM→morphine DEFERRED (two-step
sequential cascade — the engine forms N metabolites in PARALLEL from the parent [single-STEP] but not a
metabolite OF a metabolite [a chain]). A fifth 2026-07-10 pass (renal / metabolite / ion axes) added three (27→30, 392
tests green, advisor-reviewed slate): `pregabalin` (clean linear 1-comp; the LINEAR counterpoint to
gabapentin's saturable dose-DEPENDENT absorption — FDA Lyrica label F ">=90% and independent of dose",
no protein binding, ~90% renal unchanged, Vd 0.5 L/kg, t½ 6.3 h, oral only; 300 mg → engine 6.5 vs
reported ~7.5 µg/mL, ~13% under because the real Cmax rides the F·D/V ceiling — acyclovir posture;
no metabolite, renally cleared unchanged), `allopurinol`→`oxypurinol` (the THIRD parent→metabolite
pair and FIRST to exercise the engine's ORAL-parent metabolite path on real data; the flagship
"active metabolite dominates" case — parent t½ ~1.5 h largely a prodrug for oxypurinol which peaks
later/higher/longer, ~6.5 vs ~3 µg/mL for 300 mg oral, t½ ~18 h; FDA Zyloprim label + Day/Graham 2007
review; all three gates cleared — linearity dose-proportional 100–600 mg with weak saturation only at
900 mg/day, Cmax-consistent parent Vd ~0.65 L/kg since the review's apparent 1.31 under-predicts,
citable fm ~90%; HONESTY CAVEAT — some oxypurinol forms PRE-SYSTEMICALLY via gut/liver xanthine
oxidase, which the systemic-formation engine can't separate, showing up as a modelled peak ~7 h vs
label ~4.5 h and a metabolite Vd set ~20% below the sourced ~0.53 to hit the measured Cmax; anchored
to the label's directly-measured Cmax so magnitude matches), and `lithium` (the only INORGANIC ION;
new class = mood stabilizer; modelled TWO-COMPARTMENT per user choice so the distribution phase is
faithful — complements digoxin on the opposite Vd axis; three teaching points — NOT metabolized
[element, no metabolite line, no hepatic variability], renal/sodium-dependent NTI [~80% proximal
reabsorption with Na], and the STANDARDIZED 12-H SERUM SAMPLE that waits out the α t½ ~1.4 h
distribution phase; FDA Li-carbonate label + Arancibia 1986 [PMID 3089949, the directly-reported
2-comp params]; CL 0.0241/Vc 0.224 read straight from the paper, Q 0.0517/Vp 0.258 derived offline
diazepam-style [α t½ 1.40 h, β 0.0435/h], engine round-trips α t½ 1.40/β t½ ~15.9 h, Vc+Vp 0.482
reproduces the paper Vss 0.445; UNITS are a documented choice — models ELEMENTAL Li in mg,
/6.94 = mmol/L, 300 mg Li₂CO₃ = 56.4 mg Li, 900 mg/day → SS peak ~0.73 mmol/L in the therapeutic
0.6–1.2 range. NOTE: the compartmental micro-values were first mis-attributed to an unverified
from-memory citation — caught in advisor review, re-sourced to the opened Arancibia 1986 paper). **oseltamivir→carboxylate
EVALUATED + DEFERRED same pass** (pre-systemic conversion — Tamiflu label: <5% systemic parent, ≥75%
of dose appears as metabolite via HEPATIC first-pass esterases, so a systemic-formation engine can't
represent it; the screening property that keeps allopurinol IN and this OUT). The earlier fourth
2026-07-10 pass (new classes + teaching axes) added three clean linear 1-comp drugs (all 389 tests
green), each ceiling-tested + magnitude-checked against the built engine curve, every value pulled
from a source opened that session: `ethosuximide` (succinimide, the new class + very-long-t½
accumulation teacher; FDA Zarontin label is thin so t½/Tmax/binding from the EMC SmPC and
F/Vd/metabolism from StatPearls→Patsalos 2008; adult population; oral-only like lamotrigine;
500 mg single oral → ~9 mcg/mL but 20 mg/kg/day accumulates to the 40–100 mcg/mL steady-state range,
engine qd SS peak ~90), `famotidine` (H2-blocker, the new class + ~43%-F middle point between
metronidazole ~100% and acamprosate ~11%; FDA Pepcid label + Echizen review for label-absent Vd
1.15 L/kg; renal thread; 20 mg oral → 67 ng/mL matches reported ~67; S-oxide metabolite NOT modelled,
no citable fm; oral+both IV), and `warfarin` (the SMALL-Vd 0.14 L/kg / 99%-bound axis — opposite
extreme from propofol's Vss ~260 L; FDA Coumadin label + a single-dose enantiomer study PMC3555060;
canonical linear 1-comp; THREE documented caveats — (1) dual half-life: models the EFFECTIVE ~40 h
not the 1-week terminal, which is clearance-forced (CL=ln2·Vd/t½≈0.17 L/h at 40 h is real, the
terminal implies implausible ~0.04); (2) racemate collapse R 51 h/S 33 h; (3) THE HONESTY EXEMPLAR —
concentration is NOT effect, peak anticoagulant effect delayed 72–96 h vs the ~3 h concentration peak;
25 mg racemic oral → 2.42 mg/L vs reported ~2.7; oral + INFERRED iv_bolus available:false since IV
warfarin isn't reliably marketed post-2020; NTI). **theophylline evaluated + EXCLUDED same pass**
(capacity-limited Michaelis–Menten elimination at therapeutic range — the phenytoin nonlinearity;
exclude-with-rationale, not ship-with-caveat). The earlier antimicrobials pass added three clean linear 1-comp drugs (all 384 tests green),
gated by the new `F·D/V` CEILING TEST (for a 1-comp model F·D/V is a hard ceiling on the peak;
if it sits below the reported Cmax the drug is too distributed for 1-comp — defer or go 2-comp;
see docs/DATA_GUIDE.md): `metronidazole` (5-nitroimidazole, oral+IV, ~100% F so oral≈IV Cmax;
FDA Flagyl label + Clin Pharmacokinet review for the label-absent Vd; 0.55 L/kg Cmax-consistent,
500 mg oral → 11.4 mg/L vs labeled ~12; active hydroxy metabolite noted-not-modelled, no citable
fm), `levofloxacin` (the clean FLUOROQUINOLONE shipped in ciprofloxacin's place — F ~99%, small
distribution phase; FDA Levaquin label, Vd 82 L absolute within labeled 74–112 L, 500 mg oral →
5.08 vs labeled 5.1; the ceiling test's positive case where cipro's failed), and `acyclovir`
(ANTIVIRAL, new class; shipped IV-ONLY — oral OMITTED for saturable absorption / the valacyclovir
rationale, iv_bolus `available:false`/inferred because it must be infused slowly to avoid renal
crystallisation; FDA acyclovir-injection label + de Miranda review for Vd; 0.55 L/kg, steady-state
5 mg/kg q8h peak 8.9 vs labeled 9.8). Two candidates DEFERRED same-root-cause (1-comp ceiling
below Cmax = genuine multi-compartment, no clean single-population 2-comp source): `ciprofloxacin`
(Cmax↔AUC imply ~2× different V/F) and `sildenafil` (F·D/Vss 390 < Cmax 440; override to V~80
would hide a ~50% AUC over-prediction). The earlier
2026-07-10 pass added three (killer-param-vetted then magnitude-checked, all 377 tests green):
`atenolol` (clean linear 1-comp; the RENAL counterpoint to hepatic metoprolol — hydrophilic,
>85% renal unchanged, no CYP2D6 polymorphism, ~50% F is an absorption limit not saturable
first-pass; FDA Tenormin label + an enantiomer PK study for the label-absent Vd ~0.8 L/kg;
100 mg oral → Cmax ~650 ng/mL), `lamotrigine` (clean linear 1-comp, oral only; the
CONDITIONAL-half-life teacher — modelled monotherapy t½ ~25 h, documented ~14 h with enzyme
inducers / ~60–70 h with valproate, NOT auto-applied; FDA Lamictal label + Garnett 1997;
F ~98%, Vd/F ~1.1 L/kg treated as true volume à la fluconazole; 200 mg oral → Cmax ~2.4 µg/mL),
and `propofol` (the SECOND 3-comp compound, Schnider 1998, directly parameterized like
remifentanil — V1 4.27/V2 18.9/V3 238 L, Cl1 1.89/Cl2 1.29/Cl3 0.836 L/min at the Schnider
reference point; keyed to Sahinovic 2018 PMC6267518; IV bolus + infusion both genuinely
available; α/β/γ t½ 0.72/15.2/287 min with an IV-bolus amplitude split ~97.4/2.4/0.17% — the
redistribution-wake-up story where it's clinically famous; 150 mg bolus → 35 µg/mL transient
→ ~2.6 µg/mL at 3 min → ~0.6 at 10 min; linear modelled as TCI does, documented approximation).
The earlier 2026-07-09 pass had brought the set from 10→18: a
2026-07-09 data pass added `levetiracetam`, `fluconazole`, `phenobarbital` (clean
linear 1-comp oral+IV — renal clearance, long-t½ loading dose, very-long-t½
accumulation / the LINEAR counterpoint to excluded phenytoin), `digoxin` (FIRST
oral two-compartment compound — the distribution-phase teacher; Konishi 2014 popPK
model; oral + IV bolus; α t½ ~0.9 h carrying ~82% of C(0) then β t½ ~48 h — the
"wait 6–8 h to sample" lesson, magnitude-checked: 0.5 mg IV → C(0) ~4.5 ng/mL
falling to ~0.8 into the 0.5–2 therapeutic window), `vancomycin` + `gentamicin`
(IV 2-comp TDM archetypes, representative normal-renal-function params documented
diazepam-style; peak/trough teaching), and `cefotaxime`→desacetylcefotaxime (the
2nd metabolite pair and the FIRST compound to exercise the ORIGINAL 1-comp-parent
Bateman-metabolite path — modelled 1-comp via a documented ibuprofen-style collapse;
`fm` stored as 25% with the cited 19±4% urinary recovery as an explicit lower bound,
NOT a bare "~33%"). All 370 tests / lint / build green; each magnitude-checked
against reported concentrations. PARKED verdicts refreshed in docs/DATA_GUIDE.md:
lisinopril stays deferred (no clean adult V/F; dual 40 h/12 h half-life makes a
single-compartment V/F ambiguous). **`acamprosate` SHIPPED** as the FIRST flip-flop
compound (user approved the DR judgment call): 1-comp, true ke from IV t½ 3 h, ka
inverted from oral Tmax 7 h → ka ~0.081 < ke 0.231 (genuine flip-flop, exercises the
`curveHorizon*` flip-flop tail on real data); IV bolus offered as INFERRED (no marketed
IV product) so the true-vs-apparent half-life contrast shows; single-ka underestimates
the DR 20–33 h tail (documented approximation). 371 tests green. Post-v1: the metabolites (§12) engine core
landed as a spike; the **multi-compartment (2-compartment) §12 engine extension**
landed AND is wired into the app (bolus/infusion/oral + metabolites); the first
2-comp compound (diazepam→nordiazepam) shipped; the **3-compartment (Stage B)
engine extension** landed (cubic eigenvalues via bracketed bisection, RK4-cross-checked);
and that 3-comp model is now **fully wired through data + UI with the first 3-comp compound
shipped — remifentanil (Minto model), IV bolus + infusion (308 tests)**. Since then: **oral 3-comp
ka-from-Tmax derivation landed** (`kaFromTmax3c`; oral wired through `deriveParams3c`/`buildCurve3c`),
**oral-PARENT metabolites landed** via residue-form parent modes, and **IV-infusion-parent metabolites
landed** via the zero-order-input convolution (`batemanModeIntegral`) — the metabolite gate is now
`iv_bolus || oral || iv_infusion` across all three models (354 tests). Oral-3comp and oral-parent
metabolites are engine-capability-only (no shipped compound exercises them — remifentanil/diazepam are
IV-only), but the infusion-metabolite gate widening is NOT inert: diazepam has a metabolite and all IV
routes are user-selectable, so **diazepam/iv_infusion now draws nordiazepam** (physically correct,
route-independent AUC already validated; the default landing view stays iv_bolus, unchanged). See the
per-milestone notes below. The **flip-flop oral horizon LANDED** (`fix(ui)`, 355 tests) — the three
`curveHorizon*` functions now size the oral tail on the SLOWER of ka and the terminal disposition rate
(`min(ka, ke/β/γ)`), so a flip-flop compound (ka < ke) isn't clipped mid-decay; reduces exactly to the
old `5·ln2/ke + 3·ln2/ka` when ka > ke (zero regression on every normal compound), engine-capability-only
(no shipped compound is flip-flop). The **static-site deploy remains the sole open Phase 7 item**.**

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
oral-parent has since LANDED** (residue-form parent modes; the gate is now `iv_bolus || oral` — see
the oral-parent metabolites note below).

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

**Oral 3-comp ka-from-Tmax derivation — LANDED (`feat(engine)`, 330 tests).** `deriveParams3c`
previously threw on oral; now `kaFromTmax3c` (the four-exponential analogue of `kaFromTmax2c`
— same bracket-and-bisect on the single peak equation `C′(tmax; ka)=0`, using `threeCompModes`
for the g_λ and `batemanModeDerivative`) inverts a reported Tmax, and the oral branch of
`deriveParams3c` is wired (F handling, ka measured-or-Tmax-inverted, flip-flop warning against
the terminal eigenvalue **γ** — the smallest, so the oral terminal slope is −min(ka,γ) and ka<γ
is exactly the flip-flop condition; consistent with 2c's ka<β). `curve.ts` `curveHorizon3c`/
`criticalTimes3c` gained an oral branch (tail +~3 ka half-lives; densify over max(α,ka); pin the
exact `oralPeakTime3c` Bateman peak). Oracles: `kaFromTmax3c` round-trips through `oralPeakTime3c`
and collapses to `kaFromTmax2c` as Q3→0; `buildCurve3c` oral starts at C(0)=0 with the marked
peak pinned on Tmax. Engine capability only — no shipped 3-comp compound declares an oral Tmax
(remifentanil is IV-only), same posture as oral-2c Stage A.

**Oral-PARENT metabolites — LANDED (`feat(engine)`, residue-form parent modes, 343 tests).** The
metabolite gate widened from IV-bolus-only to **`iv_bolus || oral`** across ALL THREE disposition
models (and `buildCurve3c` gained a metabolite path it never had). An oral parent's central
concentration is a sum of Bateman terms, not plain exponential modes; re-expressing it in RESIDUE
form (`engine/metabolite.ts` `oralParentResidueModes`: one mode at rate ka with coef `Σ B_λ`, one
per disposition rate λ with coef `−B_λ`, where `B_λ = ka·F·D·g_λ/(λ−ka)`) yields plain
`coef·e^(−rate·t)` modes that feed the SAME `metaboliteConcentrationFromModes` core the IV cases
use — so ONE oral core (`oralMetaboliteConcentrationFromModes`/`oralMetaboliteConcentrationCurve`)
serves a 1-, 2- or 3-compartment oral parent (1c is the single-`1/Vd`-mode instance). `curve.ts`
wires it into all three build paths (route-branch IV vs oral; 1c formation still driven by the
plotted `mainKe` so the slider reshapes it). The `B_λ` denominator has a removable double pole at
`ka ≈ λ` that the residue SPLIT cannot represent (would need a `t·e^(−λt)` limit term), so the
builder THROWS a clear message (linearity-gate refuse-don't-mislead posture; `threeCompModes`'s
"does not arise for physical parameters" stance) — **note the asymmetry: this throw propagates out
of `buildCurve` and blanks the WHOLE curve, not just the metabolite line, so a future oral+metabolite
compound whose ka coincides with a disposition eigenvalue loses the parent curve too** (a 1c oral
PARENT alone renders fine at ka≈ke via `batemanMode`'s equal-rates limit — only the metabolite path
refuses). IV-infusion-parent metabolites (zero-order input) landed shortly after — see the note below. Oracles:
C_m(0)=0; `AUC_m = fm·F·D/(k_m·Vd_m)` (CL and (λ−ka) cancel — only F remains); an **independent RK4
integration** of `dA_m/dt = fm·CL·C_p(t) − k_m·A_m` (C_p from the engine's oral parent curve) matches
the analytic curve, catching residue-coefficient SIGN errors the scalar AUC can't; collapse ka→∞
reproduces the IV-bolus metabolite and Q→0 collapses 3c→2c→1c; superposition; ka≈λ refusal. The UI
chart/ProvenancePanel are model-agnostic consumers of `curve.value.metabolites`, so the oral line +
honesty-panel rows follow with NO component change (verified via node driver: oral line + provenance
group render; infusion draws neither; both seams correct). **For the ORAL gate widening specifically,
the change is INERT for every shipped compound** — diazepam is the only compound with a metabolite and
it has no oral route, so no shipped compound's ORAL output changes (the infusion widening below is the
one that is NOT inert).

**IV-infusion-PARENT metabolites — LANDED (`feat(engine)`, zero-order-input convolution, 354 tests).**
The metabolite gate widened again, from `iv_bolus || oral` to **`iv_bolus || oral || iv_infusion`**
across all three models. An infused parent's central concentration is a rectangular zero-order-input
window convolved with the disposition — NOT a plain mode sum and NOT the oral residue form. But the
whole parent→metabolite chain is linear/time-invariant, so the metabolite of an infusion is the SAME
window convolved with the metabolite's unit-bolus Bateman impulse response `h(t)` — i.e. a difference
of running Bateman areas, one closed form spanning DURING and AFTER the infusion with no seam
bookkeeping: `C_m(t) = (R0/Vd_m)·Σ_λ [ I_λ(t) − I_λ(max(0,t−T)) ]`, `I_λ = ∫₀ᵘ batemanMode(fm·CL·g_λ,
λ, k_m, ·)`. The new primitive is **`modes.ts` `batemanModeIntegral`** (sibling to `batemanMode`/
`batemanModeDerivative`, same byte-identical `λ≈k_m` equal-rates limit); **`metabolite.ts`** adds
`infusionMetaboliteConcentrationFromModes`/`infusionMetaboliteConcentrationCurve` (drive the primitive
off `g_λ`, skip any `λ=0` collapse mode like `infusionConcentrationFromModes`), serving a 1-/2-/3-comp
infused parent. `curve.ts` wires the infusion branch into all three build paths (duration from the
injected disposition). Oracles: `C_m(0)=0`; **`AUC_m = fm·D/(k_m·Vd_m)` — identical to the IV bolus,
independent of disposition AND of infusion duration** (`Σ g_λ/λ = 1/CL` cancels; verified for 1c/2c/3c
and for 1 h vs 24 h durations); an **independent RK4 integration** of `dA_m/dt = fm·CL·C_p(t) − k_m·A_m`
with C_p driven from the engine's own `infusionConcentrationFromModes` curve, integrated ACROSS the
during/after seam — the SIGN + seam check the scalar AUC can't see; continuity at t=T; collapse
duration→0 reproduces the IV-bolus metabolite (small-T limit, loose tol) and Q→0 collapses 3c→2c→1c;
superposition. **NOT inert (advisor-flagged):** unlike the oral widening, all IV routes are
`derivable: true` and diazepam HAS a metabolite, so **diazepam/iv_infusion now draws nordiazepam** — an
active metabolite that forms during the brief infusion and accumulates to a late peak (t≈60 h) long
after the parent (which peaks at end-of-infusion). This is physically correct and the AUC was already
validated route-independently, so it's an improvement, not a regression; the default landing view stays
iv_bolus so the first-open screen is unchanged. Verified end-to-end on the REAL diazepam pair (buildCurve
shape: C(0)=0, forms during + after the infusion, long tail; the honesty-ui SSR test renders the
nordiazepam provenance group on iv_infusion). Two UI tests that had ASSERTED infusion draws no
metabolite (the old deferral) were updated to the corrected behavior, plus a new "route-truthful drop"
test that proves the panel still hides the group when the build produced no metabolite curve.

Deferred follow-on still open: the oral 3-comp inversion's sibling edges. **DONE:** the **flip-flop oral
horizon** (`fix(ui)`, 355 tests) — `curveHorizon`/`curveHorizon2c`/`curveHorizon3c` size the oral tail on
`min(ka, terminal rate)` so a flip-flop (ka < ke) curve isn't clipped; reduces exactly to the old formula
when ka > ke (zero regression), mutation-checked (pre-fix tail cut at ~9% of Cmax > the 5% test threshold;
fixed ~0.6%), engine-capability-only (no shipped compound is flip-flop; synthetic caffeine-clone fixture);
IV-infusion-parent metabolites (above); oral 3-comp ka-from-Tmax (above); oral-parent metabolites (above); the ProvenancePanel metabolite-provenance rows; the metabolite `<Line>` rows; the 3-comp DATA+UI wiring; the
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
— at the spike this was **only for `route === 'iv_bolus'`** (the mono-exponential-parent gate; the
gate has SINCE widened to `iv_bolus || oral || iv_infusion` — see the oral-parent and IV-infusion-parent
metabolites notes above), formation driven by the plotted `mainKe` (slider reshapes the metabolite but
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
