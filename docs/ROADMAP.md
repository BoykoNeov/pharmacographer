# Roadmap — where this project actually is, and what is open

`PHARMACOGRAPHER_HANDOFF.md` is the **original plan**, written when nothing was
built. It is still the best statement of why the project exists and how the
layers are meant to fit, and its §12 list of extension points has been worked
through almost entirely. It is not a description of the present. This file is:
what is done, what is open, and what each open thing is actually blocked on.

| I want to know…                        | Read                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| what the code conventions are          | [`CLAUDE.md`](../CLAUDE.md)                                   |
| what the math is                       | [`docs/PK_MODEL.md`](./PK_MODEL.md)                           |
| how to curate a compound               | [`docs/DATA_GUIDE.md`](./DATA_GUIDE.md)                       |
| how to submit a change                 | [`CONTRIBUTING.md`](../CONTRIBUTING.md)                       |
| why something was built the way it was | [`docs/HISTORY.md`](./HISTORY.md)                             |
| what the original plan was             | [`PHARMACOGRAPHER_HANDOFF.md`](../PHARMACOGRAPHER_HANDOFF.md) |

## State of play

**48 compounds** (the file count in `src/data/compounds/` is authoritative, not
this number), plotted through an engine that covers:

- one-, two- and three-compartment linear disposition, sharing one mode-based
  route spine;
- nonlinear Michaelis–Menten elimination, integrated as a whole schedule;
- nonlinear **enzyme turnover** — capacity as a state — which no compound uses
  yet (below);
- N metabolites per parent, including pre-systemic (first-pass) formation;
- seven clinical routes (oral, IM, SC, rectal, IV bolus, IV infusion,
  transdermal) over three engine input types;
- illustrative phenotype presets, and per-parameter variability bands on
  half-life, Vd and oral F.

The honesty layer — provenance, measured-vs-derived, "inferred, not measured",
the non-dismissible disclaimer — is wired through all of it, and the bright line
(educational, never clinical) is a design constraint rather than a disclaimer.

**There is no public deploy and no CI configuration, and neither is a gap.** The
Pages workflow was built and removed at the maintainer's request (`4721f0c`);
adding either back is a decision to ask about first, not a PR to open.

## How work gets picked

Two rules, both learned the hard way and both recorded in `docs/HISTORY.md`:

1. **Gate before you build.** A throwaway arithmetic check has twice turned a
   day of planned engine work into a ten-minute "no". Every open item below
   therefore carries a **pre-registered gate**: the specific thing that would
   change the answer. If the gate is "a source reports X", searching may clear
   it. If the gate is "the engine cannot represent this", searching never will.
2. **A negative result is a result.** A well-argued deferral in the data guide's
   rejection log is a real contribution, and several of the most useful passages
   there are exactly that. Re-opening one is an audit of _the recorded reason_,
   which has been wrong several times — most recently this file's own A2 gate.

---

## A. Engine

### A1. Wire the enzyme-turnover model to a compound — BLOCKED ON SOURCING

`src/engine/modelsEnzyme.ts` exists, is oracle-tested, and is **not reachable
from the app**: no schema block, no derivation resolver, no compound. That was
deliberate — the model was built because the gate for it was pre-registered as
an engine capability ("a `Vmax` that is itself a differential equation"), and
building it moves the gate rather than opening it.

**The gate is now a sourcing one, and it is genuinely hard.** A compound needs:

- an enzyme turnover half-life (`k_deg = ln2/t½,enzyme`);
- a `k_inact`/`K_I` pair (or `indMax`/`EC50` for induction) expressed against the
  **plasma concentration this engine plots**.

Published inactivation constants are almost always in vitro, in µM at the
enzyme. Converting those to whole-body parameters is a physiologically-based
scaling exercise with assumptions of its own — hepatocellularity, enzyme
abundance, unbound fractions — and a curve built on it would be a fit to a model
we did not run, which is the manufactured-number failure the data guide refuses
everywhere else. **Do not scale in vitro constants to clear this gate.**

