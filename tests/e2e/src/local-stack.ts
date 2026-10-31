/**
 * Direct database access for the E2E suite. Every connection is a local trust-auth login role on 127.0.0.1; the
 * check below is the guard that keeps this suite away from any live database.
 */
import pg from 'pg';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';

export function assertLocalStack(): void {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_AUTH', 'DIRECT_URL'] as const) {
    const value = process.env[key];
    if (value && !/@(127\.0\.0\.1|localhost):/.test(value)) {
      throw new Error(
        `${key} is set to a non-local database; the E2E suite only runs against the Docker stack`,
      );
    }
  }
}

export function pool(url: string): pg.Pool {
  assertLocalStack();
  return new pg.Pool({ connectionString: url, max: 2 });
}

export const authPool = (): pg.Pool => pool(LOCAL_DATABASE_URLS.auth);
export const appPool = (): pg.Pool => pool(LOCAL_DATABASE_URLS.app);

export async function userIdByEmail(auth: pg.Pool, email: string): Promise<string> {
  const { rows } = await auth.query<{ id: string }>('SELECT id FROM identity.users WHERE email = $1', [
    email,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error('user not found');
  return id;
}

/** Runs `fn` in one app_user transaction with the same transaction-local context the product sets (SEC-01). */
export async function asTenant<T>(
  app: pg.Pool,
  workspaceId: string,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`,
      [workspaceId, userId],
    );
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
