/**
 * Test-only entry point (`@platform/db/testing`), shared by this package's integration tests and the
 * cross-cutting isolation suite in `tests/isolation`. Application code must never import it: it carries the
 * local Docker connection strings and assertion helpers, nothing a request path needs.
 */
export { LOCAL_DATABASE_URLS } from './env';

/** Every SQLSTATE found on an error from `pg` or Prisma (driver-adapter errors nest it under meta/cause). */
export function sqlStates(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found: string[] = [];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = (error as Record<string, unknown>)[key];
    if (
      (key === 'code' || key === 'originalCode') &&
      typeof value === 'string' &&
      /^[0-9A-Z]{5}$/.test(value)
    ) {
      found.push(value);
    } else if (typeof value === 'string') {
      for (const m of value.matchAll(/\b(?:Code: `|code: |SQLSTATE )([0-9A-Z]{5})\b/g))
        found.push(m[1] as string);
    } else if (value && typeof value === 'object') {
      found.push(...sqlStates(value, seen));
    }
  }
  return found;
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const states = sqlStates(error);
    if (states.includes(code)) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`expected SQLSTATE ${code}, got [${states.join(', ')}]: ${message}`, { cause: error });
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}

/** The part of a `pg.Pool` the fixtures below use. */
interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A live Better Auth session row for `userId` (written as app_auth, like Better Auth itself). */
export async function createSessionRow(
  auth: Queryable,
  userId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const id = crypto.randomUUID();
  await auth.query(
    `INSERT INTO identity.sessions (id, user_id, token, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), now(), now())`,
    [id, userId, `test-${crypto.randomUUID()}`, expiresInSeconds],
  );
  return id;
}

/**
 * P1 S8 fixture: a platform admin (granted through the operator function, as migrator) with TOTP enrolled, a live
 * session and a verified console step-up, so `app_admin` functions accept `{ userId, sessionId }`.
 */
export async function steppedUpAdmin(pools: {
  auth: Queryable;
  migrator: Queryable;
  admin: Queryable;
}): Promise<{ userId: string; sessionId: string }> {
  const userId = crypto.randomUUID();
  await pools.auth.query(
    `INSERT INTO identity.users (id, name, email, email_verified, two_factor_enabled)
     VALUES ($1, 'Test Admin', $2, true, true)`,
    [userId, `admin-${userId}@example.test`],
  );
  await pools.migrator.query('SELECT app.operator_grant_platform_admin($1, $2)', [userId, 'test admin']);
  const sessionId = await createSessionRow(pools.auth, userId);
  await stepUp(pools.admin, { userId, sessionId });
  return { userId, sessionId };
}

/** Records a verified console step-up for an admin session (the code check itself is the dashboard's). */
export async function stepUp(admin: Queryable, p: { userId: string; sessionId: string }): Promise<void> {
  const { rows } = await admin.query('SELECT app.admin_step_up_begin($1, $2, $3) AS id', [
    p.userId,
    p.sessionId,
    'test-step-up',
  ]);
  await admin.query('SELECT app.admin_step_up_finish($1, $2, $3, true, $4)', [
    p.userId,
    p.sessionId,
    rows[0]!.id,
    'test-step-up',
  ]);
}
