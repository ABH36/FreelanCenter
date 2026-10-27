/**
 * The `app_public` client for visitor paths in apps/sites (SRS 4.3, 5.3 item 1). Exported as
 * `@platform/db/public` so the sites app loads neither Prisma nor the tenant client. app_public holds no table
 * privilege; it can only call the SECURITY DEFINER functions granted to it, today `app.resolve_host`.
 * No tenant context is ever set on this pool: the functions do not read one.
 */
import pg from 'pg';
import { connectionConfig } from './connection';
import { assertUrlRole } from './env';
import { UnsafeRoleError } from './errors';

export type HostOutcome = 'placeholder' | 'maintenance' | 'unknown';

/** What a host may show. The ids are internal (cache bookkeeping, logs); never send them to a browser. */
export type HostRow =
  { outcome: 'placeholder' | 'maintenance'; workspaceId: string; projectId: string } | { outcome: 'unknown' };

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
  /** Fails unless the connection role is app_public without SUPERUSER or BYPASSRLS. */
  verifyRole(): Promise<void>;
  close(): Promise<void>;
}

const OUTCOMES = new Set<string>(['placeholder', 'maintenance', 'unknown']);

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
      }>('SELECT outcome, workspace_id, project_id FROM app.resolve_host($1)', [hostname]);
      const row = rows[0];
      if (rows.length !== 1 || !row || !OUTCOMES.has(row.outcome)) {
        throw new Error('app.resolve_host returned an unexpected result');
      }
      if (row.outcome === 'unknown') return { outcome: 'unknown' };
      if (!row.workspace_id || !row.project_id) throw new Error('app.resolve_host returned no ids');
      return {
        outcome: row.outcome as 'placeholder' | 'maintenance',
        workspaceId: row.workspace_id,
        projectId: row.project_id,
      };
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
