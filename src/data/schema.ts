/**
 * Compound file schema + runtime validation (handoff §8, docs/DATA_GUIDE.md).
 *
 * Each compound is one strict-JSON file whose every numeric parameter carries
 * provenance: `value` (+ optional `range`) + `unit` + `derived` (measured vs
 * computed) + `sourceRef` + `conditions`. This is the metadata the "inferred,
 * not measured" and "measured vs derived" UI warnings are built from, so the
 * schema enforces it rather than trusting the curator.
 *
 * This is the DATA layer: it may depend on the engine (units, types) but the
 * engine must never depend on it. Validation uses Zod; `z.strictObject`
 * everywhere rejects unknown keys so a typo in a compound file fails loudly
 * instead of silently dropping data.
 */

import { z } from 'zod';

/**
 * Recognised `sourceRef` sentinels that do NOT resolve to an entry in a
 * compound's `sources` map (handoff §8):
 *   - `definition`             — true by definition, e.g. IV bioavailability F = 1.
 *   - `derived_from_tmax`      — an absorption constant (ka) estimated from a reported Tmax.
 *   - `derived_from_clearance` — an (apparent) Vd computed from CL/F and the
 *                                half-life when the source reports no volume.
 *   - `derived_from_half_lives` — a two-compartment micro-constant (Q, Vp) computed
 *                                from a source's reported DISTRIBUTION and TERMINAL
 *                                half-lives plus its Vc and CL, via the standard
 *                                α/β algebra. See below.
 * Any other `sourceRef` must be a key in `sources`; the cross-check lives in the
 * compound-level {@link CompoundSchema} refinement.
 *
 * `derived_from_half_lives` exists because sumatriptan is the first 2-comp compound
 * whose peripheral parameters are COMPUTED rather than cited. Every earlier one took
 * Q and Vp straight from a popPK fit (ketamine ← Abuhelwa). The Imitrex SPL instead
 * reports four quantities from one 9-subject study — Vc, CL, a 15 min distribution
 * half-life and a 115 min terminal one — which is exactly enough to pin the model:
 * k10 = CL/Vc, k21 = αβ/k10, k12 = (α+β) − k10 − k21, then Q = k12·Vc and Vp = Q/k21.
 * The inputs are cited; the outputs are algebra on them. Marking that with the same
 * `derived: true` a Tmax-inverted `ka` carries keeps the honesty panel truthful about
 * which numbers a human measured — the distinction this whole field exists to draw.
 */
export const SOURCE_REF_SENTINELS = [
  'definition',
  'derived_from_tmax',
  'derived_from_clearance',
  'derived_from_half_lives',
] as const;

// ── Unit vocabularies ──────────────────────────────────────────────────────
// Per-parameter unit enums. These are the units the data layer accepts and the
// derivation layer (`derive.ts`) knows how to convert to canonical engine units.
// The per-kg variants (`L/kg`, `L/h/kg`) are DATA-layer concepts scaled to an
// absolute value against the reference subject during derivation; the engine
// itself only ever sees absolute units.

/** Time units (half-life, Tmax). Subset the engine `time` converter accepts. */
const TimeUnit = z.enum(['h', 'hr', 'hour', 'min', 'minute', 'day', 'd']);
/** Volume of distribution: per-kg (the common literature form) or absolute. */
const VolumeOfDistributionUnit = z.enum(['L/kg', 'L']);
/** Clearance: per-kg or absolute. */
const ClearanceUnit = z.enum(['L/h/kg', 'L/h', 'L/min', 'mL/min', 'mL/h', 'L/day']);
/** First-order rate constants (ka). */
const RateConstantUnit = z.enum(['1/h', '1/min', '1/day', '1/d']);
/** Bioavailable fraction F. */
const FractionUnit = z.enum(['fraction', 'percent']);
/** Concentration (the Michaelis constant Km). Subset the engine converter accepts. */
const ConcentrationUnit = z.enum(['mg/L', 'g/L', 'µg/mL', 'mcg/mL', 'ng/mL', 'mg/mL']);
/**
 * Maximum elimination rate (Vmax), in EITHER of the two forms the literature uses:
 * a mass rate (phenytoin: mg/kg/day) or the zero-order concentration slope
 * `Vmax/Vd` (ethanol: mg/dL/h). `derive.ts` multiplies the latter by Vd; the
 * per-kg mass forms scale against the reference subject, like `L/kg`.
 */
const MaxRateUnit = z.enum([
  'mg/h',
  'g/h',
  'mg/min',
  'mg/day',
  'g/day',
  'mg/h/kg',
  'mg/day/kg',
  'mg/L/h',
  'g/L/h',
  'mg/dL/h',
  'g/dL/h',
]);

// ── Parameter factory ──────────────────────────────────────────────────────

/** The provenance fields every parameter carries besides its `value`. */
function provenanceShape<U extends z.ZodTypeAny>(unit: U) {
  return {
    /** Optional reported [low, high] range; the source of the variability band. */
    range: z.tuple([z.number(), z.number()]).optional(),
    /** Unit of `value` (and `range`). */
    unit,
    /** True if the value was computed, not read from a source. */
    derived: z.boolean(),
    /** Key into `sources`, or a {@link SOURCE_REF_SENTINELS} sentinel, or null. */
    sourceRef: z.string().nullable(),
    /** Conditions the value holds under (dose, fed/fasted, population, …). */
    conditions: z.string().optional(),
  };
}

/** Cross-field sanity: range ordered, and the point value inside the range. */
function refineRange<T extends { value: number | null; range?: [number, number] | undefined }>(
  schema: z.ZodType<T>,
): z.ZodType<T> {
  return schema
    .refine((p) => p.range === undefined || p.range[0] <= p.range[1], {
      message: 'range must be [low, high] with low <= high',
      path: ['range'],
    })
    .refine(
      (p) =>
        p.range === undefined ||
        p.value === null ||
        (p.range[0] <= p.value && p.value <= p.range[1]),
      { message: 'value must lie within range', path: ['value'] },
    );
}

/** A required numeric parameter (`value` may not be null). */
function requiredParam<U extends z.ZodTypeAny>(unit: U) {
  return refineRange(z.strictObject({ value: z.number(), ...provenanceShape(unit) }));
}

