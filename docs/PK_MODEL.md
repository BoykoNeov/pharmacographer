# The pharmacokinetic model

This documents the math the engine implements — all of it, not a version of it.
Everything is in the canonical internal units (mg, L, mg/L, h, 1/h, L/h, mg/h);
see [units](../src/engine/units.ts) and handoff §6. Conversion happens only at
the edges: a source's `L/kg` becomes absolute litres against the **70 kg
illustrative reference subject** during derivation, and canonical `mg/L` becomes
whatever the reader picked at display time.

The engine is pure: parameters and a dose schedule in, a concentration array out.
It knows nothing about drugs, files, or pixels, and it does not know what a
"patch" or a "genotype" is — those are data-layer concepts that collapse into
ordinary numbers before any function here runs.

## Map of the engine

| File              | What it computes                                                |
| ----------------- | --------------------------------------------------------------- |
| `units.ts`        | every unit conversion; the reference subject                    |
| `models.ts`       | one-compartment single-dose curves (the closed forms below)     |
| `models2c.ts`     | two-compartment: eigenvalues α, β and the mode coefficients     |
| `models3c.ts`     | three-compartment: eigenvalues α, β, γ by bracketed bisection   |
| `modes.ts`        | the **route drivers**, shared by every linear model             |
| `dosing.ts`       | superposition over a dose schedule (linear only)                |
| `metabolite.ts`   | parent → metabolite kinetics, including pre-systemic formation  |
| `modelsMM.ts`     | nonlinear: Michaelis–Menten elimination, integrated             |
| `modelsEnzyme.ts` | nonlinear: MM whose **capacity is itself a state** (turnover)   |
| `ode.ts`          | the scheduled RK4 walker both nonlinear models share            |
| `pk.ts`           | closed forms for the UI and the tests (Tmax, AUC, steady state) |

Two spines run through that table. Every **linear** model reduces its
disposition to a set of exponential modes, after which `modes.ts` computes each
route once, model-independently. Every **nonlinear** model has no closed form and
is integrated, after which `ode.ts` walks the schedule once, model-independently.
Adding a model means supplying modes (linear) or a right-hand side (nonlinear) —
not re-implementing the routes or the timeline.

## Rate constants

```
ke = ln(2) / t½                    (one compartment)
ke = CL / Vd                       (when a source reports both)
```

When a source gives both a half-life and CL + Vd, the derivation layer
cross-checks them and flags a discrepancy beyond tolerance rather than silently
picking one. For the multi-compartment models the micro-constants come from the
citable clinical parameters:

```
2-comp:  k10 = CL/Vc,  k12 = Q/Vc,   k21 = Q/Vp
3-comp:  k10 = CL/Vc,  k12 = Q2/Vc,  k21 = Q2/Vp2,  k13 = Q3/Vc,  k31 = Q3/Vp3
```

## Disposition as exponential modes

For any linear disposition the central concentration after a single IV bolus is a
sum of **modes**, `C(t) = Σ coef_λ · e^(−λ·t)`:

- **One compartment** — one mode: `coef = D/Vd`, `rate = ke`.
- **Two compartments** — the two roots of a quadratic,
  `α, β = ½·[ (k10+k12+k21) ± √((k10+k12+k21)² − 4·k10·k21) ]`, with
  `g_α = (α − k21)/(Vc·(α − β))` and `g_β = (k21 − β)/(Vc·(α − β))` per unit
  dose, so `g_α + g_β = 1/Vc` and `C(0) = D/Vc`.
- **Three compartments** — the three roots of a cubic
  `λ³ − a₂λ² + a₁λ − a₀ = 0`, all real and positive for physical parameters.
  These are found by **bracketed bisection**, deliberately not by Cardano or the
  trigonometric solution: those are fragile exactly in the PK regime `α ≫ β ≫ γ`
  (catastrophic cancellation, an arccos argument drifting out of range → `NaN`),
  and they fail where this file's oracles cannot see it. The derivative
  `p′(λ) = 3λ² − 2a₂λ + a₁` has two roots that strictly separate the three cubic
  roots, giving three guaranteed brackets and ordered output.

