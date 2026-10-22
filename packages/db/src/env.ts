/**
 * Database targets and connection-string conventions for @platform/db.
 * Self-contained (no imports) so the Node scripts in `scripts/` can load it with native type stripping.
 *
 * One connection string per database role (SRS 5.3, ADR-003, ADR-006):
 *   DATABASE_BOOTSTRAP_URL  operator role (Supabase `postgres`): creates roles only; never deployed to an app
 *   DIRECT_URL              migrator: owns the schema, runs migrations; never deployed to an app
 *   DATABASE_URL            app_user: tenant queries under RLS (pooled, transaction mode)
 *   DATABASE_URL_AUTH       app_auth: Better Auth, `identity` schema only (pooled)
 *   DATABASE_URL_PUBLIC     app_public: visitor paths, SECURITY DEFINER functions only (pooled)
 *   DATABASE_URL_ADMIN      app_admin: platform-admin functions only (pooled)
 */

export type DbTarget = 'local' | 'env';
export type DbUrlKey = 'bootstrap' | 'migrator' | 'shadow' | 'app' | 'auth' | 'public' | 'admin';
export type RuntimeRoleKey = 'migrator' | 'app' | 'auth' | 'public' | 'admin';

export const ENV_KEYS: Record<DbUrlKey, string> = {
  bootstrap: 'DATABASE_BOOTSTRAP_URL',
  migrator: 'DIRECT_URL',
  shadow: 'SHADOW_DATABASE_URL',
  app: 'DATABASE_URL',
  auth: 'DATABASE_URL_AUTH',
  public: 'DATABASE_URL_PUBLIC',
  admin: 'DATABASE_URL_ADMIN',
};

/** The login role each connection string must authenticate as. A mismatch is a configuration error. */
export const EXPECTED_ROLES: Record<RuntimeRoleKey, string> = {
  migrator: 'migrator',
  app: 'app_user',
  auth: 'app_auth',
  public: 'app_public',
  admin: 'app_admin',
};

/** NOLOGIN owner of SECURITY DEFINER functions (Spike B B-6/B-7). */
export const DEFINER_ROLE = 'svc_definer';

/** Local Docker stack (`docker/compose.yml`): trust auth on 127.0.0.1, so no secrets live in the repository. */
export const LOCAL_DATABASE_URLS = {
  bootstrap: 'postgresql://platform_admin@127.0.0.1:55440/platform',
  migrator: 'postgresql://migrator@127.0.0.1:55440/platform',
  shadow: 'postgresql://migrator@127.0.0.1:55440/platform_shadow',
  app: 'postgresql://app_user@127.0.0.1:56440/platform',
  auth: 'postgresql://app_auth@127.0.0.1:56440/platform',
  public: 'postgresql://app_public@127.0.0.1:56440/platform',
  admin: 'postgresql://app_admin@127.0.0.1:56440/platform',
  /** Same role through a one-connection pool: the session-level SET leak test needs guaranteed reuse. */
  appSinglePool: 'postgresql://app_user@127.0.0.1:56440/platform_p1',
} as const satisfies Record<DbUrlKey | 'appSinglePool', string>;

/** Minimal `.env` parser: KEY=VALUE lines, optional matching quotes, `#` comments. */
export function parseDotEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1] as string] = value;
  }
  return values;
}

/**
 * Login role of a connection string. Supabase's shared pooler routes on `role.<project-ref>`
 * (Spike B live run), so everything from the first dot is the routing suffix, not the role.
 */
export function roleOf(connectionString: string): string {
  const user = decodeURIComponent(new URL(connectionString).username);
  const dot = user.indexOf('.');
  return dot === -1 ? user : user.slice(0, dot);
}

export function passwordOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).password);
}

export function isLocalHost(connectionString: string): boolean {
  const host = new URL(connectionString).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/** Resolve one URL for a target. `env` never falls back to local values, so a missing key fails loudly. */
export function resolveDatabaseUrl(
  key: DbUrlKey,
  target: DbTarget,
  env: Record<string, string | undefined>,
): string {
  if (target === 'local') return LOCAL_DATABASE_URLS[key];
  const value = env[ENV_KEYS[key]];
  if (!value) throw new Error(`${ENV_KEYS[key]} is not set`);
  return value;
}

/** Throws unless the URL authenticates as the role that `key` requires. Never echoes the URL. */
export function assertUrlRole(key: RuntimeRoleKey, connectionString: string): void {
  const actual = roleOf(connectionString);
  if (actual !== EXPECTED_ROLES[key]) {
    throw new Error(`${ENV_KEYS[key]} must authenticate as ${EXPECTED_ROLES[key]}, found ${actual}`);
  }
}
