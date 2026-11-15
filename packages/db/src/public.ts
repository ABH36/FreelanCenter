/**
 * The `app_public` client for visitor paths in apps/sites (SRS 4.3, 5.3 item 1). Exported as
 * `@platform/db/public` so the sites app loads neither Prisma nor the tenant client. app_public holds no table
 * privilege; it can only call the SECURITY DEFINER functions granted to it (host resolution, the template catalogue,
 * preview links and, from P3 S7a, published versions and staging links).
 * No tenant context is ever set on this pool: the functions do not read one.
 */
import pg from 'pg';
import { connectionConfig } from './connection';
import { assertUrlRole } from './env';
import { UnsafeRoleError } from './errors';

export type HostOutcome = 'live' | 'placeholder' | 'maintenance' | 'unknown';

/** What a host may show. The ids are internal (cache bookkeeping, logs); never send them to a browser. */
export type HostRow =
  | { outcome: 'live'; workspaceId: string; projectId: string; siteVersionId: string }
  | { outcome: 'placeholder' | 'maintenance'; workspaceId: string; projectId: string }
  | { outcome: 'unknown' };

/** A published live version (P3 S7a: `app.get_published_version`). Immutable: cache it by id. */
export interface PublishedVersion {
  /** The stored SiteConfig. Untrusted until `parseSiteConfig` has seen it. */
  config: unknown;
  /** asset id -> { width: URL }, snapshotted when the version was published. Untrusted like the config. */
  assets: unknown;
  publishedAt: Date;
}

/** What a staging link may show now (P3 S7a: `app.get_staging_site`). */
export type StagingSite =
  | {
      status: 'ok';
      siteVersionId: string;
      config: unknown;
      assets: unknown;
      publishedAt: Date;
      sender: string | null;
    }
  | { status: 'revoked' | 'expired' | 'unavailable'; sender: string | null }
  | { status: 'unknown' };

/** One published catalogue template with its content (P2 S5b: `app.get_catalog_template`). */
export interface CatalogTemplate {
  templateId: string;
  slug: string;
  name: string;
  category: string;
  visibility: string;
  version: number;
  schemaVersion: string;
  /** The stored SiteConfig. Untrusted until `parseSiteConfig` has seen it. */
  config: unknown;
  manifest: unknown;
  contentHash: string;
}

