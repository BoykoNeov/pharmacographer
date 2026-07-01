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
- **Lisinopril — deferred, not excluded.** Its kinetics are compatible with the
  linear model (the terminal ~40 h phase is saturable ACE binding that does _not_
  accumulate; the accumulation-governing **effective half-life is ~12 h**, which
  is what a superposition model should use). It is deferred only because a
  concentration curve needs a volume of distribution and **neither the FDA label
  nor the EMA SmPC states one** — they give absorption (~25%, 6–60% range),
  effective half-life (12 h), and Tmax (~7 h), but no Vd/(V/F). Per the sourcing
  rule "a value with no defensible source is omitted, not guessed," lisinopril
  waits for a citable V/F (e.g. from an apparent oral clearance via the
  `derived_from_clearance` route) rather than shipping a guessed volume.

### Vetted metabolite-pair candidates not shipped (metabolites spike)

The metabolites engine (`engine/metabolite.ts`) models an **IV-bolus parent** as a
mono-exponential input to a Bateman-shaped metabolite; that assumption **requires a
one-compartment parent**. Every well-characterised IV parent→metabolite pair vetted
so far breaks it, so none shipped — the spike engine is proven against closed-form
oracles and synthetic fixtures instead. Rationale preserved so it isn't re-litigated:

- **Diazepam → nordiazepam (N-desmethyldiazepam) — deferred, two-compartment.** The
  FDA Valium label + StatPearls describe a distribution phase (t½ ~1 h) then a
  prolonged terminal phase (t½ ~48 h) — a pronounced 2-compartment structure that
  violates the mono-exponential-parent assumption. Independently, neither source
  states the **fraction converted** to nordiazepam or the metabolite Vd (only its
  t½ ~100 h is clean), so `fm` is uncited — but the compartmental structure is the
  decisive disqualifier: no `fm` rescues a parent the engine can't represent.
- **Procainamide → NAPA — out, 2-compartment + genotype-dependent fm.** Parent is a
  2-compartment model; NAPA formation is acetylator-dependent (urinary recovery
  7–34%, bimodal fast/slow), so `fm` is not a single citable number.
- **Cefotaxime → desacetylcefotaxime — out, 2-compartment (least-bad).** Its
  secondary params ARE citable (`fm` ≈ 33%, parent t½ ~1.7 h, metabolite t½ ~2.6 h)
  and its distribution/terminal split is mild, so it is the closest to a defensible
  one-compartment approximation (comparable to ibuprofen's documented biphasic
  collapse) — but the parent is still genuinely 2-compartment, so it waits.

A real metabolite compound therefore waits for either a genuinely one-compartment IV
pair with a citable `fm`, or the multi-compartment §12 engine extension.

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
