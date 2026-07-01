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
 * Any other `sourceRef` must be a key in `sources`; the cross-check lives in the
 * compound-level {@link CompoundSchema} refinement.
 */
export const SOURCE_REF_SENTINELS = [
  'definition',
  'derived_from_tmax',
  'derived_from_clearance',
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

/** Oral route: first-order absorption (needs ka, or a Tmax to derive it from). */
const OralRouteSchema = z.strictObject({
  available: z.boolean(),
  F: optionalParam(FractionUnit).optional(),
  ka: optionalParam(RateConstantUnit).optional(),
  tmax: optionalParam(TimeUnit).optional(),
});

/** Intravenous routes: F = 1 by definition; no absorption parameters. */
const IvRouteSchema = z.strictObject({
  available: z.boolean(),
  F: optionalParam(FractionUnit).optional(),
});

const RoutesSchema = z.strictObject({
  oral: OralRouteSchema.optional(),
  iv_bolus: IvRouteSchema.optional(),
  iv_infusion: IvRouteSchema.optional(),
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
  /** Fraction of the parent dose converted to this metabolite (the formation ratio). */
  fractionFormed: requiredParam(FractionUnit),
  /** Metabolite volume of distribution — its own disposition, not the parent's. */
  vd: requiredParam(VolumeOfDistributionUnit),
  /** Metabolite elimination half-life — its own disposition, not the parent's. */
  halfLife: requiredParam(TimeUnit),
  /** Curator reasoning for the metabolite's numbers (same posture as compound `notes`). */
  notes: z.string().optional(),
});

/** Supported model discriminators. v1 ships only the one-compartment model. */
const ModelSchema = z.enum(['one_compartment_first_order']);

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
    molecular: z
      .strictObject({
        molarMass: z.strictObject({ value: z.number(), unit: z.string() }),
      })
      .optional(),

    /** Model discriminator — the seam for future model types (§12). */
    model: ModelSchema,
    /** false ⇒ superposition is invalid; v1 ships only linear compounds. */
    linear: z.boolean(),

    disposition: DispositionSchema,
    routes: RoutesSchema,

    variability: z
      .strictObject({
        geneticFactors: z.array(z.string()).optional(),
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
    checkRef(compound.disposition.halfLife.sourceRef, 'disposition.halfLife');
    checkRef(compound.disposition.vd.sourceRef, 'disposition.vd');
    if (compound.disposition.clearance) {
      checkRef(compound.disposition.clearance.sourceRef, 'disposition.clearance');
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
      checkRef(m.vd.sourceRef, `metabolites.${i}.vd`);
      checkRef(m.halfLife.sourceRef, `metabolites.${i}.halfLife`);
    });

    // `linear` is the authoritative gate; if the redundant flags.nonlinear is
    // present it must agree (be the negation), so the two can't drift.
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