Candidates, in order: **omeprazole** (the compound whose re-gate motivated the
model — its label reports the accumulation, and the mechanism is documented), any
other mechanism-based inactivator (clarithromycin, ritonavir, paroxetine), and —
in the other direction — **phenytoin's autoinduction**, whose own cited source
(Frame & Beal 1998) fitted a Michaelis–Menten model with delayed induction. The
phenytoin file records the baseline (pre-induction) `Vmax` of 580 mg/day and an
average onset of 59.5 h, and notes that the engine "overstates chronic Css"
because it has no induction term. That is now half-true: the engine has one. What
is missing is the induced `Vmax` (or the fold-increase), which is **not in the
repo** and must come from opening the paper. Note also that Frame & Beal fitted
DELAYED induction — a lag then a step — which is not the continuous turnover form
implemented here; whoever picks this up must decide whether the shapes are close
enough to claim the citation, and say so in `notes`.

**If the gate clears, the wiring is:** a `dispositionEnzyme` schema block
(forbidding `disposition`, as `dispositionMM` does); a `deriveParamsEnzyme`
resolver; a `CurveResult` variant; the model added to `NONLINEAR_MODELS`; and —
the part that is easy to forget — every exhaustive `Record` and every piece of
on-screen copy that says "the apparent half-life rises with concentration",
which is no longer the whole story when it also depends on last week's doses. The
enzyme trajectory is returned alongside the concentration precisely so it can be
shown; a curve that moves for an invisible reason is the opposite of this
project's point.

### A2. Parallel absorption inputs — NOT BUILT, and the highest-value engine gap

The one genuinely missing INPUT type: two first-order paths into the same
compartment, or a fast first-order path plus a slow zero-order one. Everything
else the routes need, the engine has.

What it would unblock, and what it would not:

- **Sumatriptan oral** — drafted and cut because no single `ka` fits both the
  reported Tmax and Cmax (3.3× low; a sweep proved one root, so absorption is
  genuinely biphasic, exactly as Cosson 1999 fits it: first-order then
  zero-order). This is the clean case: the source itself fitted two paths.
- **Nicotine transdermal** — Gisleskog 2021 fits two parallel release pathways
  with separate lags into a transit chain, plus a clearance that rises 11.6% from
  24 h. Two paths is necessary but not sufficient here; the transit chain and the
  time-varying clearance are separate blockers.
- **NOT fentanyl transdermal.** Its mean Tmax of 33.5–38.1 h under a 72 h wear
  falsifies any monotone input, including a two-path one, before parameters are
  fitted. Do not re-propose it as a beneficiary of this feature; the pre-answered
  rescue is written out in the data guide.

Gate: a compound whose SOURCE fitted parallel inputs and reports both paths'
parameters. **No compound clears it today** — re-gated 2026-10-18, and the line
that stood here ("Sumatriptan oral is that compound today") was a recorded
reason that was not a gate. It rested on Cosson 1999's _abstract_, which names
the input shape and reports **no absorption parameter at all**. The full text is
subscription-only (Springer; Europe PMC lists no open copy), so the split between
the two paths has never been read by anyone working on this repo. The open
paper checked, Lee 2015, does not substitute — see the data guide's sumatriptan
entry for why. **What clears it:** Cosson's full text, read for each path's
fraction, `ka`, lags, the zero-order duration, and the disposition fitted
alongside them. Do not choose the missing fraction by fitting the label's oral
Cmax/Tmax: that is a curve tuned to an observation and then presented as a
model, the manufactured-number failure in its plainest form.

Note the model's shape when it arrives: "first-order **followed by**
zero-order" is usually implemented in NONMEM as two inputs running in PARALLEL
with different lags (a fraction into a depot, the rest straight into the central
compartment at a constant rate) — if Cosson's is, building it needs A3's lag
too, not A2 alone. Read the paper's own code or equations before assuming.

### A3. Absorption lag (`tlag`) — NOT BUILT, small

A time shift on an extravascular input. Cheap (it is a translation of the input
function, and the mode drivers already take an elapsed time), and several sources
fit it explicitly — Schepers 2003 fits methamphetamine's oral data as
"one-compartment with lag", and the nicotine patch models carry two different
lags. Worth doing when a compound needs it to reproduce a measured Tmax, and not
before: an unused parameter in the schema invites curators to fit noise with it.

