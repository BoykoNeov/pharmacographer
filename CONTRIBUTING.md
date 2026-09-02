# Contributing to Pharmacographer

Compounds are one provenance-rich file each, so a data contribution is a small,
reviewable diff by construction. This file is the **process**: what a change has
to contain and how it is judged. The **curation authority is
[`docs/DATA_GUIDE.md`](./docs/DATA_GUIDE.md)** — every sourcing rule, every
pre-write screen, and the rejection log live there, and this file deliberately
does not restate them. Where the two disagree, the data guide wins.

## The bright line — read this first

Pharmacographer is **educational software, not a medical device**, and that is a
design constraint, not a disclaimer. A contribution that takes individual patient
data (real weight, renal or hepatic function, age, genotype) and returns a dose
or a clinical decision **is rejected on principle**, however it is framed and
however good the code is. Plotting an illustrative curve for a dose the reader
picked is education; telling that reader what to give is not.

Two consequences that catch real PRs:

- The persistent `DisclaimerBanner` stays wired in and non-dismissible.
- **Copy is part of the line.** The phenotype picker offers illustrative
  populations to look at — never "select your genotype".
  `tests/ui/phenotype-picker.test.tsx` asserts this, and it will fail you.

## What one contribution looks like

**Adding a linear compound is pure data.** Drop a JSON file into
`src/data/compounds/`; the loader's `import.meta.glob` picks it up and
`loader.test.ts` derives every route of it as an integration guard. No engine,
schema or derivation change is needed — if you find yourself editing the engine
to land a compound, something is wrong with the compound, not the engine.

Four things are **not** pure data and carry their own gates, each documented in
the data guide:

| Change                                      | Extra gates                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A **nonlinear** (Michaelis–Menten) compound | `dispositionMM` instead of `disposition`, `linear: false`, an explicitly cited `ka` for oral                     |
| A **phenotype preset**                      | both populations from one study; override only what the polymorphism touches; `presets[0]` must override nothing |
| A **new clinical route**                    | the input-type screen first; then every route-keyed surface in the UI                                            |
| **Engine** math                             | a closed-form oracle test, written with the math — not a golden snapshot                                         |
| A **validation observation**                | a real source key (never a sentinel), an available route, the reported number even where the model misses it     |

## Before you write anything

Work the numbered list in **"Adding a compound — checklist"** in the data guide.
Its first half is all pre-write:

1. **Search the data guide for your compound's name.** It may already be in the
   rejection log. Re-opening a deferral is an audit of _the recorded reason_ —
   twice now the recorded reason has been a true statement that was not actually
   the gate.
2. **Open the sources yourself.** FDA labels (openFDA, or DailyMed by
   `?setid=<uuid>` — `?name=` does not resolve) are preferred; EMA SmPCs second.
   Do not lift curated tables from commercial references; re-derive and re-key
   from the primary source.
3. **Run the screens on paper** — the table at the top of the data guide says
   which one answers which question. The `F·D/V` ceiling test applies to
   essentially every candidate and costs a minute.

Gating first is not bureaucracy: the cheapest good outcome for a bad candidate is
a rejection-log entry and no file at all.

## What your PR must contain

- **The change itself**, and for a compound the reasoning in its `notes` field —
  which value or range you chose, why, and any model-shape approximation you
  accepted. JSON has no comments; `notes` is where curator reasoning lives.
- **Every source under `sources`**, each resolving from its `sourceRef`. Derived
  values carry `derived: true` and a sentinel (`definition`, `derived_from_tmax`,
  `derived_from_clearance`, …). A value with no defensible source is **omitted,
  not guessed**.
