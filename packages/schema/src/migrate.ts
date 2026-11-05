/**
 * Schema versioning and forward migrations (FR-TPL-07, SRS 5.2): old documents are migrated *on read*, never in
 * place. Migration is deterministic and pure; an unknown or future version, a missing step or a step that throws is
 * refused with a reason instead of guessed at. Steps may carry a `down` so a migration is reversible, otherwise it is
 * declared one-way and `migrateDown` refuses.
 */
import { SCHEMA_VERSION } from './site-config';

export interface MigrationStep {
  readonly from: string;
  readonly to: string;
  readonly up: (config: Record<string, unknown>) => Record<string, unknown>;
  readonly down?: (config: Record<string, unknown>) => Record<string, unknown>;
}

export type MigrationResult =
  | {
      readonly ok: true;
      readonly config: Record<string, unknown>;
      readonly from: string;
      readonly to: string;
      readonly steps: number;
    }
  | { readonly ok: false; readonly reason: string };

/** Registered steps. `1.0` is the first version, so the list is empty until `migrate_1_0_to_1_1` exists. */
export const MIGRATIONS: readonly MigrationStep[] = [];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function createMigrator(steps: readonly MigrationStep[], current: string) {
  const byFrom = new Map(steps.map((s) => [s.from, s]));
  const byTo = new Map(steps.map((s) => [s.to, s]));

  function run(raw: unknown, target: string, direction: 'up' | 'down'): MigrationResult {
    if (!isRecord(raw)) return { ok: false, reason: 'Config is not an object' };
    const start = raw['schemaVersion'];
    if (typeof start !== 'string') return { ok: false, reason: 'schemaVersion is missing' };
    let doc: Record<string, unknown> = structuredClone(raw);
    let version = start;
    let count = 0;
    const seen = new Set<string>();
    while (version !== target) {
      if (seen.has(version)) return { ok: false, reason: `Migration cycle at ${version}` };
      seen.add(version);
      const step = direction === 'up' ? byFrom.get(version) : byTo.get(version);
      if (!step) {
        return { ok: false, reason: `No migration path from ${version} to ${target}` };
      }
      try {
        if (direction === 'up') {
          doc = step.up(doc);
          version = step.to;
        } else {
          if (!step.down) return { ok: false, reason: `Migration ${step.from} -> ${step.to} is one-way` };
          doc = step.down(doc);
          version = step.from;
        }
      } catch {
        return { ok: false, reason: `Migration step ${step.from} -> ${step.to} failed` };
      }
      doc = { ...doc, schemaVersion: version };
      count += 1;
    }
    return { ok: true, config: doc, from: start, to: target, steps: count };
  }

  return {
    migrateUp: (raw: unknown): MigrationResult => run(raw, current, 'up'),
    migrateDown: (raw: unknown, target: string): MigrationResult => run(raw, target, 'down'),
  };
}

const defaultMigrator = createMigrator(MIGRATIONS, SCHEMA_VERSION);

/** Bring any stored config to the current schema version, or refuse with a reason. */
export const migrateConfig = defaultMigrator.migrateUp;
