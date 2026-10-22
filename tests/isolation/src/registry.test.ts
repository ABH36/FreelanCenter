/**
 * Registry completeness (SEC-02). Fails when a migration adds a relation that is not classified in factories.ts,
 * when a tenant table breaks the structural pattern of SRS 5.3, or when a declared expectation disagrees with the
 * grants in the catalog. The behavioural matrix only covers what is registered, so this file is what makes the
 * suite exhaustive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appForeignKeys, productRelations, type Relation } from './catalog';
import { NON_TENANT_RELATIONS, TABLE_NAMES, spec } from './factories';
import { expectPgError, pool, urls } from './fixtures';

let admin: pg.Pool;
let rawApp: pg.Pool;
let relations: Relation[];

beforeAll(async () => {
  admin = pool(urls.bootstrap, 2);
  rawApp = pool(urls.app, 2);
  relations = await productRelations(admin);
});
afterAll(async () => {
  await Promise.all([admin.end(), rawApp.end()]);
});

const registered = () => new Set(TABLE_NAMES.map((t) => `app.${t}`));

describe('every product relation is classified', () => {
  it('discovers the product schemas (guards against a vacuous pass)', () => {
    expect(relations.length).toBeGreaterThanOrEqual(TABLE_NAMES.length + 8);
    expect(new Set(relations.map((r) => r.schema))).toEqual(new Set(['app', 'identity']));
  });

  it('each relation is either a registered tenant table or a listed non-tenant relation, never both', () => {
    const tenant = registered();
    const unclassified = relations
      .map((r) => r.qualified)
      .filter((q) => !tenant.has(q) && !(q in NON_TENANT_RELATIONS));
    expect(unclassified, 'add a factory to TENANT_TABLES or a reason to NON_TENANT_RELATIONS').toEqual([]);
    expect([...tenant].filter((q) => q in NON_TENANT_RELATIONS)).toEqual([]);
  });

  it('every relation with a workspace_id column has a row factory', () => {
    const tenant = registered();
    const missing = relations
      .filter((r) => r.hasWorkspaceId && !tenant.has(r.qualified))
      .map((r) => r.qualified);
    expect(missing).toEqual([]);
  });

  it('the registries list no relation that does not exist (no stale entries)', () => {
    const existing = new Set(relations.map((r) => r.qualified));
    expect([...registered(), ...Object.keys(NON_TENANT_RELATIONS)].filter((q) => !existing.has(q))).toEqual(
      [],
    );
  });
});

describe('tenant tables follow the SRS 5.3 structure', () => {
  it('are ordinary tables in schema app with ENABLE and FORCE row-level security', async () => {
    const { rows } = await admin.query<{ relname: string; kind: string; rls: boolean; force: boolean }>(
      `SELECT c.relname, c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY 1`,
      [TABLE_NAMES],
    );
    expect(rows.map((r) => r.relname)).toEqual([...TABLE_NAMES].sort());
    for (const r of rows) expect([r.relname, r.kind, r.rls, r.force]).toEqual([r.relname, 'r', true, true]);
  });

  it('carry a NOT NULL workspace_id (the root keys on id; only audit_logs allows platform rows)', () => {
    for (const table of TABLE_NAMES) {
      const relation = relations.find((r) => r.qualified === `app.${table}`)!;
      if (spec(table).tenantKey === 'id') {
        expect([table, relation.hasWorkspaceId]).toEqual([table, false]);
        continue;
      }
      expect([table, relation.hasWorkspaceId, relation.workspaceIdNullable]).toEqual([
        table,
        true,
        spec(table).nullableTenantKey === true,
      ]);
    }
  });

  it('every foreign key between tenant tables is composite on workspace_id (SRS 5.3 item 4)', async () => {
    const tenant = new Set<string>(TABLE_NAMES);
    const fks = await appForeignKeys(admin);
    expect(fks.length).toBeGreaterThan(5);
    for (const fk of fks) {
      if (fk.parentSchema !== 'app' || !tenant.has(fk.parent) || !tenant.has(fk.child)) continue;
      if (fk.parent === 'workspaces') {
        // The root reference itself: workspace_id -> workspaces.id.
        expect([fk.name, fk.childColumns, fk.parentColumns]).toEqual([fk.name, ['workspace_id'], ['id']]);
        continue;
      }
      const at = fk.childColumns.indexOf('workspace_id');
      expect([fk.name, at >= 0 && fk.parentColumns[at] === 'workspace_id']).toEqual([fk.name, true]);
    }
  });

  it('declared UPDATE / DELETE expectations match app_user grants', async () => {
    for (const table of TABLE_NAMES) {
      const { rows } = await admin.query<{ upd: boolean; del: boolean; tenant_key_upd: boolean }>(
        `SELECT has_any_column_privilege('app_user', c.oid, 'UPDATE') AS upd,
                has_table_privilege('app_user', c.oid, 'DELETE') AS del,
                has_column_privilege('app_user', c.oid, $2, 'UPDATE') AS tenant_key_upd
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = $1`,
        [table, spec(table).tenantKey],
      );
      const s = spec(table);
      expect([table, rows[0]]).toEqual([
        table,
        { upd: s.update !== 'denied', del: s.delete === 'allowed', tenant_key_upd: false },
      ]);
    }
  });
});

describe('non-tenant relations are unreachable for app_user', () => {
  it('SELECT on each is denied (42501): a privilege error, independent of any context', async () => {
    for (const qualified of Object.keys(NON_TENANT_RELATIONS)) {
      const [schema, name] = qualified.split('.');
      await expectPgError(rawApp.query(`SELECT 1 FROM "${schema}"."${name}" LIMIT 1`), '42501');
    }
  });
});
