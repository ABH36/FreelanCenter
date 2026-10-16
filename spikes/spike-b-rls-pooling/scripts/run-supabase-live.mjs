/**
 * Live Phase-1 Task 0 proof for Supabase's transaction pooler.
 *
 * This is disposable Spike-B evidence, never product code. It creates two
 * temporary LOGIN roles and the public tables required by the generated Prisma
 * client in the configured scratch project. It refuses to start if those names
 * already exist, runs the RLS negative-leak suite through DATABASE_URL, then
 * drops only its exact objects in finally.
 * It intentionally never logs connection strings or generated passwords.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import pg from 'pg';

const { Client, Pool } = pg;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function loadLocalEnv() {
  const raw = fs.readFileSync('../../.env.local', 'utf8');
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    if (!values[key]) throw new Error(`${key} is missing from .env.local`);
  }
  return values;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const env = loadLocalEnv();
const suffix = crypto.randomBytes(6).toString('hex');
// Prisma's generated models map to the `public` schema. A dynamic search_path
// does not change that mapping, so the live Prisma proof must use public tables.
// Preflight below guarantees this scratch project has no colliding objects.
const schema = 'public';
const appRole = `spike_b_app_${suffix}`;
const readerRole = `spike_b_reader_${suffix}`;
const password = crypto.randomBytes(32).toString('base64url');
const appUrl = new URL(env.DATABASE_URL);
const poolerUser = decodeURIComponent(appUrl.username);
const projectRef = poolerUser.includes('.') ? poolerUser.slice(poolerUser.indexOf('.')) : '';
assert(
  projectRef,
  'DATABASE_URL username must include the Supabase project identifier for the shared pooler',
);
appUrl.username = `${appRole}${projectRef}`;
appUrl.password = password;
const directAppUrl = new URL(env.DIRECT_URL);
const directUser = decodeURIComponent(directAppUrl.username);
directAppUrl.username = `${appRole}${directUser.includes('.') ? directUser.slice(directUser.indexOf('.')) : ''}`;
directAppUrl.password = password;

const evidence = {
  executedAt: new Date().toISOString(),
  schema,
  pooledHost: appUrl.hostname,
  pooledPort: appUrl.port || '5432',
  checks: {},
};

let admin;
let pool;

async function asWorkspace(workspaceId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function noContextCount() {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.project`);
  return result.rows[0].count;
}

async function setup() {
  admin = new Client({ connectionString: env.DIRECT_URL, connectionTimeoutMillis: 15_000 });
  await admin.connect();
  const collisions = await admin.query(
    `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('workspace', 'project')
     UNION ALL
     SELECT p.proname FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'current_workspace'`,
  );
  assert(
    collisions.rows.length === 0,
    `refusing live Prisma proof: public names already exist (${collisions.rows.map((row) => row.relname ?? row.proname).join(', ')})`,
  );
  await admin.query(
    `CREATE ROLE ${appRole} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  await admin.query(`CREATE ROLE ${readerRole} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}, ${readerRole}`);
  await admin.query(`CREATE TABLE ${schema}.workspace (id uuid PRIMARY KEY, name text NOT NULL)`);
  await admin.query(
    `CREATE TABLE ${schema}.project (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES ${schema}.workspace(id),
      name text NOT NULL,
      UNIQUE (workspace_id, id)
    )`,
  );
  await admin.query(`CREATE FUNCTION ${schema}.current_workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
  $$`);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${schema}.current_workspace() TO ${appRole}`);
  for (const table of ['workspace', 'project']) {
    await admin.query(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  }
  await admin.query(`CREATE POLICY workspace_isolation ON ${schema}.workspace FOR ALL TO ${appRole}
    USING (id = ${schema}.current_workspace()) WITH CHECK (id = ${schema}.current_workspace())`);
  await admin.query(`CREATE POLICY project_isolation ON ${schema}.project FOR ALL TO ${appRole}
    USING (workspace_id = ${schema}.current_workspace()) WITH CHECK (workspace_id = ${schema}.current_workspace())`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.workspace, ${schema}.project TO ${appRole}`,
  );
  await admin.query(`INSERT INTO ${schema}.workspace (id, name) VALUES ($1, 'A'), ($2, 'B')`, [A, B]);
  await admin.query(
    `INSERT INTO ${schema}.project (id, workspace_id, name) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, 'A-1'),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, 'A-2'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $2, 'B-1')`,
    [A, B],
  );
  pool = new Pool({ connectionString: appUrl.toString(), max: 20, connectionTimeoutMillis: 15_000 });
}

async function run() {
  const identity = await admin.query(
    `SELECT current_setting('server_version') AS version, current_user AS current_user`,
  );
  evidence.server = identity.rows[0];

  const roles = await admin.query(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ($1, $2) ORDER BY rolname`,
    [appRole, readerRole],
  );
  assert(
    roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls),
    'test roles have elevated privileges',
  );
  const tables = await admin.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relnamespace = $1::regnamespace AND relkind = 'r' ORDER BY relname`,
    [schema],
  );
  assert(
    tables.rows.every((table) => table.relrowsecurity && table.relforcerowsecurity),
    'RLS is not forced',
  );
  evidence.checks.rolesAndForcedRls = { roles: roles.rows, tables: tables.rows };

  const noContext = [];
  for (let i = 0; i < 30; i += 1) {
    await asWorkspace(i % 2 ? A : B, async (client) =>
      client.query(`SELECT count(*) FROM ${schema}.project`),
    );
    noContext.push(await noContextCount());
  }
  assert(
    noContext.every((count) => count === 0),
    'no-context request read tenant data after pool reuse',
  );
  evidence.checks.noContextAfterReuse = noContext;

  const counts = await Promise.all(
    [A, B].map((workspaceId) =>
      asWorkspace(workspaceId, async (client) => {
        const result = await client.query(`SELECT workspace_id FROM ${schema}.project ORDER BY name`);
        assert(
          result.rows.every((row) => row.workspace_id === workspaceId),
          'cross-tenant row returned',
        );
        return result.rows.length;
      }),
    ),
  );
  assert(counts[0] === 2 && counts[1] === 1, 'tenant row counts unexpected');
  evidence.checks.scopedReads = { workspaceA: counts[0], workspaceB: counts[1] };

  let deniedWrite = false;
  try {
    await asWorkspace(A, async (client) =>
      client.query(`INSERT INTO ${schema}.project (id, workspace_id, name) VALUES ($1, $2, 'smuggled')`, [
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        B,
      ]),
    );
  } catch {
    deniedWrite = true;
  }
  assert(deniedWrite, 'cross-tenant insert was allowed');
  evidence.checks.crossTenantWriteDenied = true;

  const pinning = await asWorkspace(A, async (client) => {
    const first = await client.query(
      "SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id', true) AS workspace",
    );
    await client.query(`SELECT count(*) FROM ${schema}.project`);
    const second = await client.query(
      "SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id', true) AS workspace",
    );
    return { first: first.rows[0], second: second.rows[0] };
  });
  assert(pinning.first.pid === pinning.second.pid, 'interactive transaction was not pinned to one backend');
  assert(
    pinning.first.workspace === A && pinning.second.workspace === A,
    'transaction-local workspace context was lost',
  );
  evidence.checks.transactionPinning = pinning;

  let leaks = 0;
  let errors = 0;
  await Promise.all(
    Array.from({ length: 400 }, async (_, index) => {
      const workspaceId = index % 2 ? A : B;
      try {
        const rows = await asWorkspace(workspaceId, async (client) =>
          client.query(`SELECT workspace_id FROM ${schema}.project`),
        );
        const expected = workspaceId === A ? 2 : 1;
        if (rows.rows.length !== expected || rows.rows.some((row) => row.workspace_id !== workspaceId))
          leaks += 1;
      } catch {
        errors += 1;
      }
    }),
  );
  assert(leaks === 0 && errors === 0, `concurrency failure: leaks=${leaks}, errors=${errors}`);
  evidence.checks.concurrency = { operations: 400, leaks, errors };

  const prismaProof = spawnSync('pnpm exec vitest run test/supabase-live-prisma.test.ts', {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SPIKE_B_LIVE_APP_URL: appUrl.toString(),
      SPIKE_B_LIVE_SCHEMA: schema,
    },
    stdio: 'inherit',
    shell: true,
  });
  assert(
    prismaProof.status === 0,
    `Prisma proof failed: ${prismaProof.error?.message ?? `exit status ${prismaProof.status ?? 'unknown'}`}`,
  );
  evidence.checks.prismaAdapter = { tests: 3, result: 'PASS' };

  const pooledPool = pool;
  const directPool = new Pool({
    connectionString: directAppUrl.toString(),
    max: 10,
    connectionTimeoutMillis: 15_000,
  });
  pool = directPool;
  try {
    const directNoContext = [];
    for (let i = 0; i < 10; i += 1) {
      await asWorkspace(i % 2 ? A : B, async (client) =>
        client.query(`SELECT count(*) FROM ${schema}.project`),
      );
      directNoContext.push(await noContextCount());
    }
    assert(
      directNoContext.every((count) => count === 0),
      'direct URL no-context request read tenant data',
    );
    let directLeaks = 0;
    let directErrors = 0;
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const workspaceId = index % 2 ? A : B;
        try {
          const rows = await asWorkspace(workspaceId, async (client) =>
            client.query(`SELECT workspace_id FROM ${schema}.project`),
          );
          const expected = workspaceId === A ? 2 : 1;
          if (rows.rows.length !== expected || rows.rows.some((row) => row.workspace_id !== workspaceId)) {
            directLeaks += 1;
          }
        } catch {
          directErrors += 1;
        }
      }),
    );
    assert(
      directLeaks === 0 && directErrors === 0,
      `direct concurrency failure: leaks=${directLeaks}, errors=${directErrors}`,
    );
    evidence.checks.directUrl = {
      host: directAppUrl.hostname,
      port: directAppUrl.port || '5432',
      noContext: directNoContext,
      operations: 100,
      leaks: directLeaks,
      errors: directErrors,
    };
  } finally {
    await directPool.end();
    pool = pooledPool;
  }
}

async function cleanup() {
  if (pool) await pool.end().catch(() => undefined);
  if (admin) {
    await admin.query(`DROP TABLE IF EXISTS ${schema}.project`).catch(() => undefined);
    await admin.query(`DROP TABLE IF EXISTS ${schema}.workspace`).catch(() => undefined);
    await admin.query(`DROP FUNCTION IF EXISTS ${schema}.current_workspace()`).catch(() => undefined);
    await admin
      .query(`REVOKE USAGE ON SCHEMA ${schema} FROM ${appRole}, ${readerRole}`)
      .catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${readerRole}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

try {
  await setup();
  await run();
  evidence.result = 'PASS';
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  await cleanup();
}