As a peripheral clearance `Q → 0` the corresponding eigenvalue → 0 with a
vanishing coefficient, so 3-comp collapses to 2-comp and 2-comp to 1-comp. Those
collapses are tested, and they are what tie each new model to the older
oracle-pinned ones.

## Routes, from the modes

Given the per-unit-dose modes `g_λ = coef_λ/D`, each route is one driver
(`modes.ts`), identical for one, two or three compartments:

```
IV bolus:     C(t) = Σ coef_λ·e^(−λ·t)
IV infusion:  C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·t))                during 0 ≤ t ≤ T
              C(t) = Σ R0·(g_λ/λ)·(1 − e^(−λ·T))·e^(−λ·(t−T))   after t > T
first-order:  C(t) = Σ batemanMode(ka·F·D·g_λ, ka, λ, t)
```

where `batemanMode(A, r, λ, t) = A/(λ − r)·(e^(−r·t) − e^(−λ·t))`. The
one-compartment specialisations are the familiar textbook forms:

```
IV bolus:   C(t) = (D/Vd)·e^(−ke·t)                       ⇒ C(0) = D/Vd, C(t½) = C(0)/2
oral:       C(t) = (F·D·ka)/(Vd·(ka − ke))·(e^(−ke·t) − e^(−ka·t))
infusion:   C(t) = (R0/(Vd·ke))·(1 − e^(−ke·t)),  then decaying from the end value
```

**Flip-flop / equal-rates edge case.** The Bateman prefactor is `0/0` when
`ka ≈ ke`. The analytic limit `C(t) = (F·D·ke/Vd)·t·e^(−ke·t)` is used instead,
switched on a RELATIVE test — `|ka − ke| ≤ FLIP_FLOP_REL_TOL · max(ka, ke)` with
`FLIP_FLOP_REL_TOL = 1e−6` — so the behaviour is the same whether the rates are
~0.01/h or ~10/h. `batemanMode` carries the same guard, so every model inherits
it.

**Flip-flop is not only a numerical edge case.** When `ka < ke` the terminal
slope is the ABSORPTION rate, not elimination: the half-life then sets the
curve's HEIGHT and leaves its slope alone. The UI branches its copy on which rate
limits (`HalfLifeAxisRegime`), because the ordinary sentence is false there.

### Clinical routes vs engine input types

The engine's `Route` union has exactly three members — `iv_bolus`, `oral`,
`iv_infusion` — and those names mean **input types**: instantaneous,
first-order, zero-order. The data layer's `DataRoute` is the wider clinical
vocabulary, mapped on by `engineRouteOf`:

| Clinical route               | Engine input  | Why                           |
| ---------------------------- | ------------- | ----------------------------- |
| `oral`, `im`, `sc`, `rectal` | `oral`        | first-order from a depot      |
| `transdermal`                | `iv_infusion` | a patch is a zero-order input |
| `iv_bolus`, `iv_infusion`    | themselves    | —                             |

Adding a clinical route therefore adds **no engine math**. What it does add is
meaning: `F` denotes absorption completeness with no first pass (`im`, `sc`),
net of a full first pass (`oral`), or net of a partial one (`rectal`); a patch's
schema has no `F` at all, because a stated delivery rate is already systemic. The
engine must not learn any of that, and any function taking a route must read the
block for THAT route.

## Multiple / recurring dosing

For linear PK, doses superpose:

```
C_total(t) = Σ_i  singleDoseConcentration(D_i, t − t_i)     for all i with t ≥ t_i
```

One mechanism covers single doses, ad-hoc extras and regular schedules. It is
**valid only for linear PK**, gated on the compound's `linear` flag, which now
means exactly this and nothing else. The nonlinear models replace it with whole-
schedule integration (below) — a different code path, not a branch in this one.

### Closed forms (used by the UI and the tests)

- **Oral time-to-peak:** `Tmax = ln(ka/ke)/(ka − ke)`; the limit `1/ke` at
  flip-flop. Inverting it for `ka` is how a compound reporting only a Tmax gets an
  absorption constant (`kaFromTmax`, and the 2-/3-comp versions that solve
  `Σ batemanModeDerivative = 0` in `ka`).