/** An optional numeric parameter (`value` may be null, e.g. clearance unknown). */
function optionalParam<U extends z.ZodTypeAny>(unit: U) {
  return refineRange(z.strictObject({ value: z.number().nullable(), ...provenanceShape(unit) }));
}

// ── Sub-schemas ────────────────────────────────────────────────────────────

/** A literature source the compound's values are keyed to. */
const SourceSchema = z.strictObject({
  /** e.g. "FDA label", "EMA SmPC", "journal article". */
  type: z.string().min(1),
  title: z.string().min(1),
  url: z.string().optional(),
  /** ISO date the source was accessed, e.g. "2026-06-15". */
  accessed: z.string().optional(),
});

/** Disposition (route-independent): half-life, Vd, optional clearance. */
const DispositionSchema = z.strictObject({
  halfLife: requiredParam(TimeUnit),
  vd: requiredParam(VolumeOfDistributionUnit),
  clearance: optionalParam(ClearanceUnit).optional(),
});

/**
 * Two-compartment disposition (handoff §12; the multi-compartment extension).
 * Stored in the most CITABLE clinical form — clearances and volumes — from which
 * the engine derives the micro-rate constants and eigenvalues. Present only on a
 * `two_compartment_first_order` compound (an omitted block keeps every existing
 * one-compartment compound valid). The route-independent {@link DispositionSchema}
 * (terminal half-life + steady-state Vd) is still carried alongside it, for the
 * caption and provenance rows.
 */
const Disposition2cSchema = z.strictObject({
  /** Total (central) clearance, CL — sets AUC = Dose/CL. */
  clearance: requiredParam(ClearanceUnit),
  /** Central volume of distribution, Vc — the concentration reference (C = A/Vc). */
  centralVd: requiredParam(VolumeOfDistributionUnit),
  /** Inter-compartmental clearance, Q — drives the distribution phase. */
  interCompartmentalClearance: requiredParam(ClearanceUnit),
  /** Peripheral volume of distribution, Vp. */
  peripheralVd: requiredParam(VolumeOfDistributionUnit),
});

/**
 * Three-compartment disposition (handoff §12; the multi-compartment extension,
 * Stage B). Same citable clinical form as {@link Disposition2cSchema} — clearances
 * and volumes — but a central compartment exchanging with TWO peripheral ones, so
 * the engine derives five micro-rate constants and the three eigenvalues α>β>γ
 * (see `engine/models3c.ts`). Present only on a `three_compartment_first_order`
 * compound; the route-independent {@link DispositionSchema} (terminal half-life +
 * steady-state Vd) is still carried alongside for the caption and provenance rows.
 * Field names map to engine `ThreeCompParams`: centralVd=Vc, clearance=CL,
 * interCompartmentalClearance2/peripheralVd2 = Q2/Vp2 (rapid peripheral),
 * interCompartmentalClearance3/peripheralVd3 = Q3/Vp3 (slow peripheral).
 */
const Disposition3cSchema = z.strictObject({
  /** Total (central) clearance, CL — sets AUC = Dose/CL. */
  clearance: requiredParam(ClearanceUnit),
  /** Central volume of distribution, Vc — the concentration reference (C = A/Vc). */
  centralVd: requiredParam(VolumeOfDistributionUnit),
  /** Inter-compartmental clearance to the rapid peripheral compartment, Q2. */
  interCompartmentalClearance2: requiredParam(ClearanceUnit),
  /** Rapid peripheral volume of distribution, Vp2. */
  peripheralVd2: requiredParam(VolumeOfDistributionUnit),
  /** Inter-compartmental clearance to the slow (deep) peripheral compartment, Q3. */
  interCompartmentalClearance3: requiredParam(ClearanceUnit),
  /** Slow (deep) peripheral volume of distribution, Vp3. */
  peripheralVd3: requiredParam(VolumeOfDistributionUnit),
});

/**
 * Michaelis–Menten disposition (handoff §12; the NONLINEAR seam). Present only on
 * a `one_compartment_michaelis_menten` compound, and — uniquely — it REPLACES the
 * ordinary {@link DispositionSchema} rather than sitting alongside it, as the
 * multi-compartment blocks do.
 *
 * That is the point, not an inconsistency. Every other block carries a
 * `halfLife`, because for a linear drug the half-life is a constant of the
 * molecule. For a saturable drug it is not: it rises with concentration, so the
 * same drug has a different half-life at every dose (`engine/modelsMM.ts`'s
 * `apparentHalfLifeMM`). A stored `halfLife` on phenytoin would not be an
 * imprecise number, it would be a category error — exactly the kind this project
 * exists to expose — so the schema makes it impossible to write one.
 */
const DispositionMMSchema = z.strictObject({
  /** Volume of distribution — same meaning as in the linear model. */
  vd: requiredParam(VolumeOfDistributionUnit),
  /** Maximum elimination rate, Vmax — the ceiling the enzymes cannot exceed. */
  vmax: requiredParam(MaxRateUnit),
  /** Michaelis constant, Km — the concentration at which elimination runs at Vmax/2. */
  km: requiredParam(ConcentrationUnit),
});

/** Oral route: first-order absorption (needs ka, or a Tmax to derive it from). */
const OralRouteSchema = z.strictObject({
  available: z.boolean(),
  F: optionalParam(FractionUnit).optional(),
  ka: optionalParam(RateConstantUnit).optional(),
  tmax: optionalParam(TimeUnit).optional(),
});

