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

Early development — **Phase 0 (scaffold & guardrails)** is in place: build
tooling, the pure units/types layer of the PK engine, tests, and the persistent
disclaimer. The PK math, data layer, and UI land in later phases. See the build
plan in [`PHARMACOGRAPHER_HANDOFF.md`](./PHARMACOGRAPHER_HANDOFF.md) §13.

## Tech stack

- **TypeScript** — the PK engine is pure TS, fully unit-testable.
- **React + Vite** — reactive UI for live dose/route/schedule/variability changes.
- **Recharts** — concentration chart with linear / semi-log toggle and shaded
  variability bands (half-life, volume of distribution, oral bioavailability —
  one per parameter, individually toggleable and never merged into one envelope).
- **Vitest** — engine correctness validated against closed-form analytic answers.
- **Zod** — runtime validation of compound data files.
- Static, no-backend deploy.

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
  data/     # compound files + schema/validation + loader   (later phase)
  ui/       # React components + the persistent disclaimer banner
tests/
  engine/   # closed-form oracle tests for the math
docs/
  PK_MODEL.md   # the pharmacokinetic model, documented
  DATA_GUIDE.md # data sourcing rules + how to add a compound
```

## Contributing data

Compounds are one provenance-rich file each, designed for review.
[`docs/DATA_GUIDE.md`](./docs/DATA_GUIDE.md) is the contributor spec: which
sources to prefer, how to record provenance and curator reasoning, and which
drugs are deliberately excluded from v1 (nonlinear PK).

## License

[Apache-2.0](./LICENSE). The "AS IS, without warranty" clause is load-bearing —
see [DISCLAIMER.md](./DISCLAIMER.md).