- **The magnitude check — as a `validation` entry, not just a sentence.** Say what
  you compared and what you got (peak concentration against a reported Cmax, or
  `Css = R0/CL` for a zero-order input), and then encode the single-dose half of
  it in the compound's `validation` block so the suite re-runs it forever. See
  "Validation observations" in the data guide for the rules — the source must be
  real, the reported number goes in even when the model misses it, and the
  tolerance must be as tight as the truth allows. `npm test` proves magnitude for
  a compound that carries such entries and **not otherwise**: the judgement about
  which observation is worth anchoring to is still yours.
- **Confirmation you launched the app** (`npm run build && npm run preview`) if
  the change touches anything route-, phenotype- or copy-keyed. On-screen prose
  is invisible to the test suite.
- **A rejection-log entry instead**, if the compound did not survive its gates. A
  well-argued deferral is a real contribution, and several of the most useful
  passages in the data guide are exactly that.

## Checks to run

```bash
npm test        # vitest — structure, derivation, oracle math
npm run lint
npm run build   # tsc -b + vite build (the typecheck gate)
```

All three should pass before you open the PR. For formatting, check **only the
files you touched** — `npx prettier --check <your files>`. Repo-wide
`npm run format:check` currently reports pre-existing issues in `src` and
`tests`; leave them alone rather than shipping a PR that reformats files your
change never touched.

Note what none of these can see: a citation that does not exist, a wrong number
in `notes`, and any sentence rendered on screen. Those are the reviewer's job and
yours, not CI's. A curve of the wrong magnitude is only partly on that list now:
it is caught for the four compounds with bespoke magnitude tests and for any
compound carrying `validation` observations (13 of 48), so treat the rest as
unchecked rather than fine.

## How a change is judged

The reviewer's questions, in order:

1. Does it stay on the educational side of the bright line, in features **and**
   in copy?
2. Does every citation resolve, and did the contributor open it?
3. Did the applicable screens run _before_ the JSON, and is the outcome written
   down — including for the parameters that were rejected?
4. Does the plotted curve match a reported observation in magnitude?
5. Does the honesty layer still tell the truth — `derived` flags, "inferred, not
   measured" on an unavailable route, the provenance panel?
6. Does it manufacture anything nobody reported? Merged variability bands, a
   population combining two phenotypes, an invented split of a lumped parameter:
   all refused for the same reason.
7. If it adds a route, did it convert the route branch to an exhaustive
   `Record<DataRoute, …>` rather than appending to a ternary? Extending a chain
   fixes one route and re-arms the trap for the next.

Being asked for changes here is normal, and is usually about provenance rather
than code. "I could not source this defensibly" is always an acceptable answer.

## Scope, and what is deliberately absent

- There is **no public deploy**, and that is a decision rather than a gap. Do not
  add a deploy workflow; ask first.
- There is **no CI configuration** in this repo. Whether to add one is the
  maintainer's call — propose it in an issue rather than in a PR.
- There is no CLA and no separate contributor agreement. The project is
  Apache-2.0, whose §5 already settles the licensing of contributions: _"Unless
  You explicitly state otherwise, any Contribution intentionally submitted for
  inclusion in the Work by You to the Licensor shall be under the terms and
  conditions of this License, without any additional terms or conditions."_ See
  [`LICENSE`](./LICENSE) and [`DISCLAIMER.md`](./DISCLAIMER.md); the "AS IS,
  without warranty" clause is load-bearing and stays intact.

## Where to look

| Question                       | File                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| How do I curate this compound? | [`docs/DATA_GUIDE.md`](./docs/DATA_GUIDE.md)                 |
| What is the math?              | [`docs/PK_MODEL.md`](./docs/PK_MODEL.md)                     |
| Why is it built this way?      | [`docs/HISTORY.md`](./docs/HISTORY.md)                       |
| What are the code conventions? | [`CLAUDE.md`](./CLAUDE.md)                                   |
| What is open, and why?         | [`docs/ROADMAP.md`](./docs/ROADMAP.md)                       |
| What was the original plan?    | [`PHARMACOGRAPHER_HANDOFF.md`](./PHARMACOGRAPHER_HANDOFF.md) |