/**
 * INJECTED DEPOT routes — intramuscular (`im`) and subcutaneous (`sc`). One schema
 * for two clinical routes, and that sharing is a finding rather than a convenience.
 *
 * Both are FIRST-ORDER inputs — the same input type as a swallowed tablet — so, like
 * {@link TransdermalRouteSchema}, they add no engine math: `derive.ts` resolves them to
 * the engine's `oral` route and the mode spine's `oralConcentrationFromModes`
 * computes them for a 1-, 2- or 3-compartment disposition alike. The fields are
 * therefore oral's fields, and that shape-sharing is the point.
 *
 * WHAT IS NOT SHARED WITH ORAL IS THE MEANING OF `F`, and it is the inverse of the
 * patch's absent one. `TransdermalRouteSchema` has no `F` because a stated delivery
 * rate is ALREADY systemic. An injection keeps `F` — but it is absorption completeness
 * ONLY, with no first-pass term in it, because an injected depot drains to the systemic
 * circulation without crossing gut wall or portal liver first. Two consequences, both
 * load-bearing:
 *
 *  - A metabolite's `firstPassFraction` (`ffp`) MUST NOT ride these routes. `ffp` is
 *    pre-systemic gut/hepatic extraction; on an injection that mass does not exist.
 *    Because they resolve to the engine's `oral`, the engine would otherwise apply
 *    it — the engine keys on input type and cannot tell a needle from a tablet, which
 *    is exactly the ignorance the layering buys. `appliesFirstPass` (`derive.ts`)
 *    strips it at the data boundary, where clinical route vocabulary belongs.
 *  - An injected `F` and an oral `F` for the same drug are not the same quantity and
 *    their gap is the teaching content (ketamine ~64% IM vs ~17% oral; sumatriptan
 *    ~97% SC vs ~15% oral — the difference is first pass). Never copy one into the
 *    other's slot.
 *
 * WHY `sc` SHARES THIS SCHEMA INSTEAD OF EARNING ITS OWN. `RectalRouteSchema` is
 * separate because rectal `F` is a genuinely third quantity (partial first pass).
 * Subcutaneous is not a fourth: SC drains to the systemic circulation exactly as IM
 * does, so its `F` is absorption completeness with no first-pass term — the SAME
 * category as `im`, to the letter. Giving `sc` a parallel schema would have meant
 * writing a doc comment that implied a distinction the physiology does not contain,
 * and this project's failure mode is manufactured distinctions, not missing ones.
 *
 * So the route sequence transdermal → im → rectal → sc, which had been widening the
 * meanings of `F` at every step (absent / none / partial), CLOSES here instead: `sc`
 * is the first clinical route to share both an engine input type AND an `F` category
 * with a route already shipped. What separates IM from SC is real but lives elsewhere
 * — absorption RATE and its variability (subcutaneous fat is more poorly perfused
 * than muscle) — and that is `ka`, a number each route's own block already carries.
 * A difference in the value of a field is not a difference in what the field means.
 */
const InjectedDepotRouteSchema = z.strictObject({
  available: z.boolean(),
  /** Absorption completeness from the depot — NOT a first-pass-inclusive F. */
  F: optionalParam(FractionUnit).optional(),
  ka: optionalParam(RateConstantUnit).optional(),
  tmax: optionalParam(TimeUnit).optional(),
});

/**
 * Rectal route (handoff §12; the "more routes" seam). A suppository or gel is a
 * FIRST-ORDER input from a mucosal depot, so — like {@link ImRouteSchema} — it adds
 * no engine math: `derive.ts` resolves it to the engine's `oral` route and the mode
 * spine computes it for a 1-, 2- or 3-compartment disposition alike. The fields are
 * oral's fields, and the shape-sharing is again the point.
 *
 * `F` IS A THIRD KIND, and this is the whole reason the route earns a schema of its
 * own rather than reusing `ImRouteSchema`. The set now holds all three:
 *
 *  - `im`     — absorption completeness, NO first-pass term (an injection drains
 *               straight to the systemic circulation).
 *  - `oral`   — absorption × survival of the FULL first pass (gut wall + portal liver).
 *  - `rectal` — absorption × survival of a PARTIAL first pass. The rectal venous
 *               drainage is split: the superior rectal vein feeds the portal system,
 *               the middle and inferior veins drain systemically. So some of the dose
 *               crosses the liver first and some does not.
 *
 * That partial bypass is the route's teaching content, and it is also the trap. The
 * textbook shorthand is "rectal bypasses first pass"; what the data says for diazepam
 * is that it recovers only ~15 points of F (0.75 oral → 0.90 rectal) — a small gain,
 * because diazepam is a LOW-EXTRACTION drug and there was little first pass to escape.
 * A high-extraction drug would show a large gain. Never write the bypass as complete,
 * and never copy `im`'s "carries no first-pass loss" sentence onto this route.
 *
 * The split fraction itself is NOT stored, and deliberately so: no source quantifies
 * how much of a given dose took which vein, it varies with insertion depth, and
 * manufacturing it would be the invented-population failure the phenotype presets and
 * the unmerged variability bands both refuse. The stored `F` is empirical — it already
 * contains whatever first-pass loss occurred, lumped and measured, which is the only
 * honest form the number comes in. See `appliesFirstPass` in `derive.ts` for the one
 * place that lumping has a consequence (a metabolite's `ffp`).
 */
const RectalRouteSchema = z.strictObject({
  available: z.boolean(),
  /** Empirical bioavailability — absorption × survival of a PARTIAL first pass. */
  F: optionalParam(FractionUnit).optional(),
  ka: optionalParam(RateConstantUnit).optional(),
  tmax: optionalParam(TimeUnit).optional(),
});

/** Intravenous routes: F = 1 by definition; no absorption parameters. */
const IvRouteSchema = z.strictObject({
  available: z.boolean(),
  F: optionalParam(FractionUnit).optional(),
});

/**
 * Mass delivery rate — the zero-order input of a patch. Canonical mg/h; the
 * `mg/day` form is how patch labels actually state it (`engine/units.ts`
 * `massRate` converts).
 */
const MassRateUnit = z.enum(['mg/h', 'g/h', 'mg/min', 'mg/day', 'g/day']);

/**
 * Transdermal route (handoff §12; the "more routes" seam). A patch is a
 * ZERO-ORDER input — the same input type as an IV infusion — so it needs no new
 * engine math: `derive.ts` resolves it to the engine's `iv_infusion` route and
 * the mode spine's `infusionConcentrationFromModes` computes it, for a 1-, 2- or
 * 3-compartment disposition alike. What is transdermal-specific is not the math
 * but the DATA: the input is stated as a rate, and the wear duration is a
 * property of the PRODUCT (a clonidine patch is worn 7 days), unlike an infusion
 * duration, which is a free clinical choice and therefore a UI input.
 *
 * NOTE THE ABSENT `F`, which is deliberate and load-bearing — the same posture as
 * {@link DispositionMMSchema} refusing a `halfLife`. A patch label states two
 * different fractions-ish numbers, and confusing them silently halves the curve:
 * Catapres-TTS "delivers 0.1 mg/day" AND reports "absolute bioavailability
 * approximately 60%". The delivered rate is ALREADY the systemic input — the
 * label's own steady-state concentrations prove it (0.1/0.2/0.3 mg/day ÷ CL
 * 10.62 L/h = 0.39/0.79/1.18 ng/mL, against a stated 0.4/0.8/1.1) — so applying
 * the 60% on top would double-count and put the curve ~40% low while still
 * looking plausible. Rather than trust a curator to not write `F`, the schema
 * makes it unwriteable: `deliveryRate` is the systemic input by definition. A
 * product whose rate is NOT already systemic needs a new field and a new gate,
 * not a quietly-reused `F`.
 */