- **Exposure:** `AUC₀→∞ = F·D/CL = F·D/(Vd·ke)`, `F = 1` for IV.
- **Steady state, dose `D` every `τ`:** accumulation ratio
  `R = 1/(1 − e^(−ke·τ))`, IV-bolus `Cmax,ss = (D/Vd)·R`,
  `Cmin,ss = Cmax,ss·e^(−ke·τ)`, and `Cavg,ss = F·D/(CL·τ)`.
- **The `F·D/V` ceiling.** For a one-compartment model `F·D/V` is a hard upper
  bound on the peak: an IV bolus hits it, every other input lands below. A
  reported Cmax above that ceiling falsifies the one-compartment reading of the
  drug at that volume, whatever `ka` and `ke` are — which is why the data guide
  runs it before writing any JSON.

## Metabolites

A fraction `fm` of what the parent eliminates forms the metabolite, which clears
with its own one-compartment disposition:

```
dA_m/dt = fm·k10·A_central − k_m·A_m,     A_m(0) = 0
```

Because `k10·Vc = CL`, each parent mode contributes a Bateman term and the
metabolite is a superposition over the parent's modes:

```
C_m(t) = (1/Vd_m)·Σ_λ batemanMode(fm·CL·coef_λ, λ, k_m, t)
```

The subtlety is that the input AMPLITUDE carries the parent's clearance while the
exponent carries the mode rate `λ`; these coincide only in one compartment. The
same core serves an oral parent (rewriting its curve in residue form as a plain
mode sum over `{ka, λ…}`) and an infused one (a difference of running Bateman
areas). Formation- versus elimination-rate-limited behaviour is not special-cased
— the terminal slope is `−min(slowest parent rate, k_m)`, which falls out of the
algebra.

**Pre-systemic (first-pass) formation.** An oral dose also forms metabolite
before reaching the circulation. That fraction (`ffp`) never enters the systemic
parent, so it is not captured by the term above; it appears as an additional
absorption input straight into the metabolite compartment at the parent's `ka`.
It rides the oral route only. With `ffp` absent the term vanishes and the curve
is byte-identical to the systemic-formation-only case.

Useful exposure identities, all route-independent and all used as test anchors:
`AUC_m = fm·F·D/(k_m·Vd_m)` (oral), `fm·D/(k_m·Vd_m)` (IV, bolus or infusion),
and the molar ratio `AUC_m/AUC_p = fm_molar · CL_p/CL_m`.

## Nonlinear: Michaelis–Menten elimination

```
rate of elimination = Vmax·C/(Km + C)          (mg/h)
```

Capacity-limited elimination saturates, and two consequences drive everything:

1. **There is no single half-life.** The apparent half-life rises with
   concentration: `t½(c) = (Vd/Vmax)·(Km·ln2 + c/2)`. Far below `Km` the drug is
   first-order at `ke = Vmax/(Vd·Km)`; far above it the concentration falls in a
   straight LINE at `Vmax/Vd` mg/L/h.