### A4. `F` on an instantaneous input — NOT BUILT, blocked elsewhere

`F` is applied only on the engine's first-order path; every IV route is `F = 1`
by definition. A deep-lung inhaled product (Staccato loxapine) is an
instantaneous input with `F < 1`, so it would need `F` applied to the bolus mass
in `derive.ts` plus four exhaustive `Record`s widened. The engine change is
small; the compound is blocked on a **distribution half-life** the label never
reports, which no amount of engine work supplies. Pre-registered in the data
guide, per product.

### A5. Deliberately NOT planned

Recorded so they are not proposed as oversights:

- **Two-compartment Michaelis–Menten**, and **metabolites off a nonlinear
  parent**. No candidate needs either today, and both multiply the nonlinear
  surface for no teaching gain that the one-compartment versions do not already
  deliver.
- **Multiple enzyme pools** in the turnover model (a drug cleared by two
  pathways of which one is inactivated). The lumped single pool is the same
  posture as MM's lumped `Vmax`/`Km`, and no source in the repo reports the
  split.
- **Anything per-patient.** Covariate models, dose calculators, "your weight".
  The bright line. Not a roadmap item at any priority.

---

## B. Data and curation

### B1. Back-fill `validation` observations — the biggest cheap win

`tests/data/magnitude.test.ts` checks a built curve against a measured
concentration for the **17 compounds** that carry a `validation` block. Four others
(phenytoin, ethanol, clonidine, ketamine) are covered by bespoke tests that
predate it and assert things a declarative entry cannot — a straight-line decline,
a superlinear steady state, a plateau reached on the label's timescale. The
remaining ~27 are unchecked by machine, and most already state their magnitude
check as a sentence in `notes`: a sentence that decays silently on every parameter
edit. Two such sentences have turned out to be the model's own output presented
as a measurement (sumatriptan, then famotidine).

The recipe, per compound, is in `docs/DATA_GUIDE.md` ("Validation observations").
To find the next candidate, **read the full label text, not the source's title**.
The 2026-10-18 pass downloaded each DailyMed label (the SPL by its `setid`:
`https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/<setid>.xml`) and
searched it for `Cmax` / `ng/mL` / `mcg/mL`. That turned up four anchors (amoxicillin,
famotidine, fluconazole, lorazepam) whose numbers no title mentioned. The same
search came up empty, or found only multi-dose or special-population values, for
atenolol (its setid no longer resolves), cetirizine (steady-state only, so B2),
glipizide, lamotrigine, levetiracetam, metformin (extended-release only) and
metoprolol. Ibuprofen, IV acetaminophen and warfarin have values that were
deliberately not encoded; the data guide says why. Anchors still
waiting on a schema extension include allopurinol's metabolite peak (the check is
of a metabolite line, not the parent), acyclovir's and ethosuximide's
steady-state values (B2 below), and ketamine's dose-range check (already covered
by a bespoke test).

**The three attribution gaps recorded here were resolved 2026-10-18**, and the
record was wrong about one of them. Lorazepam's "~20 ng/mL after 2 mg" was in its
own FDA label all along, and is now encoded. Famotidine's "~67 ng/mL" matched no
source because it was the model's own output. The label's real 20 mg value, 73
ng/mL, is now encoded, and the model reads ~8% low against it rather than the
0.4% the old sentence implied. Glipizide's range really is unsourced, and its
`notes` now say so. Details are in the data guide, "Validation observations".

### B2. Harness v2 — steady-state and multi-dose observations

The current schema is single-dose only, deliberately: a steady-state entry needs
a schedule field, and a half-built one would silently ignore conditions a curator
wrote down. Adding it unlocks the checks several compounds already document in
prose: acyclovir's 5 mg/kg q8h steady-state peak, ethosuximide's accumulation, and
the two clonidine plateau values its bespoke test does not cover (the label reports
three; the test checks one).

It would also let the two nonlinear compounds and clonidine express the numeric
part of their bespoke tests as data. **Do not delete those tests when it does** —
what they assert beyond a number (a decline that is straight to 2%, a Css ratio
that is 2.7× for a 2× dose rate, 90% of plateau by two days) is the teaching point,
and no declarative entry says it.