const TransdermalRouteSchema = z.strictObject({
  available: z.boolean(),
  /** The zero-order systemic input rate the patch delivers (`R0`). */
  deliveryRate: requiredParam(MassRateUnit),
  /** How long the product is worn — sets the default zero-order window. */
  wearDuration: requiredParam(TimeUnit),
});

const RoutesSchema = z.strictObject({
  oral: OralRouteSchema.optional(),
  im: InjectedDepotRouteSchema.optional(),
  sc: InjectedDepotRouteSchema.optional(),
  rectal: RectalRouteSchema.optional(),
  iv_bolus: IvRouteSchema.optional(),
  iv_infusion: IvRouteSchema.optional(),
  transdermal: TransdermalRouteSchema.optional(),
});

/**
 * A metabolite formed from the parent (handoff §12; metabolites spike). The
 * previously-reserved `metabolites` slot, now typed. `fractionFormed` is the
 * fraction of the parent dose converted to this metabolite; `vd` and `halfLife`
 * are the metabolite's OWN one-compartment disposition. Its `sourceRef`s resolve
 * into the compound-level `sources` map (or a sentinel), exactly like every other
 * parameter — one bibliography per compound file.
 */
const MetaboliteSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'metabolite id must be lowercase alphanumeric with _ or - separators'),
  /** Human-facing metabolite name for the chart line and provenance rows. */
  name: z.string().min(1),
  /**
   * Pharmacologically active? A display hint — an inactive metabolite may still be
   * plotted (it carries exposure information) but the UI labels it as inactive.
   */
  active: z.boolean(),
  /**
   * Fraction of the SYSTEMICALLY-absorbed parent converted to this metabolite (the
   * formation ratio, `fm`). Drives the systemic-formation curve on every route.
   */
  fractionFormed: requiredParam(FractionUnit),
  /**
   * Optional fraction of the ORAL dose converted to this metabolite PRE-SYSTEMICALLY,
   * by gut-wall / hepatic first-pass extraction (`ffp`). This mass never enters the
   * systemic parent (it is already excluded by the route's bioavailable fraction `F`),
   * so it is purely ADDITIVE to `fractionFormed` and affects the ORAL route only — IV
   * routes bypass first-pass. Omitted ⇒ no first-pass term. Curation rules (see
   * docs/DATA_GUIDE.md): store only when `ffp` for THIS specific metabolite is citable;
   * do NOT also shave `F` (double-counting); mass balance bounds it `ffp ≤ 1 − F −
   * f_unabsorbed`. MW-adjust a molar fraction to mass, like `fractionFormed`.
   */
  firstPassFraction: requiredParam(FractionUnit).optional(),
  /** Metabolite volume of distribution — its own disposition, not the parent's. */
  vd: requiredParam(VolumeOfDistributionUnit),
  /** Metabolite elimination half-life — its own disposition, not the parent's. */
  halfLife: requiredParam(TimeUnit),
  /**
   * Optional short plain-language blurb surfaced ON SCREEN in the metabolism
   * section: what this metabolite is and whether it is active — the metabolite
   * analogue of the compound {@link CompoundSchema} `description`. Length-capped
   * (a ~2-liner) for the same tidy-layout reason; the longer metabolism story
   * belongs in the compound-level {@link CompoundSchema} `metabolism`. Distinct
   * from the technical curator `notes` below.
   */
  description: z.string().min(1).max(400).optional(),
  /** Curator reasoning for the metabolite's numbers (same posture as compound `notes`). */
  notes: z.string().optional(),
});

/**
 * The parameters one phenotype preset re-anchors (handoff §12, "variability
 * beyond half-life"). Everything a polymorphism does NOT touch is simply absent:
 * procainamide's Vd is acetylator-independent (Lima 1979), so no preset overrides
 * it, and NAPA's own disposition is renal, so no preset overrides that either.
 *
 * An override is a full parameter — `value` + unit + `derived` + `sourceRef` +
 * `conditions`, exactly like the base value it replaces. A phenotype is a
 * separately-cited population, not a multiplier on another population.
 */
const PhenotypeOverridesSchema = z.strictObject({
  /** Replaces `disposition.halfLife` — point AND range (see the range rule below). */
  halfLife: requiredParam(TimeUnit).optional(),
  /** Replaces `metabolites[id].fractionFormed` for a polymorphic formation step. */
  fractionFormed: z
    .array(
      z.strictObject({
        /** Must match a {@link MetaboliteSchema} `id` on this compound. */
        metaboliteId: z.string().min(1),
        param: requiredParam(FractionUnit),
      }),
    )
    .min(1)
    .optional(),
});

/**
 * One illustrative population archetype for a polymorphic enzyme.
 *
 * BRIGHT LINE: a preset is a population choice of exactly the same kind as the
 * 70 kg reference subject — "here is what the fast-acetylator population looks
 * like", never "here is what YOUR genotype does". The UI must present it as an
 * illustrative archetype; it must never ask the user for, or claim to use, their
 * genotype. See docs/DATA_GUIDE.md "phenotype-anchoring".
 */
const PhenotypePresetSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'phenotype id must be lowercase alphanumeric with _ or - separators'),
  /** Human-facing archetype name, e.g. "Fast acetylator". */
  label: z.string().min(1),
  /** Short on-screen blurb: what this phenotype is and what it does to the curve. */
  description: z.string().min(1).max(400),
  /**
   * Absent/empty ⇒ this preset IS the compound's base values. Required to be the
   * case for the FIRST preset (the default) — see the identity-default rule in
   * the compound `superRefine`.
   */
  overrides: PhenotypeOverridesSchema.optional(),
});

