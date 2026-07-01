# Multi-compartment (2-compartment) engine extension — §12

## Context

The engine is one-compartment only. The metabolites spike (`engine/metabolite.ts`)
landed green but **no real metabolite compound shipped**: every vetted parent→metabolite
pair — diazepam→nordiazepam, procainamide→NAPA, cefotaxime→desacetyl- — has a genuinely
**two-compartment parent** with a visible distribution phase, which violates the spike's
mono-exponential-parent assumption (rejection log in `docs/DATA_GUIDE.md`). Independently,
`docs/DATA_GUIDE.md` notes that collapsing any multi-compartment drug to a single Vd
"distorts the early curve shape" — so a real 2-comp parent line (distribution → terminal)
is pedagogically valuable in its own right.

This pass adds a **linear 2-compartment model** to the pure engine, for **IV bolus + IV
infusion**, and generalizes the metabolite math to a 2-comp (bi-exponential) parent. It
is the designed §12 seam ("another value of `model`; add the distribution-phase equations
and extra disposition parameters — no change to the data/ui contract beyond new optional
fields"). **Scope: engine + tests only** (the metabolites-spike pattern — de-risk the math
green before curating data). **Deferred:** oral 2-comp (tri-exponential → 3-mode), a real
2-comp compound, and the React `<Line>`/provenance metabolite rows (still deferred from the
spike). Oral and the real compound are clean follow-ons once the modes machinery is green.

## The spine: a "sum of exponential modes" internal representation

The central-compartment concentration of a linear 2-comp bolus/infusion parent is a sum of
exponential **modes** `Σ_λ coefλ·(mode envelope)`, `λ ∈ {α, β}`. Representing disposition
this way unifies three things that otherwise need separate math:

- **Parent bolus curve** = `Σ_λ coefλ·e^(−λt)`
- **Parent infusion curve** = per-mode version of the existing 1-comp infusion formula
  (`Σ_λ (coefλ/λ)·(1−e^(−λt))` during infusion, decaying after)
- **Metabolite** = superposition over the parent's modes of a Bateman building block

1-comp is the 1-mode special case, so the existing (oracle-pinned) code stays a regression check.

### The load-bearing correction: k10 vs λ decouple (verified)

For a 2-comp parent the central amount decays at **α, β**, but the metabolite formation
flux is `fm·k10·A_central(t)` — governed by the micro-constant **k10 = CL/Vc**, *not* by α/β.
Per mode the metabolite amount solves to

```
batemanMode(amplitude, inputRate λ, elimRate k_m, τ)
  = amplitude / (k_m − λ) · (e^(−λτ) − e^(−k_m τ))     // flip-flop guard on |λ − k_m|
```

with **`amplitude = fm·CL·coefλ`** (CL in the amplitude; λ only in exponent + denominator).
`C_m(t) = (1/Vd_m)·Σ_λ batemanMode(fm·CL·coefλ, λ, k_m, τ)`.

Derivation confirmed against `dA_m/dt = fm·k10·A_c − k_m·A_m`, and the 1-comp collapse
(single mode, `coefλ = D/Vd`, `CL = ke·Vd`) reduces exactly to today's
`singleDoseMetaboliteConcentration` amplitude `fm·ke·D`. `AUC_m = fm·D/(k_m·Vd_m)` is
**unchanged** (the `Σ coefλ/λ = D/CL` identity cancels all parent disposition) — so the
current metabolite AUC oracle is a free regression anchor. This is why the refactor extracts
a **3-arg `batemanMode`** summed over modes, *not* "call the existing function per mode"
(which would wrongly put λ where CL belongs).

## Parameterization (decided — clinical form)

Store **CL, Vc, Q (inter-compartmental clearance), Vp** — the most citable literature form.
Derive:

```
k10 = CL/Vc,  k12 = Q/Vc,  k21 = Q/Vp
α, β = roots of  s² − (k10+k12+k21)s + k10·k21 = 0      // α = larger (distribution), β = smaller (terminal)
bolus coefs:  coef_α = (D/Vc)·(α−k21)/(α−β),  coef_β = (D/Vc)·(k21−β)/(α−β)   // C(0)=coef_α+coef_β = D/Vc
```

`k10 = CL/Vc` falls out directly — exactly what metabolite formation needs.

## File-by-file (engine-first, spike pattern)

- **`src/engine/types.ts`** — Add 2-comp resolved params (`vc, cl, q, vp` or the derived
  `{alpha, beta, coefAlpha, coefBeta, k10}` mode bundle). Make the resolved engine params a
  **discriminated union on a `model` tag** so `singleDoseConcentration`'s existing `never`
  exhaustiveness guard extends cleanly. Add a `MetaboliteParams`-adjacent mode type
  (`{ amplitude, inputRate }[]`) or reuse a small `ExpMode` shape.
