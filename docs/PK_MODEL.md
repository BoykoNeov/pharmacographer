# The pharmacokinetic model (v1)

This documents the math the engine implements. All of v1 is a **one-compartment
model** with first-order elimination; absorption is bolus (IV), first-order
(oral), or zero-order (IV infusion). Everything is in the canonical internal
units (mg, L, mg/L, h, 1/h) — see [units](../src/engine/units.ts) and handoff §6.

> **Validity.** These closed forms assume **linear (first-order) PK**: clearance
> and volume are dose-independent, so concentration scales linearly with dose and
> doses superpose. This is false for nonlinear drugs (Michaelis–Menten / zero-
> order elimination — phenytoin, ethanol, high-dose salicylate), which are tagged
> `linear: false` and excluded from v1.

## Rate constants

The elimination rate constant relates to half-life by

```
ke = ln(2) / t½
```

If both clearance `CL` and volume `Vd` are known, `ke = CL / Vd`. When a source
gives both a half-life and CL+Vd, the engine cross-checks them and flags a
discrepancy beyond tolerance rather than silently picking one.

## Single-dose models

### IV bolus (dose `D`)

The whole dose enters instantly and distributes into `Vd`:

```
C(t) = (D / Vd) · e^(−ke·t)
```

so `C(0) = D/Vd` and `C(t½) = C(0)/2`.

### Oral / first-order absorption (dose `D`) — Bateman function

Absorption rate constant `ka`, bioavailable fraction `F`:

```
C(t) = (F · D · ka) / (Vd · (ka − ke)) · ( e^(−ke·t) − e^(−ka·t) )
```

**Flip-flop / equal-rates edge case.** When `ka ≈ ke` the prefactor is `0/0`. Use
the analytic limit instead:

```
C(t) = (F · D · ke / Vd) · t · e^(−ke·t)
```

The engine switches to this branch when `|ka − ke|` is small **relative** to the
rates — `|ka − ke| ≤ FLIP_FLOP_REL_TOL · max(ka, ke)` with `FLIP_FLOP_REL_TOL =
1e−6` — so the test behaves the same whether rates are ~0.01/h or ~10/h, and the
model never returns `NaN`/`Inf`.

### IV infusion (rate `R0` for duration `T`) — zero-order in, first-order out

```
during infusion (0 ≤ t ≤ T):  C(t) = (R0 / (Vd·ke)) · (1 − e^(−ke·t))
after it stops   (t > T):      C(t) = (R0 / (Vd·ke)) · (1 − e^(−ke·T)) · e^(−ke·(t−T))
```

## Multiple / recurring dosing — superposition

For a schedule of doses `D_i` at times `t_i` (same route), linear PK lets us sum
time-shifted single-dose curves, each contributing only after administration:

```
C_total(t) = Σ_i  singleDoseConcentration(D_i, t − t_i)    for all i with t ≥ t_i
```

One mechanism covers single doses, ad-hoc extra doses, and regular schedules.
**Only valid for linear PK** — gated on the compound's `linear` flag. The
implementation keeps `singleDoseConcentration(route, params, dose, τ)` (a scalar:
the concentration one dose contributes at elapsed time `τ`) as the building block
and defines `concentrationCurve` as superposition over it.

## Useful closed forms (for the UI and for tests)

- **Oral time-to-peak:** `Tmax = ln(ka/ke) / (ka − ke)`.
- **Total exposure (single dose, 0→∞):** `AUC = F·D / CL = F·D / (Vd·ke)`
  (`F = 1` for IV).
- **Steady state, dose `D` every `τ`:**
  - Accumulation ratio `R = 1 / (1 − e^(−ke·τ))`.
  - IV bolus `Cmax,ss = (D/Vd)·R`, `Cmin,ss = Cmax,ss · e^(−ke·τ)`.
  - Average steady-state concentration `Cavg,ss = F·D / (CL·τ)`.

## How this is tested

The engine is validated against these analytic answers, not golden curves
(handoff §10): `C(0)`, `C(t½)`, numeric AUC by trapezoid on a fine grid, peak
time, the flip-flop limit (finite, no `NaN`), single-element superposition equals
the single-dose curve, and simulated steady-state `Cmax`/`Cmin`/`Cavg`
converging to the closed forms above.

## Extension seams (deferred — handoff §12)

The schema's `model` discriminator and `linear` flag exist from day one so later
models slot in without touching the data/UI contract: metabolite kinetics,
nonlinear (Michaelis–Menten) elimination with numerical ODE integration,
multi-compartment distribution phases, and additional absorption routes.