/**
 * Polymorphic-phenotype presets (handoff §12, "variability beyond half-life" —
 * the `geneticFactors` seam, now load-bearing rather than a bare label).
 *
 * WHY THIS EXISTS — it removes a real inconsistency, it is not decoration. The
 * engine takes ONE half-life and ONE `fm`, so a bimodal compound previously had
 * to anchor a single illustrative phenotype and leave the other in prose, and the
 * half-life range had to be narrowed to stay INSIDE the anchored phenotype — or
 * the variability slider would drag the parent to the other phenotype's half-life
 * while `fm` stayed pinned at the first one's, a state no real person occupies
 * (the documented procainamide catch). Presets make that unreachable by
 * construction: switching phenotype swaps every affected parameter ATOMICALLY.
 *
 * The two levels compose and must be described that way on screen:
 *   preset = WHICH population,  slider = the spread WITHIN that population.
 */
const PhenotypesSchema = z.strictObject({
  /** The polymorphic enzyme/factor, e.g. "NAT2". Must appear in `geneticFactors`. */
  factor: z.string().min(1),
  /**
   * At least two — a preset list of one is not a phenotype contrast. `presets[0]`
   * is the DEFAULT and must carry no overrides, so the default render is the base
   * compound by construction rather than by reconstruction.
   */
  presets: z.array(PhenotypePresetSchema).min(2),
});

/**
 * Supported model discriminators (handoff §12 seam). `one_compartment_first_order`
 * is the v1 model; `two_compartment_first_order` adds a distribution phase and
 * requires the {@link Disposition2cSchema} block;
 * `one_compartment_michaelis_menten` is the nonlinear model and requires the
 * {@link DispositionMMSchema} block instead of the ordinary one.
 */
const ModelSchema = z.enum([
  'one_compartment_first_order',
  'two_compartment_first_order',
  'three_compartment_first_order',
  'one_compartment_michaelis_menten',
]);

/** A supported model discriminator. */
export type CompoundModel = z.infer<typeof ModelSchema>;

/**
 * The models whose kinetics are NONLINEAR — i.e. for which superposition is
 * invalid and `dosing.ts` must not be used (handoff §8, §12).
 *
 * This set is what `linear` now means. Before the nonlinear phase, `linear: false`
 * was effectively a synonym for "excluded from this project": the flag existed to
 * mark compounds we deliberately would not ship, and all three derivation
 * resolvers rejected on it. That is no longer true — a Michaelis–Menten compound
 * IS `linear: false` and ships. So `linear` has narrowed to its literal meaning:
 * *may this compound's doses be superposed?* Whether a compound is supported at
 * all is now decided by one question only — is there a resolver for its `model`?
 *
 * Because linearity is a property OF the model, `linear` is redundant with
 * `model` and is cross-checked against it below rather than trusted (the same
 * posture as the pre-existing `flags.nonlinear` ↔ `linear` check). It is kept
 * because it is the flag handoff §8 specifies as the superposition gate, and
 * because a reader of a compound file should not have to know which models are
 * nonlinear to know whether doses add up.
 */
export const NONLINEAR_MODELS: ReadonlySet<CompoundModel> = new Set([
  'one_compartment_michaelis_menten',
]);

// ── Compound ───────────────────────────────────────────────────────────────

/**
 * One compound file (handoff §8). Required: identity, model/linearity gate,
 * disposition (half-life + Vd), routes, sources, curator notes. Optional:
 * molecular data, variability, metabolites (reserved), flags.
 */