2. **Superposition is invalid**, so there is no single-dose building block to sum.
   The whole schedule is integrated as one initial-value problem (fixed-step RK4
   between dose events, step sized on the system's fastest rate).

`C(t)` has no explicit solution, so the tests anchor on what is analytic:

```
IV-bolus implicit solution:   Km·ln(C0/C) + (C0 − C) = (Vmax/Vd)·t
IV-bolus AUC:                 (Vd/Vmax)·(Km·C0 + C0²/2)
infusion steady state:        Css = r0·Km/(Vmax − r0)
```

The AUC form is **route-dependent**, unlike every linear AUC here: slower input
keeps `C` lower and further from saturation, so the same dose yields less
exposure. `Css` has a vertical asymptote at `r0 = Vmax` — above the enzymes'
ceiling there is no steady state at all — which is phenytoin's clinical
signature.

## Nonlinear: enzyme turnover (capacity as a state)

Michaelis–Menten still treats `Vmax` as a constant of the compound: its only
state is drug. `modelsEnzyme.ts` adds the enzyme itself as a state, written as a
fraction of its own drug-free baseline (`e = E/E₀`, so `Vmax(t) = Vmax·e(t)`):

```
de/dt        = k_deg·(1 + IND(C)) − k_deg·e − k_inact·(C/(K_I + C))·e
dA_depot/dt  = −ka·A_depot
dA_central/dt = input(t) + ka·A_depot − Vmax·e·C/(Km + C)

IND(C) = indMax·C/(EC50 + C)          induction — more enzyme synthesised
k_inact·C/(K_I + C)                   mechanism-based inactivation — enzyme destroyed
```

Both drivers default to zero, and with both off `e ≡ 1` and every curve is
exactly the Michaelis–Menten one — the collapse that ties this path to the
oracle-pinned one. What the state buys:

- **A drug-free clock.** Once the drug is gone the enzyme equation is linear:
  `e(t) = 1 − (1 − e₀)·e^(−k_deg·t)`, containing no drug parameter at all. A drug
  with a one-hour half-life can leave a week-long footprint.
- **Sustained level.** `e_ss(c) = k_deg·(1 + IND(c)) / (k_deg + k_inact·c/(K_I + c))`
  — suppression is set by inactivation RELATIVE to turnover, so the same
  `k_inact` matters ten times less against an enzyme rebuilt ten times faster.
- **A moved ceiling.** Sustained input can be cleared only up to
  `Vmax·k_deg·(1 + indMax)/(k_deg + k_inact)`; the coupled steady state is solved
  algebraically (independently of the integrator, which is what makes it an
  oracle).
- **Accumulation across a trough of zero** — exposure climbing over repeated
  doses although the concentration returns to zero between them. No
  concentration-driven model can do this at any parameter values, which is
  precisely the screen the data guide uses to reject compounds like omeprazole.

**No compound ships against this model.** It is engine capability with a
pre-registered sourcing gate; see `docs/ROADMAP.md`.

## What is deliberately NOT modelled

Stated so the curves are read correctly, and so these are not re-proposed as
oversights:

- **Enterohepatic recirculation**, **absorption lag** (`tlag`), and **parallel
  absorption paths** (a fast and a slow route into the same compartment). The
  last of these is the one genuinely missing INPUT type, and it is what defers
  the nicotine and fentanyl patches and sumatriptan's oral route.
- **Time-varying clearance other than through the enzyme state above** — no
  circadian variation, no disease progression.
- **Protein-binding nonlinearity** (naproxen) and **auto-inhibition of a
  different shape** than saturable turnover (omeprazole's mechanism-based
  inactivation IS representable; the parameters are the blocker).
- **Any per-patient covariate model.** Weight, renal function, age and genotype
  do not enter the engine. The 70 kg subject is an illustrative assumption, and
  phenotype presets collapse into plain numbers in the data layer before
  derivation. This is the bright line, not a simplification to be lifted later.

## How this is tested

Correctness lives in oracles, not golden curves (handoff §10):

- **Closed forms** for everything analytic: `C(0)`, `C(t½)`, numeric AUC by
  trapezoid on a fine grid, peak time, steady-state `Cmax`/`Cmin`/`Cavg`, the
  flip-flop limit returning finite values.
- **Collapses** that tie each model to the one below it: `Q → 0` (3c → 2c → 1c),
  `Km ≫ C` (MM → linear), no enzyme term (turnover → MM).
- **Mass balance** — `∫ elimination dt = F·D` — which holds for every route and
  every model, including those with no analytic AUC.
- **Negative oracles**: superposition must FAIL under saturation; a curve
  described as peaking must actually peak.
- **Magnitude**, two ways. Four compounds have hand-written checks against
  reported observations, because what they assert is a shape rather than a number
  (phenytoin's steady-state cliff, ethanol's straight-line decline, clonidine's
  plateau and its approach, ketamine across a 12-fold dose range). Any compound
  may also carry `validation` observations, which `tests/data/magnitude.test.ts`
  builds and checks. Most compounds carry neither — absence means unchecked, not
  fine.
