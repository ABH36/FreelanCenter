import { readFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';
import { LOCAL_DATABASE_URLS, assertUrlRole, parseDotEnv } from './src/env.ts';

// Migrations always run as `migrator` (never the Supabase operator role, which has BYPASSRLS).
// DB_TARGET=env reads DIRECT_URL / SHADOW_DATABASE_URL from the environment or the repository .env.local;
// anything else uses the local Docker stack. `prisma generate` needs no database.
const target = process.env.DB_TARGET === 'env' ? 'env' : 'local';
const envFile = new URL('../../.env.local', import.meta.url);
const env =
  target === 'env'
    ? { ...(existsSync(envFile) ? parseDotEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env }
    : {};

const migratorUrl = target === 'env' ? env.DIRECT_URL : LOCAL_DATABASE_URLS.migrator;
const shadowUrl = target === 'env' ? env.SHADOW_DATABASE_URL : LOCAL_DATABASE_URLS.shadow;
if (migratorUrl) assertUrlRole('migrator', migratorUrl);

/** Prisma keeps its `_prisma_migrations` table in the connection's default schema; keep it out of `public`. */
function withAppSchema(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.searchParams.set('schema', 'app');
  return parsed.toString();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: withAppSchema(migratorUrl) ?? '',
    shadowDatabaseUrl: withAppSchema(shadowUrl),
  },
});