export const CompoundSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9_-]+$/, 'id must be lowercase alphanumeric with _ or - separators'),
    schemaVersion: z.literal(1),
    names: z.strictObject({
      inn: z.string().optional(),
      usan: z.string().optional(),
      brand: z.array(z.string()).optional(),
      synonyms: z.array(z.string()).optional(),
    }),
    /**
     * REQUIRED plain-language blurb surfaced ON SCREEN above the chart: what the
     * compound is and what it is typically used for (for a toxin, what it is —
     * a pesticide, a plant alkaloid — not a therapy, keeping the educational-not-
     * clinical bright line, handoff §1). Kept to ~2 sentences (`.max`) so the
     * fixed-height "About" box never changes height between compounds — the
     * curation RULE that stops the interface jumping when the user switches
     * compound (docs/DATA_GUIDE.md). Deeper metabolism prose goes in {@link metabolism}
     * (which renders BELOW the chart, where growth is harmless); curator-only
     * reasoning stays in `notes`.
     */
    description: z.string().min(1).max(400),
    /**
     * Optional longer plain-language narrative about how the compound is
     * metabolised / eliminated and what its metabolites are (active vs inactive,
     * which dominates, the teaching point). Unlike {@link description} this is NOT
     * length-capped and renders BELOW the chart, so it may be as long as the
     * story needs without jumping the fixed-height About box or the chart. Still
     * user-facing prose — distinct from the technical curator `notes` and from each
     * metabolite's own {@link MetaboliteSchema} `notes`.
     */
    metabolism: z.string().min(1).optional(),
    molecular: z
      .strictObject({
        molarMass: z.strictObject({ value: z.number(), unit: z.string() }),
      })
      .optional(),

    /**
     * Dose (mg) the chart should OPEN at for this compound. Optional; omitted,
     * the interface uses its generic default (`DEFAULT_DOSE_MG`).
     *
     * A dose is normally a UI input, not a compound property — the same reason an
     * infusion duration is deliberately absent from these files (handoff §7). The
     * exception is SCALE: an interface default of 500 mg is meaningless for a drug
     * dosed in micrograms and equally meaningless for one dosed in grams, and a
     * compound whose opening view misrepresents it teaches the wrong thing before
     * the user touches anything. Ethanol is the case that forced this: at 500 mg —
     * half a gram, a thirtieth of a standard drink — its concentration never
     * approaches Km, so the curve renders as an ordinary first-order exponential
     * and the saturation it exists to demonstrate is invisible.
     *
     * This is NOT a recommended, typical, or safe dose, and must never be
     * presented as one (the bright line, CLAUDE.md). It states the scale the
     * molecule operates at so the first curve drawn is a fair picture of it; the
     * user changes it freely, and every curve remains illustrative.
     */
    illustrativeDoseMg: z.number().positive().optional(),

    /** Model discriminator — the seam for future model types (§12). */
    model: ModelSchema,
    /**
     * false ⇒ superposition is invalid, so the compound's curve must come from
     * the nonlinear integrator rather than `dosing.ts`. Determined by `model`
     * (see {@link NONLINEAR_MODELS}) and cross-checked against it below.
     */
    linear: z.boolean(),

    /**
     * Route-independent disposition (half-life + Vd). Required for every LINEAR
     * model and forbidden on a nonlinear one, which has no half-life to state and
     * carries {@link dispositionMM} instead — see {@link DispositionMMSchema}.
     */
    disposition: DispositionSchema.optional(),
    /** Two-compartment parameters (§12) — required iff model is two-compartment. */
    disposition2c: Disposition2cSchema.optional(),
    /** Three-compartment parameters (§12) — required iff model is three-compartment. */
    disposition3c: Disposition3cSchema.optional(),
    /** Michaelis–Menten parameters (§12) — required iff model is Michaelis–Menten. */
    dispositionMM: DispositionMMSchema.optional(),
    routes: RoutesSchema,

    variability: z
      .strictObject({
        geneticFactors: z.array(z.string()).optional(),
        /**
         * Illustrative population archetypes for a polymorphic factor (§12). An
         * omitted block = the compound models one unnamed population, which is
         * every compound that predates this feature.
         */
        phenotypes: PhenotypesSchema.optional(),
        notes: z.string().optional(),
      })
      .optional(),

    /** Parent→metabolite kinetics (§12); an empty/omitted array = parent-only. */
    metabolites: z.array(MetaboliteSchema).optional(),

    flags: z
      .strictObject({
        nonlinear: z.boolean().optional(),
        narrowTherapeuticIndex: z.boolean().optional(),
      })
      .optional(),

    sources: z.record(z.string(), SourceSchema),
    notes: z.string(),
    /**
     * Optional short caption surfaced ON SCREEN beneath the chart (unlike `notes`,
     * which is curator-only). For a compound whose curve needs a caveat the viewer
     * must see. Two kinds so far: **what the axis means** — lithium, dosed/plotted
     * as elemental-lithium mg but clinically an mEq/L (mmol/L) ion concentration;
     * psilocin, dosed as the prodrug — and **what the curve is not** — the
     * Michaelis–Menten compounds, which have no fixed half-life to quote.
     *
     * It began as the units case alone, and the UI hardcoded a "Units." lead-in;
     * that became a false label once the nonlinear compounds used the slot, so the
     * note now renders bare. **Make the first clause name its own subject** — it
     * arrives on screen without a heading.
     *
     * Keep it to one or two plain sentences; deeper reasoning stays in `notes`.
     */
    displayNote: z.string().optional(),
  })
  .superRefine((compound, ctx) => {
    // At least one human-facing name so the picker has something to show.
    const { inn, usan, synonyms } = compound.names;
    if (!inn && !usan && !(synonyms && synonyms.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'names must include at least one of inn, usan, or a synonym',
        path: ['names'],
      });
    }

    // Every non-null sourceRef must resolve to a real source or a sentinel.
    const valid = new Set<string>([...Object.keys(compound.sources), ...SOURCE_REF_SENTINELS]);
    const checkRef = (sourceRef: string | null, where: string) => {
      if (sourceRef !== null && !valid.has(sourceRef)) {
        ctx.addIssue({
          code: 'custom',
          message: `sourceRef "${sourceRef}" at ${where} resolves to neither a key in sources nor a recognised sentinel (${SOURCE_REF_SENTINELS.join(', ')})`,
          path: [...where.split('.'), 'sourceRef'],
        });
      }
    };
    if (compound.disposition) {
      checkRef(compound.disposition.halfLife.sourceRef, 'disposition.halfLife');
      checkRef(compound.disposition.vd.sourceRef, 'disposition.vd');
      if (compound.disposition.clearance) {
        checkRef(compound.disposition.clearance.sourceRef, 'disposition.clearance');
      }
    }
    if (compound.dispositionMM) {
      const mm = compound.dispositionMM;
      checkRef(mm.vd.sourceRef, 'dispositionMM.vd');
      checkRef(mm.vmax.sourceRef, 'dispositionMM.vmax');
      checkRef(mm.km.sourceRef, 'dispositionMM.km');
    }
    if (compound.disposition2c) {
      const d2 = compound.disposition2c;
      checkRef(d2.clearance.sourceRef, 'disposition2c.clearance');
      checkRef(d2.centralVd.sourceRef, 'disposition2c.centralVd');
      checkRef(
        d2.interCompartmentalClearance.sourceRef,
        'disposition2c.interCompartmentalClearance',
      );
      checkRef(d2.peripheralVd.sourceRef, 'disposition2c.peripheralVd');
    }
    if (compound.disposition3c) {
      const d3 = compound.disposition3c;
      checkRef(d3.clearance.sourceRef, 'disposition3c.clearance');
      checkRef(d3.centralVd.sourceRef, 'disposition3c.centralVd');
      checkRef(
        d3.interCompartmentalClearance2.sourceRef,
        'disposition3c.interCompartmentalClearance2',
      );
      checkRef(d3.peripheralVd2.sourceRef, 'disposition3c.peripheralVd2');
      checkRef(
        d3.interCompartmentalClearance3.sourceRef,
        'disposition3c.interCompartmentalClearance3',
      );
      checkRef(d3.peripheralVd3.sourceRef, 'disposition3c.peripheralVd3');
    }
    for (const [routeName, route] of Object.entries(compound.routes)) {
      if (!route) continue;
      if ('F' in route && route.F) checkRef(route.F.sourceRef, `routes.${routeName}.F`);
      if ('ka' in route && route.ka) checkRef(route.ka.sourceRef, `routes.${routeName}.ka`);
      if ('tmax' in route && route.tmax) checkRef(route.tmax.sourceRef, `routes.${routeName}.tmax`);
    }
    // Metabolite parameters cite the same compound-level bibliography.
    compound.metabolites?.forEach((m, i) => {
      checkRef(m.fractionFormed.sourceRef, `metabolites.${i}.fractionFormed`);
      if (m.firstPassFraction)
        checkRef(m.firstPassFraction.sourceRef, `metabolites.${i}.firstPassFraction`);
      checkRef(m.vd.sourceRef, `metabolites.${i}.vd`);
      checkRef(m.halfLife.sourceRef, `metabolites.${i}.halfLife`);
    });

    // ── Phenotype presets (§12) ────────────────────────────────────────────
    const phenotypes = compound.variability?.phenotypes;
    if (phenotypes) {
      // The declared factor must also be listed as a genetic factor — the same
      // cross-check-don't-trust posture as `linear` ↔ `model`, so the two
      // descriptions of the same polymorphism cannot drift apart.
      const factors = compound.variability?.geneticFactors ?? [];
      if (!factors.includes(phenotypes.factor)) {
        ctx.addIssue({
          code: 'custom',
          message: `variability.phenotypes.factor "${phenotypes.factor}" is not listed in variability.geneticFactors [${factors.join(', ')}] — the polymorphism driving the presets must be declared as a genetic factor`,
          path: ['variability', 'geneticFactors'],
        });
      }

      // A Michaelis–Menten compound has no half-life to re-anchor (same reason it
      // may not carry a `disposition` block at all). Computed here rather than
      // reusing the `isMichaelisMenten` below, which is declared further down.
      const mmModel = compound.model === 'one_compartment_michaelis_menten';
      const metaboliteIds = new Set((compound.metabolites ?? []).map((m) => m.id));
      const seenIds = new Set<string>();

      phenotypes.presets.forEach((p, i) => {
        const at = `variability.phenotypes.presets.${i}`;
        if (seenIds.has(p.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate phenotype preset id "${p.id}"`,
            path: ['variability', 'phenotypes', 'presets', i, 'id'],
          });
        }
        seenIds.add(p.id);

        const overrides = p.overrides;
        const isEmpty =
          !overrides || (!overrides.halfLife && (overrides.fractionFormed?.length ?? 0) === 0);

        // IDENTITY DEFAULT: presets[0] must BE the base compound, not a
        // reconstruction of it. This is what makes the default render provably
        // identical to the pre-phenotype compound — there is nothing to apply.
        if (i === 0 && !isEmpty) {
          ctx.addIssue({
            code: 'custom',
            message: `the first phenotype preset ("${p.id}") is the default and must carry no overrides: the compound's base disposition/fm values ARE the default phenotype. Put the CONTRASTING phenotype's values in a later preset, and make sure the base values are the ones this preset's label claims.`,
            path: ['variability', 'phenotypes', 'presets', 0, 'overrides'],
          });
        }
        // A non-default preset that changes nothing is a UI lie: it offers the
        // user a choice that does not exist.
        if (i > 0 && isEmpty) {
          ctx.addIssue({
            code: 'custom',
            message: `phenotype preset "${p.id}" overrides nothing, so selecting it would change no curve — either give it the parameters that differ, or drop it`,
            path: ['variability', 'phenotypes', 'presets', i, 'overrides'],
          });
        }

        if (overrides?.halfLife) {
          checkRef(overrides.halfLife.sourceRef, `${at}.overrides.halfLife`);
          // A stored clearance WINS over half-life when derivation resolves ke
          // (see derive.ts resolveKe). So a half-life override on a compound that
          // also stores CL would be silently discarded — the curve would not move
          // and nothing would say so. Reject rather than mislead.
          if (compound.disposition?.clearance && compound.disposition.clearance.value !== null) {
            ctx.addIssue({
              code: 'custom',
              message: `phenotype preset "${p.id}" overrides halfLife, but this compound also stores disposition.clearance, which TAKES PRECEDENCE when ke is resolved — the override would be silently ignored and the curve would not move. Either drop the stored clearance (it is usually a circular cross-check anyway) or model the phenotype some other way.`,
              path: ['variability', 'phenotypes', 'presets', i, 'overrides', 'halfLife'],
            });
          }
          if (mmModel) {
            ctx.addIssue({
              code: 'custom',
              message: `phenotype preset "${p.id}" overrides halfLife, but a Michaelis–Menten compound has no half-life to re-anchor (its apparent half-life rises with concentration). Re-anchor dispositionMM parameters instead — not supported yet.`,
              path: ['variability', 'phenotypes', 'presets', i, 'overrides', 'halfLife'],
            });
          }
        }
        overrides?.fractionFormed?.forEach((f, j) => {
          checkRef(f.param.sourceRef, `${at}.overrides.fractionFormed.${j}.param`);
          if (!metaboliteIds.has(f.metaboliteId)) {
            ctx.addIssue({
              code: 'custom',
              message: `phenotype preset "${p.id}" overrides fractionFormed for metaboliteId "${f.metaboliteId}", which is not a metabolite of this compound (have: ${[...metaboliteIds].join(', ') || 'none'})`,
              path: [
                'variability',
                'phenotypes',
                'presets',
                i,
                'overrides',
                'fractionFormed',
                j,
                'metaboliteId',
              ],
            });
          }
        });
      });
    }

    // The two-compartment model and its parameter block must agree, so neither a
    // 2-comp compound is missing its parameters nor a 1-comp compound carries an
    // ignored block (handoff §12).
    const isTwoComp = compound.model === 'two_compartment_first_order';
    if (isTwoComp && !compound.disposition2c) {
      ctx.addIssue({
        code: 'custom',
        message:
          'model "two_compartment_first_order" requires a disposition2c block (CL, Vc, Q, Vp)',
        path: ['disposition2c'],
      });
    }
    if (!isTwoComp && compound.disposition2c) {
      ctx.addIssue({
        code: 'custom',
        message: `disposition2c is only valid for model "two_compartment_first_order", not "${compound.model}"`,
        path: ['disposition2c'],
      });
    }

    const isThreeComp = compound.model === 'three_compartment_first_order';
    if (isThreeComp && !compound.disposition3c) {
      ctx.addIssue({
        code: 'custom',
        message:
          'model "three_compartment_first_order" requires a disposition3c block (CL, Vc, Q2, Vp2, Q3, Vp3)',
        path: ['disposition3c'],
      });
    }
    if (!isThreeComp && compound.disposition3c) {
      ctx.addIssue({
        code: 'custom',
        message: `disposition3c is only valid for model "three_compartment_first_order", not "${compound.model}"`,
        path: ['disposition3c'],
      });
    }

    // The Michaelis–Menten model and its parameter block must agree. Unlike the
    // multi-compartment blocks, dispositionMM REPLACES `disposition` rather than
    // supplementing it, so both directions are checked: a nonlinear compound must
    // not state a half-life it does not have, and a linear one must.
    const isMichaelisMenten = compound.model === 'one_compartment_michaelis_menten';
    if (isMichaelisMenten && !compound.dispositionMM) {
      ctx.addIssue({
        code: 'custom',
        message:
          'model "one_compartment_michaelis_menten" requires a dispositionMM block (Vd, Vmax, Km)',
        path: ['dispositionMM'],
      });
    }
    if (!isMichaelisMenten && compound.dispositionMM) {
      ctx.addIssue({
        code: 'custom',
        message: `dispositionMM is only valid for model "one_compartment_michaelis_menten", not "${compound.model}"`,
        path: ['dispositionMM'],
      });
    }
    if (isMichaelisMenten && compound.disposition) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a Michaelis–Menten compound must not carry a `disposition` block: its half-life is not a constant of the drug but rises with concentration, so a stored value would be meaningless. Put Vd in dispositionMM instead.',
        path: ['disposition'],
      });
    }
    if (!isMichaelisMenten && !compound.disposition) {
      ctx.addIssue({
        code: 'custom',
        message: `model "${compound.model}" requires a disposition block (half-life + Vd)`,
        path: ['disposition'],
      });
    }

    // `linear` is the superposition gate, and it is a property OF the model — so
    // it is cross-checked rather than trusted, and cannot drift from the model it
    // describes (see NONLINEAR_MODELS).
    const shouldBeLinear = !NONLINEAR_MODELS.has(compound.model);
    if (compound.linear !== shouldBeLinear) {
      ctx.addIssue({
        code: 'custom',
        message: `linear (${compound.linear}) contradicts model "${compound.model}", whose kinetics are ${shouldBeLinear ? 'linear' : 'nonlinear'}. Superposition validity is a property of the model, not an independent choice.`,
        path: ['linear'],
      });
    }
    // If the redundant flags.nonlinear is present it must agree (be the negation).
    if (compound.flags?.nonlinear !== undefined && compound.flags.nonlinear === compound.linear) {
      ctx.addIssue({
        code: 'custom',
        message: `flags.nonlinear (${compound.flags.nonlinear}) must be the negation of linear (${compound.linear})`,
        path: ['flags', 'nonlinear'],
      });
    }
  });