- **`src/engine/models2c.ts`** (new) — 2-comp bolus + infusion, mode-based; the micro→macro
  eigenvalue solve; coefficient construction. **Leave `models.ts` untouched** (green,
  oracle-pinned). Reuse `FLIP_FLOP_REL_TOL` from `models.ts` for the `α ≈ β` degeneracy
  (critically-damped 2-comp) and mirror its analytic-limit style.
- **`src/engine/metabolite.ts`** — Extract `batemanMode(amplitude, inputRate, elimRate, τ)`
  (with the flip-flop guard). Add a multi-mode entry point
  (`singleDoseMetaboliteConcentration` over a parent's mode list, or a new
  `metaboliteFromModes`). Keep the current `singleDoseMetaboliteConcentration` as the 1-mode
  specialization / regression check.
- **`src/engine/pk.ts`** — 2-comp closed forms for annotations + oracles: `AUC = D/CL`,
  terminal slope `−β`, `C(0) = D/Vc`. Route-independent AUC still holds.
- **`src/data/schema.ts`** — Add `'two_compartment_first_order'` to `ModelSchema`. Add an
  optional `disposition2c` block (CL/Vc/Q/Vp, each **full provenance** via the existing
  `requiredParam`/`optionalParam` factories + unit enums; add `Vc`/`Vp` volume + `Q`
  clearance units if not already covered). Extend the `superRefine` sourceRef cross-check to
  the new fields. An omitted block keeps all 8 current compounds valid.
- **`src/data/derive.ts`** — **Split the linearity gate**: `linear: false` → reject
  (unchanged); `linear: true && model === 'two_compartment_first_order'` → route to a new
  `deriveParams2c` (eigenvalue solve + mode coefficients + derived-notes/warnings), instead
  of the current blanket "not one_compartment → throw". Generalize `deriveMetaboliteParams`
  to accept the parent's **modes + CL** (not a single `parentKe`) for a 2-comp parent; keep
  the 1-comp `parentKe` overload green.
- **`src/ui/curve.ts`** — Dispatch on model; **grid densification near t=0** so the fast α
  distribution phase isn't aliased (the horizon is sized on the slowest rate β, which for a
  diazepam-like terminal can be ~240 h → a uniform 300-pt grid gives α only 3–4 points).
  Add early/log-spaced sample marks analogous to the existing `criticalTimes` mechanism.
  Wire metabolite **modes** (not a scalar `keParent`) through `buildCurve`.

## Oracle test suite (closed-form, per CLAUDE.md — never snapshots)

New `tests/engine/models2c.test.ts` + additions to `tests/engine/metabolite.test.ts`,
`tests/engine/pk.test.ts`:

- `C(0) = D/Vc` (central volume — **not** D/Vd_total)
- `AUC₀→∞ = D/CL` (numeric trapezoid on a fine grid; also a teaching point — AUC is
  distribution-independent)
- terminal log-slope → `−β` (smaller eigenvalue); coefficient sum `coef_α + coef_β = D/Vc`
- **collapse-to-1c**: set `k12 → 0` (Q → 0) and the 2-comp path must reproduce *both* the
  existing 1-comp bolus/infusion curve **and** the existing 1-comp metabolite Bateman —
  ties the new path to the old
- infusion continuity at `t = T` (two branches agree), plateau `→ R0/CL`
- metabolite: `C_m(0) = 0`; `AUC_m = fm·D/(k_m·Vd_m)` (unchanged oracle); terminal slope
  `−min(β, k_m)`; `α ≈ β` and `λ ≈ k_m` flip-flop limits finite; superposition of one dose
  = single-dose curve
- schema/derive: a `two_compartment_first_order` fixture derives without throwing; a
  `linear: false` compound still rejects; all 8 existing compounds still parse + derive
  (`tests/data/loader.test.ts` integration guard stays green)

## Verification

- `npm test` — full oracle suite green (new 2-comp oracles + all existing 192 tests,
  especially the 1-comp collapse regressions and the unchanged metabolite AUC oracle).
- `npm run build` — tsc typecheck gate passes (the discriminated-union `model` tag must
  keep `singleDoseConcentration`'s `never` guard exhaustive).
- `npm run lint` — engine purity rules intact (no data/JSON/DOM imports under `src/engine/**`).
- No UI/visual verification this pass (no compound shipped, no `<Line>` added) — that lands
  with the deferred real-compound follow-on.

## Explicitly out of scope (follow-ons)

- Oral 2-comp (first-order absorption → tri-exponential parent → 3-mode metabolite).
- A real curated 2-comp compound (diazepam→nordiazepam is the lead candidate once green).
- React `<Line>` + `provenance.ts`/`ProvenancePanel` metabolite rows (deferred from the spike).
- 3-compartment models.
