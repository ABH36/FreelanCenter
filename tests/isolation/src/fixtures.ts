/**
 * Connections and seeding for the isolation suite. Every tenant query runs as `app_user` through PgBouncer in
 * transaction mode, exactly as the dashboard will. `platform_admin` (the local stand-in for Supabase's operator
 * role) is used for catalog inspection only: it holds no privilege on product tables.
 */
import pg from 'pg';
import { createTenantDatabase, uuidv7, type TenantDatabase, type TenantScope, type Tx } from '@platform/db';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { TENANT_TABLES, type FactoryContext, type TableName } from './factories';

export { expectPgError, sqlStates } from '@platform/db/testing';
export const urls = LOCAL_DATABASE_URLS;

export function pool(url: string, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

export function tenantDb(): TenantDatabase {
  return createTenantDatabase({ connectionString: urls.app, poolMax: 8 });
}

let counter = 0;
/** Unique, slug- and hostname-safe token; the suite reruns on a non-fresh database. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${counter}`;
}

/** Better Auth's role creates users; nothing else can. */
export async function createUser(auth: pg.Pool): Promise<string> {
  const id = uuidv7();
  await auth.query(
    `INSERT INTO identity.users (id, name, email, email_verified) VALUES ($1, 'Isolation User', $2, true)`,
    [id, `iso-${id}@example.test`],
  );
  return id;
}

export interface Tenant {
  scope: TenantScope;
  ownerId: string;
  /** One row per registered tenant table, created by that table's factory. */
  rows: Record<TableName, string>;
  ctx: FactoryContext;
}

export function factoryContext(auth: pg.Pool, workspaceId: string, ownerId: string): FactoryContext {
  return { workspaceId, ownerId, unique, createUser: () => createUser(auth) };
}

/** A workspace with its owner membership and one row in every registered tenant table. */
export async function seedTenant(db: TenantDatabase, auth: pg.Pool): Promise<Tenant> {
  const ownerId = await createUser(auth);
  return db.withNewWorkspace(ownerId, async (tx, scope) => {
    const ctx = factoryContext(auth, scope.workspaceId, ownerId);
    const rows = {} as Record<TableName, string>;
    // The workspace and the owner membership come first: every other factory depends on them.
    rows.workspaces = await create(tx, 'workspaces', ctx);
    await tx.membership.create({ data: { workspaceId: scope.workspaceId, userId: ownerId, role: 'owner' } });
    for (const table of Object.keys(TENANT_TABLES) as TableName[]) {
      if (table !== 'workspaces') rows[table] = await create(tx, table, ctx);
    }
    return { scope, ownerId, rows, ctx };
  });
}

/** prepare + insert in the caller's transaction. */
export async function create(tx: Tx, table: TableName, ctx: FactoryContext): Promise<string> {
  const spec = TENANT_TABLES[table];
  return spec.insert(tx, ctx, await spec.prepare(tx, ctx));
}

export interface World {
  db: TenantDatabase;
  /** Catalog inspection only. */
  admin: pg.Pool;
  auth: pg.Pool;
  /** app_user with no context at all (no transaction, no set_config). */
  rawApp: pg.Pool;
  A: Tenant;
  B: Tenant;
  close(): Promise<void>;
}

/** Two fully seeded tenants: A is always the attacker, B the victim. */
export async function createWorld(): Promise<World> {
  const db = tenantDb();
  const admin = pool(urls.bootstrap, 2);
  const auth = pool(urls.auth, 2);
  const rawApp = pool(urls.app, 2);
  const A = await seedTenant(db, auth);
  const B = await seedTenant(db, auth);
  return {
    db,
    admin,
    auth,
    rawApp,
    A,
    B,
    close: async () => {
      await db.disconnect();
      await Promise.all([admin.end(), auth.end(), rawApp.end()]);
    },
  };
}

class Rollback extends Error {
  constructor(readonly result: unknown) {
    super('rollback');
  }
}

/** Runs fn in a tenant transaction and rolls it back, so probes that touch the attacker's own rows leave no trace. */
export async function inRollback<T>(
  db: TenantDatabase,
  scope: TenantScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    await db.withTenant(scope, async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as T;
    throw error;
  }
  throw new Error('unreachable');
}

/**
 * md5 of the whole row, read by its own workspace. Used to prove a cross-tenant statement changed nothing,
 * independently of what the attacking statement reported.
 */
export async function fingerprint(db: TenantDatabase, owner: Tenant, table: TableName): Promise<string> {
  const rows = await db.withTenant(owner.scope, (tx) =>
    tx.$queryRawUnsafe<Array<{ md5: string }>>(
      `SELECT md5(row_to_json(t)::text) AS md5 FROM app.${table} t WHERE t.id = $1::uuid`,
      owner.rows[table],
    ),
  );
  if (rows.length !== 1) throw new Error(`${table}: owner cannot read its own seeded row`);
  return rows[0]!.md5;
}
