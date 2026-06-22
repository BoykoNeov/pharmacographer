/**
 * Compound loading + validation (handoff §8, §13 Phase 3).
 *
 * Turns raw JSON (a bundled compound file, or any untrusted object) into a
 * validated {@link Compound}. Invalid files fail loudly with a readable Zod
 * report rather than flowing half-formed data into the engine.
 *
 * DATA layer: depends on the schema (and transitively the engine), never the
 * reverse.
 */

import { z } from 'zod';
import { CompoundSchema, displayName, type Compound } from './schema.ts';

/**
 * Validate a raw, already-parsed object against {@link CompoundSchema}. Throws
 * an `Error` with a human-readable, multi-line report (via `z.prettifyError`)
 * if validation fails. Use this for any compound from outside the bundle.
 */
export function parseCompound(raw: unknown): Compound {
  const result = CompoundSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid compound:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * All bundled compounds, validated and sorted by display name.
 *
 * Uses Vite's `import.meta.glob` to pick up every `compounds/*.json` at build
 * time — adding a compound is dropping in a file, no registry edit. Eager so the
 * data is available synchronously. A malformed file throws, naming the file, so
 * a bad addition can never ship silently.
 */
export function loadAllCompounds(): Compound[] {
  const modules = import.meta.glob<{ default: unknown }>('./compounds/*.json', { eager: true });
  return Object.entries(modules)
    .map(([path, mod]) => {
      try {
        return parseCompound(mod.default);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load compound ${path}: ${message}`, { cause: error });
      }
    })
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}
