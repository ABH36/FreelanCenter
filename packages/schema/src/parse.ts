/**
 * `parseSiteConfig`: the single entry point for reading a config from any source (DB, AI, client, template package).
 * It never throws. Raw input is bounded (bytes, depth) *before* schema work so that an oversized or deeply nested
 * document cannot burn CPU (SRS 5.2 render-DoS rule), then migrated, then strictly validated.
 */
import { LIMITS } from './primitives';
import { migrateConfig } from './migrate';
import { siteConfigSchema, type SiteConfig } from './site-config';

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: SiteConfig; readonly migratedFrom: string | null }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const MAX_ISSUES = 25;

function tooDeep(value: unknown, depth = 0): boolean {
  if (depth > LIMITS.maxJsonDepth) return true;
  if (typeof value !== 'object' || value === null) return false;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (tooDeep(child, depth + 1)) return true;
  }
  return false;
}

const fail = (message: string, path = ''): ParseResult => ({ ok: false, issues: [{ path, message }] });

export function parseSiteConfig(raw: unknown): ParseResult {
  try {
    let json: string | undefined;
    try {
      json = JSON.stringify(raw);
    } catch {
      return fail('Config is not serialisable');
    }
    if (json === undefined) return fail('Config is not a JSON document');
    if (new TextEncoder().encode(json).length > LIMITS.maxJsonBytes) {
      return fail(`Config exceeds ${LIMITS.maxJsonBytes} bytes`);
    }
    if (tooDeep(raw)) return fail('Config is nested too deeply');

    const migrated = migrateConfig(raw);
    if (!migrated.ok) return fail(migrated.reason, 'schemaVersion');

    const parsed = siteConfigSchema.safeParse(migrated.config);
    if (parsed.success) {
      return { ok: true, config: parsed.data, migratedFrom: migrated.steps > 0 ? migrated.from : null };
    }
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, MAX_ISSUES)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  } catch {
    // Defence in depth: a schema bug must degrade to "invalid", never to an exception in a request.
    return fail('Config could not be validated');
  }
}