export interface PublicDatabaseOptions {
  connectionString: string;
  /** Client-side pool size (Spike B B-3: explicit). Default 3: one host lookup per cache miss. */
  poolMax?: number;
  /** Per-query timeout in ms; a slow lookup fails rather than holding a visitor. Default 3 s. */
  queryTimeoutMs?: number;
  /**
   * Opening a new pooled connection (TCP, TLS, pooler auth). Default 10 s: a cold connection to the live pooler
   * took over 3 s (finding S7-10), and failing the first visitor of an instance is worse than a slow answer.
   */
  connectTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface PublicDatabase {
  resolveHost(hostname: string): Promise<HostRow>;
  /**
   * A published platform or marketplace template (latest version, or the one asked for), or null for anything else:
   * unknown, draft, archived, private or deleted look the same. Used by the preview route (FR-TPL-09).
   */
  getCatalogTemplate(templateId: string, version?: number): Promise<CatalogTemplate | null>;
  /**
   * Whether a preview link (its `lid`) was revoked in the dashboard (P2 S8b). True only for a link that exists and
   * was revoked; an unknown id is not revoked. Used by the preview route.
   */
  isPreviewLinkRevoked(linkId: string): Promise<boolean>;
  /** The name of the workspace that made a link, or null (P2 S10, acceptance C-25). */
  previewLinkSender(linkId: string): Promise<string | null>;
  /** A live version's content, or null for an unknown id or a staging version (P3 S7a). */
  getPublishedVersion(versionId: string): Promise<PublishedVersion | null>;
  /** What a (signature-verified) staging link may show now (P3 S7a). */
  getStagingSite(linkId: string): Promise<StagingSite>;
  /** Fails unless the connection role is app_public without SUPERUSER or BYPASSRLS. */
  verifyRole(): Promise<void>;
  close(): Promise<void>;
}

const OUTCOMES = new Set<string>(['live', 'placeholder', 'maintenance', 'unknown']);
const STAGING_STATUSES = new Set<string>(['ok', 'revoked', 'expired', 'unavailable', 'unknown']);

export function createPublicDatabase(options: PublicDatabaseOptions): PublicDatabase {
  assertUrlRole('public', options.connectionString);
  const pool = new pg.Pool({
    ...connectionConfig(options.connectionString, options.env),
    max: options.poolMax ?? 3,
    query_timeout: options.queryTimeoutMs ?? 3_000,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
  });
  // An idle client that loses its connection must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);

  return {
    async resolveHost(hostname) {
      const { rows } = await pool.query<{
        outcome: string;
        workspace_id: string | null;
        project_id: string | null;
        site_version_id: string | null;
      }>('SELECT outcome, workspace_id, project_id, site_version_id FROM app.resolve_host($1)', [hostname]);
      const row = rows[0];
      if (rows.length !== 1 || !row || !OUTCOMES.has(row.outcome)) {
        throw new Error('app.resolve_host returned an unexpected result');
      }
      if (row.outcome === 'unknown') return { outcome: 'unknown' };
      if (!row.workspace_id || !row.project_id) throw new Error('app.resolve_host returned no ids');
      if (row.outcome === 'live') {
        if (!row.site_version_id) throw new Error('app.resolve_host returned live without a version');
        return {
          outcome: 'live',
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          siteVersionId: row.site_version_id,
        };
      }
      return {
        outcome: row.outcome as 'placeholder' | 'maintenance',
        workspaceId: row.workspace_id,
        projectId: row.project_id,
      };
    },

    async getCatalogTemplate(templateId, version) {
      const { rows } = await pool.query<{
        template_id: string;
        slug: string;
        name: string;
        category: string;
        visibility: string;
        version: number;
        schema_version: string;
        config: unknown;
        manifest: unknown;
        content_hash: string;
      }>('SELECT * FROM app.get_catalog_template($1::uuid, $2::integer)', [templateId, version ?? null]);
      const row = rows[0];
      if (!row) return null;
      return {
        templateId: row.template_id,
        slug: row.slug,
        name: row.name,
        category: row.category,
        visibility: row.visibility,
        version: row.version,
        schemaVersion: row.schema_version,
        config: row.config,
        manifest: row.manifest,
        contentHash: row.content_hash,
      };
    },

    async isPreviewLinkRevoked(linkId) {
      const { rows } = await pool.query<{ revoked: boolean }>(
        'SELECT app.is_preview_link_revoked($1::uuid) AS revoked',
        [linkId],
      );
      return rows[0]?.revoked === true;
    },

    async previewLinkSender(linkId) {
      const { rows } = await pool.query<{ name: string | null }>(
        'SELECT app.preview_link_sender($1::uuid) AS name',
        [linkId],
      );
      return rows[0]?.name ?? null;
    },

    async getPublishedVersion(versionId) {
      const { rows } = await pool.query<{ config: unknown; assets: unknown; published_at: Date }>(
        'SELECT config, assets, published_at FROM app.get_published_version($1::uuid)',
        [versionId],
      );
      const row = rows[0];
      return row ? { config: row.config, assets: row.assets, publishedAt: row.published_at } : null;
    },

    async getStagingSite(linkId) {
      const { rows } = await pool.query<{
        status: string;
        site_version_id: string | null;
        config: unknown;
        assets: unknown;
        published_at: Date | null;
        sender: string | null;
      }>('SELECT * FROM app.get_staging_site($1::uuid)', [linkId]);
      const row = rows[0];
      if (rows.length !== 1 || !row || !STAGING_STATUSES.has(row.status)) {
        throw new Error('app.get_staging_site returned an unexpected result');
      }
      if (row.status === 'unknown') return { status: 'unknown' };
      if (row.status === 'ok') {
        if (!row.site_version_id || !row.published_at)
          throw new Error('app.get_staging_site returned no version');
        return {
          status: 'ok',
          siteVersionId: row.site_version_id,
          config: row.config,
          assets: row.assets,
          publishedAt: row.published_at,
          sender: row.sender,
        };
      }
      return { status: row.status as 'revoked' | 'expired' | 'unavailable', sender: row.sender };
    },

    async verifyRole() {
      const { rows } = await pool.query<{ usr: string; su: boolean; bypass: boolean }>(
        'SELECT current_user AS usr, rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
      );
      const row = rows[0];
      if (!row || row.usr !== 'app_public') {
        throw new UnsafeRoleError(
          `database connection must use role app_public, got ${row?.usr ?? 'unknown'}`,
        );
      }
      if (row.su || row.bypass) throw new UnsafeRoleError('app_public must not be SUPERUSER or BYPASSRLS');
    },

    close() {
      return pool.end();
    },
  };
}