Design note for whoever builds it: keep `kind` a closed union and let each kind
declare the fields it needs, rather than adding optional fields to one shape. The
checker must never silently ignore a field an entry supplied.

### B3. Compounds

The rejection log in `docs/DATA_GUIDE.md` is the authority, and it is long. The
live pointers:

- **Salicylate** is the plausible next Michaelis–Menten ship, if a source gives
  `Vmax` and `Km` from one design.
- **Ciprofloxacin** and **sildenafil** wait on a citable single-population
  two-compartment parameterisation.
- **Loxapine (inhaled)** waits on one number — a distribution half-life.
- **Omeprazole** waits on A1's sourcing gate, not on a search of the PK
  literature.

Anything else: search the guide for the compound's name first. Re-opening a
deferral audits the recorded reason.

---

## C. Structure and tooling

### C1. Split the curve builders and the resolvers — DONE

`src/ui/curve.ts` was 1,800 lines holding four curve builders plus route options,
variability ranges, formatting and display units. It is now `src/ui/curve/`, one
module per concern, behind the unchanged `curve.ts` path, which re-exports the
same public names and owns only the model dispatch — now an exhaustive
`Record<CompoundModel, builder>`, so a fifth model fails to compile instead of
falling through to the one-compartment body.

The split was the cheap half; the point was the duplication behind it — the same
class of defect `src/ui/peak.ts` fixed one level up, correctness re-achieved N
times in step. The three linear builders now share one horizon, one
multi-exponential critical-time pass, one input-window injection and one
metabolite path (whose formation model is chosen by an exhaustive `Record` on the
engine route, replacing three copies of the chain that once mis-routed a patch's
metabolite). Proven behaviour-preserving by building all 577 compound × route ×
schedule × slider cases with the old and new code and comparing the JSON byte for
byte, not only by the suite.

`src/data/derive.ts` (1,200 lines, five resolvers) got the same recipe one layer
down: it is now `src/data/derive/`, behind the unchanged path. The four parent
resolvers share one inferred-route warning, one `F` resolution and one
`ka`-from-data step (`absorption.ts`), and the two- and three-compartment Tmax
inversions are one solve over the disposition's modes. Three things that LOOK
duplicated were left apart on purpose, and should stay apart:

- the one-compartment `kaFromTmax` — a closed-form Tmax with its own bisection
  and stopping rule, so folding it into the mode solve would move `ka` in the
  last bits;
- the flip-flop tests — `Tmax > 1/ke` for one compartment, `ka` below the
  terminal rate (β, γ) for two and three. Each model passes its own, because
  they test different things and say so differently;
- the per-kg clearance inside `resolveKe`, which records no note, unlike
  `resolveClearanceParam`. Merging them would add a provenance row to every
  one-compartment compound with a per-kg clearance: a behaviour change, so if it
  is wanted it is its own commit.

Proven the same way: every resolver against every compound × route × phenotype
(wrong-model resolvers included, so the error text is pinned), every metabolite,
a Tmax sweep through all three inverters and 892 built curves serialise to
identical JSON before and after — and a deliberately broken warning string and a
loosened solver tolerance were each confirmed to make that comparison fail.

### C2. What stays absent

- **No deploy.** Removed deliberately; ask before re-adding.
- **No CI configuration.** The maintainer's call — propose it in an issue rather
  than in a PR. (What CI would run is settled: `npm test`, `npm run lint`,
  `npm run build`, and `npx prettier --check` on changed files only, since the
  repo has pre-existing formatting drift that a repo-wide check would flag.)
- **No CLA, DCO or code of conduct.** Apache-2.0 §5 settles inbound licensing.

---

## The standing traps, which no roadmap item removes

Repeated here because they are what actually breaks:

1. **`npm test` still does not prove magnitude for a compound with no
   `validation` block.** The harness narrows this trap; it does not close it.
2. **Tests are blind to on-screen prose.** Launch the app for anything route-,
   phenotype- or copy-keyed. Route copy has described the wrong organ three
   times, each with a green suite.
3. **Nothing in CI can see whether a citation is real.** The discriminator is
   whether the source opens. Never ship one you did not read.