// ── Inferred / exported types ──────────────────────────────────────────────

/** A validated compound file. */
export type Compound = z.infer<typeof CompoundSchema>;

/** A validated metabolite entry (handoff §12). */
export type Metabolite = z.infer<typeof MetaboliteSchema>;

/**
 * A route as the DATA layer names it — a clinical route of administration. This
 * is deliberately WIDER than the engine's `Route` (handoff §4, §12): the engine's
 * vocabulary is INPUT TYPES (bolus / first-order / zero-order), and neither
 * `transdermal` nor `im` introduces a new one — a patch is zero-order in, exactly
 * like an IV infusion, and an intramuscular depot is first-order in, exactly like
 * a swallowed tablet — so they resolve onto `iv_infusion` and `oral` respectively
 * and the engine stays untouched (`engineRouteOf` in `derive.ts`). Adding either to
 * the engine's own union would buy a dispatch branch that duplicates existing math —
 * code without meaning. "Which needle/patch/tablet" is a fact about drugs, which the
 * engine is required not to know.
 *
 * Note what the widening costs, which `im` is the first route to expose: a clinical
 * route that SHARES an engine input type does not thereby share every clinical fact
 * about that type. Oral carries pre-systemic first-pass extraction; an injection does
 * not. See {@link ImRouteSchema} and `appliesFirstPass` in `derive.ts`.
 *
 * `rectal` then shows that the shared fact is not even BINARY. Three routes now map to
 * the engine's one first-order input, and each means something different by `F`: none
 * (`im`), all (`oral`), and some-unquantified-part (`rectal`). A boolean was enough to
 * separate the first two; the third is representable only because its `F` is measured
 * whole rather than decomposed. See {@link RectalRouteSchema}.
 *
 * `sc` is where that widening STOPS, and a negative result is worth as much shelf space
 * as the three positive ones. Four clinical routes now ride the engine's one first-order
 * input, but there are still only three `F` categories: subcutaneous drains systemically
 * exactly as intramuscular does, so it shares `im`'s category to the letter and shares
 * its schema ({@link InjectedDepotRouteSchema}) to say so. The lesson the first three
 * routes taught — "a shared input type does not carry every clinical fact" — must not
 * harden into "a new route always means a new fact." Sometimes the honest addition is
 * the one that adds a row to the picker and nothing to the taxonomy.
 */
