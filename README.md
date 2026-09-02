# Pharmacographer

An interactive, **educational** tool that plots the pharmacokinetic (PK)
concentration-vs-time curve of a drug from a curated database — letting you pick
route, dose, and dosing schedule — and that is honest at every step about
uncertainty, data provenance, and inter-individual variability.

> ## ⚠️ Educational use only — not medical advice
>
> Pharmacographer is **not a medical device**. Curves are illustrative outputs of
> a simplified model applied to an **illustrative reference subject**, not
> predictions for any real person. **Do not use it for clinical decisions, dosing,
> or treatment.** Data may be inaccurate or incomplete. The software is provided
> "AS IS" with no warranty; the authors accept no responsibility for any use.
> See [DISCLAIMER.md](./DISCLAIMER.md) and the [LICENSE](./LICENSE).

## Why this exists

There are many drug-curve plotters, and most are quietly misleading. The goal
here is a tool whose **epistemic honesty is the product**: every line on the
graph can answer three questions —

1. **Where did this number come from?** (provenance + source reference)
2. **Was it measured or computed?** (a measured-vs-derived flag)
3. **Under what conditions, and for whom, does it hold?** (conditions + a
   variability band, not a single false-precision point)

Guiding order of priorities: **honest before pretty before featureful.**

## Status

Working, and well past the original plan's v1. The app plots **48 curated
compounds** across seven clinical routes, with the honesty layer wired through
all of it.

The engine covers one-, two- and three-compartment linear disposition (sharing
one route spine), nonlinear Michaelis–Menten elimination, N metabolites per
parent including pre-systemic formation, illustrative phenotype presets, and
per-parameter variability bands. A nonlinear model whose metabolic **capacity is
itself a state** (enzyme turnover) is implemented and tested but not yet wired to
any compound — it is waiting on parameters nobody has published against plasma
concentrations.

There is deliberately **no public deploy**: run it locally.

- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — what is open and what each item is
  actually blocked on.
- [`PHARMACOGRAPHER_HANDOFF.md`](./PHARMACOGRAPHER_HANDOFF.md) — the original
  plan, kept as written.

## Tech stack

- **TypeScript** — the PK engine is pure TS, fully unit-testable.
- **React + Vite** — reactive UI for live dose/route/schedule/variability changes.
- **Recharts** — concentration chart with linear / semi-log toggle and shaded
  variability bands (half-life, volume of distribution, oral bioavailability —
  one per parameter, individually toggleable and never merged into one envelope).
- **Vitest** — engine correctness validated against closed-form analytic answers.
- **Zod** — runtime validation of compound data files.
- Static and backend-free — but not deployed; see Status.

## Architecture (hard boundaries)

```
ENGINE  — pure PK math: models, dosing/superposition, derivation, units.
          No I/O, no UI, no data imports. Fully unit-tested.
   ▲
DATA    — one JSON file per compound + schema/validation + loader.
          A derivation layer turns "what a source gave" into "what the engine needs".
   ▲
UI      — pickers, dose/route controls, schedule editor, chart, variability
          slider, provenance panel, persistent disclaimer banner.
```

The engine takes **parameters + a dose schedule in, a concentration-time array
out**, and knows nothing about drugs, files, or pixels. That separation is what
lets the project "start simple and go deep later." See
[`docs/PK_MODEL.md`](./docs/PK_MODEL.md) for the math and
[`docs/DATA_GUIDE.md`](./docs/DATA_GUIDE.md) for how compound data is sourced and
added.

## Getting started

```bash
npm install
npm run dev            # start the dev server
npm test               # run the engine test suite
npm run build          # typecheck + production build
npm run lint           # eslint
npm run format         # prettier --write
```

Requires Node 20+ (developed on Node 24).

## Repository layout

```
src/
  engine/   # PURE PK math — no UI, no data imports
  data/     # compound files + schema/validation + loader + derivation
  ui/       # React components + the persistent disclaimer banner
tests/
  engine/   # closed-form oracle tests for the math
  data/     # schema, loader, derivation — and the curve-vs-measurement check
  ui/       # the honesty layer, route copy, and curve assembly
docs/
  PK_MODEL.md   # the pharmacokinetic model, documented
  DATA_GUIDE.md # data sourcing rules + how to add a compound
  ROADMAP.md    # what is open, and what each item is blocked on
  HISTORY.md    # why things are built the way they are
```

## Contributing data

Compounds are one provenance-rich file each, designed for review — adding a
linear one is pure data, with no engine or schema change.

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) is the **process**: what a PR must
  contain, how it is judged, and the standing refusals.
- [`docs/DATA_GUIDE.md`](./docs/DATA_GUIDE.md) is the **curation authority**:
  which sources to prefer, the pre-write screens to run, how to record
  provenance and curator reasoning, and the rejection log of compounds already
  evaluated and deferred.

The checks that matter most are the ones CI mostly cannot run: whether a citation
is real, and whether any on-screen sentence is true. Curve MAGNITUDE is partly off
that list — a compound can carry `validation` observations, and the suite builds
its curve and checks it against what a source actually measured. Most compounds do
not carry them yet, so absence means unchecked rather than fine.

## License

[Apache-2.0](./LICENSE). The "AS IS, without warranty" clause is load-bearing —
see [DISCLAIMER.md](./DISCLAIMER.md).
