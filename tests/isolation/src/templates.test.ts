/**
 * Template ownership and the catalogue boundary (P2 S5b; SRS 5.3 items 1-3, ADR-004). The generic matrix proves that
 * tenants cannot touch each other's rows; this file proves what is specific to templates: a tenant can never create
 * a platform or marketplace template (nor one without an owner), and no application role can execute the operator
 * functions that write platform built-ins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, expectPgError, type World } from './fixtures';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

const insert = (workspaceId: string | null, visibility: string) => async () => {
  const ws = workspaceId === null ? null : workspaceId;
  await w.db.withTenant(w.A.scope, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO app.templates (workspace_id, slug, name, category, description, status, visibility)
       VALUES ($1::uuid, $2, 'Probe', 'generic', 'Probe template', 'draft', $3::app.template_visibility)`,
      ws,
      `probe-${Math.random().toString(36).slice(2, 12)}`,
      visibility,
    ),
  );
};

describe('templates: what a tenant may create', () => {
  it('positive control: a private template in its own workspace', async () => {
    await expect(insert(w.A.scope.workspaceId, 'private')()).resolves.toBeUndefined();
  });

  it('platform and marketplace templates, and templates without an owner, are refused (42501)', async () => {
    for (const [owner, visibility] of [
      [w.A.scope.workspaceId, 'platform'],
      [w.A.scope.workspaceId, 'marketplace'],
      [null, 'platform'],
      [null, 'private'],
      [w.B.scope.workspaceId, 'private'],
    ] as const) {
      await expectPgError(insert(owner, visibility)(), '42501');
    }
  });

  it('a tenant cannot change what a template is: owner, visibility and slug are outside its UPDATE grant', async () => {
    for (const column of ['workspace_id', 'visibility', 'slug']) {
      await expectPgError(
        w.db.withTenant(w.A.scope, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE app.templates SET ${column} = ${column} WHERE id = $1::uuid`,
            w.A.rows.templates,
          ),
        ),
        '42501',
      );
    }
  });
});

describe('operator functions', () => {
  it('no application role can execute the functions that write platform templates', async () => {
    const { rows } = await w.admin.query<{ role: string; fn: string }>(
      `SELECT r.rolname AS role, p.proname AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN pg_roles r
        WHERE n.nspname = 'app' AND p.proname LIKE 'operator%template%'
          AND r.rolname IN ('app_user', 'app_auth', 'app_public', 'app_admin')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });

  it('the catalogue functions are read-only: they cannot be used to read a private template of another workspace', async () => {
    const rows = await w.db.withTenant(w.A.scope, (tx) =>
      tx.$queryRawUnsafe<{ template_id: string }[]>(`SELECT template_id FROM app.list_catalog_templates()`),
    );
    const ids = new Set(rows.map((r) => r.template_id));
    expect(ids.has(w.B.rows.templates!)).toBe(false);
    expect(ids.has(w.A.rows.templates!)).toBe(false);
  });
});
