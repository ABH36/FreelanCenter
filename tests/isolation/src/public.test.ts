/**
 * The visitor role (SRS 5.3 item 1; P1 S7). `app_public` is what apps/sites holds for anonymous visitors: no
 * privilege on any product relation, EXECUTE on exactly one function, `app.resolve_host`, which answers for one
 * exact host name with an outcome and the owning ids (kept server-side by apps/sites) and ignores any context the
 * caller sets. Every relation is discovered from the catalog, so a later table cannot be forgotten here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { productRelations } from './catalog';
import { createWorld, expectPgError, pool, urls, type World } from './fixtures';

let w: World;
let visitor: pg.Pool;
let hostA: string;

beforeAll(async () => {
  w = await createWorld();
  visitor = pool(urls.public, 2);
  hostA = await w.db.withTenant(w.A.scope, async (tx) => {
    const d = await tx.domain.findUniqueOrThrow({
      where: { id: w.A.rows.domains },
      select: { hostname: true },
    });
    return d.hostname;
  });
});
afterAll(async () => {
  await visitor.end();
  await w.close();
});

describe('visitor role app_public', () => {
  it('app_public can read or write no product relation (tenant or not), by privilege', async () => {
    const relations = await productRelations(w.admin);
    expect(relations.length).toBeGreaterThan(10);
    const { rows } = await w.admin.query<{ rel: string }>(
      `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname || '.' || c.relname = ANY($1)
          AND (has_table_privilege('app_public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               OR has_any_column_privilege('app_public', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`,
      [relations.map((r) => r.qualified)],
    );
    expect(rows).toEqual([]);
    for (const r of relations) {
      await expectPgError(visitor.query(`SELECT 1 FROM "${r.schema}"."${r.name}" LIMIT 1`), '42501');
    }
  });

  it('app_public executes exactly app.resolve_host, which returns only (outcome, workspace_id, project_id)', async () => {
    const { rows } = await w.admin.query<{ fn: string; result: string }>(
      `SELECT n.nspname || '.' || p.proname AS fn, pg_get_function_result(p.oid) AS result
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'identity') AND has_function_privilege('app_public', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([
      { fn: 'app.resolve_host', result: 'TABLE(outcome text, workspace_id uuid, project_id uuid)' },
    ]);
  });

  it('answers for an exact host name only; patterns and neighbours of a tenant host are unknown', async () => {
    const answer = await visitor.query('SELECT outcome, workspace_id FROM app.resolve_host($1)', [hostA]);
    expect(answer.rows).toEqual([{ outcome: 'placeholder', workspace_id: w.A.scope.workspaceId }]);
    const suffix = hostA.slice(hostA.indexOf('.'));
    for (const probe of [`%${suffix}`, `_${hostA.slice(1)}`, `${hostA}%`, suffix.slice(1), `*${suffix}`]) {
      const { rows } = await visitor.query('SELECT outcome FROM app.resolve_host($1)', [probe]);
      expect([probe, rows]).toEqual([probe, [{ outcome: 'unknown' }]]);
    }
  });

  it("a context the caller sets (B's workspace and user) changes nothing: the answer depends on the host only", async () => {
    const client = await visitor.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
        [w.B.scope.workspaceId, w.B.ownerId],
      );
      const { rows } = await client.query('SELECT outcome, workspace_id FROM app.resolve_host($1)', [hostA]);
      expect(rows).toEqual([{ outcome: 'placeholder', workspace_id: w.A.scope.workspaceId }]);
      await expectPgError(client.query('SELECT 1 FROM app.projects LIMIT 1'), '42501');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