export type DataRoute =
  | 'oral'
  | 'im'
  | 'sc'
  | 'rectal'
  | 'iv_bolus'
  | 'iv_infusion'
  | 'transdermal';

/**
 * Every {@link DataRoute} as a RUNTIME value — the list a test can iterate.
 *
 * This exists because a hardcoded route list in a test is a silent coverage hole,
 * and the project has now dug that hole twice: `tests/data/loader.test.ts` derives
 * every bundled compound against a literal array, and when `im` shipped it was not
 * added, so ketamine's IM route generated ZERO derivation tests for three days and
 * nothing failed to tell us. `transdermal` was added by hand and got lucky. The
 * `satisfies` clause below makes the omission a COMPILE error instead: drop a route
 * from this tuple and the type no longer covers `DataRoute`.
 *
 * Presentation order lives separately in `ui/curve.ts` (`ENGINE_ROUTES`) — that is a
 * UI concern and may reorder freely; this one is about exhaustiveness alone.
 */
export const DATA_ROUTES = [
  'oral',
  'im',
  'sc',
  'rectal',
  'iv_bolus',
  'iv_infusion',
  'transdermal',
] as const satisfies readonly DataRoute[];

// Compile-time proof the tuple above is EXHAUSTIVE, not merely well-typed: a
// `satisfies readonly DataRoute[]` alone would happily accept a list missing `im`.
// This assignment fails if any DataRoute member is absent from DATA_ROUTES.
type _DataRoutesAreExhaustive =
  Exclude<DataRoute, (typeof DATA_ROUTES)[number]> extends never ? true : never;
const _dataRoutesExhaustive: _DataRoutesAreExhaustive = true;
void _dataRoutesExhaustive;

/** A single provenance-carrying parameter (generic over unit). */
export interface CompoundParameter {
  value: number | null;
  range?: [number, number];
  unit: string;
  derived: boolean;
  sourceRef: string | null;
  conditions?: string;
}

/** A literature source entry. */
export type CompoundSource = z.infer<typeof SourceSchema>;

/** Best human-facing display name for a compound (INN ▸ USAN ▸ id). */
export function displayName(compound: Compound): string {
  return compound.names.inn ?? compound.names.usan ?? compound.id;
}
