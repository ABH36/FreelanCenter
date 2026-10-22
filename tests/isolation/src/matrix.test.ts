/**
 * Cross-tenant matrix (SRS 5.3 item 5, SEC-01, SEC-02). For every registered tenant table, workspace A attacks
 * workspace B's row with SELECT, INSERT, UPDATE, DELETE, RETURNING, writable CTEs and joins, plus the no-context
 * and actor-only cases. Every check runs as app_user through PgBouncer in transaction mode. Each "nothing
 * happened" result is backed by a positive control that the same statement does work on A's own row, and by a
 * fingerprint of B's row taken by B itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appForeignKeys, type ForeignKey } from './catalog';
import { TABLE_NAMES, TENANT_TABLES, spec, type TableName } from './factories';
import { createWorld, expectPgError, fingerprint, inRollback, type World } from './fixtures';

let w: World;
let fks: ForeignKey[];

beforeAll(async () => {
  w = await createWorld();
  fks = await appForeignKeys(w.admin);
});
afterAll(async () => {
  await w.close();
});

type Counts = Array<Record<string, number | boolean>>;

function expectConfined(result: { own: number; affected: number }): void {
  expect(result.affected, 'the blind write must reach A rows (positive control)').toBeGreaterThan(0);
  expect(result.affected, 'the blind write reached rows A cannot see').toBeLessThanOrEqual(result.own);
}

describe.each(TABLE_NAMES)('app.%s', (table: TableName) => {
  const s = spec(table);
  const key = s.tenantKey;
  const rel = `app.${table}`;
  const victimId = () => w.B.rows[table];
  const ownId = () => w.A.rows[table];

  /**
   * An UPDATE or DELETE that reads no column (no WHERE, no RETURNING, constant SET) is checked against the
   * UPDATE/DELETE policies only; PostgreSQL adds the SELECT policies only when the statement reads columns. So a
   * too-permissive write policy is invisible to every filtered probe and shows up only here: the statement must
   * affect no more rows than A can see. Rolled back.
   */
  const blindWrite = (sql: string) =>
    inRollback(w.db, w.A.scope, async (tx) => {
      const visible = await tx.$queryRawUnsafe<Counts>(`SELECT count(*)::int AS n FROM ${rel}`);
      const affected = await tx.$executeRawUnsafe(sql);
      return { own: Number(visible[0]?.n), affected };
    });

  it('positive control: A reads its own row', async () => {
    const rows = await w.db.withTenant(w.A.scope, (tx) =>
      tx.$queryRawUnsafe<Counts>(`SELECT count(*)::int AS n FROM ${rel} WHERE id = $1::uuid`, ownId()),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('SELECT: B row is invisible by id, by tenant key, via EXISTS, IN and aggregates', async () => {
    const rows = await w.db.withTenant(w.A.scope, (tx) =>
      tx.$queryRawUnsafe<Counts>(
        `SELECT (SELECT count(*)::int FROM ${rel} WHERE id = $1::uuid) AS by_id,
                (SELECT count(*)::int FROM ${rel} WHERE ${key} = $2::uuid) AS by_key,
                EXISTS (SELECT 1 FROM ${rel} WHERE id = $1::uuid) AS by_exists,
                (SELECT count(*)::int FROM ${rel} WHERE id IN ($1::uuid, $3::uuid)) AS by_in,
                (SELECT count(DISTINCT ${key})::int FROM ${rel}) AS tenants_visible`,
        victimId(),
        w.B.scope.workspaceId,
        ownId(),
      ),
    );
    expect(rows[0]).toEqual({ by_id: 0, by_key: 0, by_exists: false, by_in: 1, tenants_visible: 1 });
  });

  it('SELECT: every row visible to A belongs to A (including rows left by earlier runs)', async () => {
    const rows = await w.db.withTenant(w.A.scope, (tx) =>
      tx.$queryRawUnsafe<Counts>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${key} IS DISTINCT FROM $1::uuid)::int AS foreign
           FROM ${rel}`,
        w.A.scope.workspaceId,
      ),
    );
    expect(rows[0]?.foreign).toBe(0);
    expect(rows[0]?.total).toBeGreaterThan(0);
  });

  it('JOIN: through the workspace root, LATERAL and an outer join, nothing of B is reached', async () => {
    const rows = await w.db.withTenant(w.A.scope, (tx) =>
      tx.$queryRawUnsafe<Counts>(
        `SELECT (SELECT count(*)::int FROM app.workspaces ws JOIN ${rel} t ON t.${key} = ws.id
                  WHERE ws.id = $1::uuid) AS via_root,
                (SELECT count(*)::int FROM (SELECT $1::uuid AS wid) v
                   CROSS JOIN LATERAL (SELECT 1 FROM ${rel} t WHERE t.${key} = v.wid) x) AS via_lateral,
                (SELECT count(t.id)::int FROM (SELECT $2::uuid AS id) v LEFT JOIN ${rel} t ON t.id = v.id) AS via_outer`,
        w.B.scope.workspaceId,
        victimId(),
      ),
    );
    expect(rows[0]).toEqual({ via_root: 0, via_lateral: 0, via_outer: 0 });
  });

  it('INSERT: a row for B, with valid parents in B, is rejected by WITH CHECK (Prisma create uses RETURNING)', async () => {
    const deps = await w.db.withTenant(w.B.scope, (tx) => s.prepare(tx, w.B.ctx));
    await expectPgError(
      w.db.withTenant(w.A.scope, (tx) => s.insert(tx, w.B.ctx, deps)),
      '42501',
    );
  });

  it(`UPDATE: ${s.update === 'denied' ? 'denied outright (42501)' : 'B row unchanged; RETURNING and a writable CTE reveal nothing'}`, async () => {
    const before = await fingerprint(w.db, w.B, table);
    if (s.update === 'denied') {
      await expectPgError(
        w.db.withTenant(w.A.scope, (tx) =>
          tx.$executeRawUnsafe(`UPDATE ${rel} SET id = id WHERE id = $1::uuid`, victimId()),
        ),
        '42501',
      );
    } else {
      const set = s.update;
      const result = await w.db.withTenant(w.A.scope, async (tx) => ({
        returning: await tx.$queryRawUnsafe(
          `UPDATE ${rel} SET ${set} WHERE id = $1::uuid RETURNING *`,
          victimId(),
        ),
        byKey: await tx.$executeRawUnsafe(
          `UPDATE ${rel} SET ${set} WHERE ${key} = $1::uuid`,
          w.B.scope.workspaceId,
        ),
        cte: await tx.$queryRawUnsafe<Counts>(
          `WITH u AS (UPDATE ${rel} SET ${set} WHERE id = $1::uuid OR ${key} = $2::uuid RETURNING id)
           SELECT count(*)::int AS n FROM u`,
          victimId(),
          w.B.scope.workspaceId,
        ),
      }));
      expect(result).toEqual({ returning: [], byKey: 0, cte: [{ n: 0 }] });
      expectConfined(await blindWrite(`UPDATE ${rel} SET ${set}`));
    }
    expect(await fingerprint(w.db, w.B, table)).toBe(before);
  });

  it(`DELETE: ${s.delete === 'denied' ? 'denied outright (42501)' : 'B row survives; RETURNING reveals nothing'}`, async () => {
    const before = await fingerprint(w.db, w.B, table);
    if (s.delete === 'denied') {
      await expectPgError(
        w.db.withTenant(w.A.scope, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM ${rel} WHERE id = $1::uuid`, victimId()),
        ),
        '42501',
      );
    } else {
      const result = await w.db.withTenant(w.A.scope, async (tx) => ({
        returning: await tx.$queryRawUnsafe(`DELETE FROM ${rel} WHERE id = $1::uuid RETURNING *`, victimId()),
        byKey: await tx.$executeRawUnsafe(
          `DELETE FROM ${rel} WHERE ${key} = $1::uuid`,
          w.B.scope.workspaceId,
        ),
      }));
      expect(result).toEqual({ returning: [], byKey: 0 });
      expectConfined(await blindWrite(`DELETE FROM ${rel}`));
    }
    expect(await fingerprint(w.db, w.B, table)).toBe(before);
  });

  it('the tenant key of an own row cannot be reassigned to B (no column privilege)', async () => {
    await expectPgError(
      w.db.withTenant(w.A.scope, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE ${rel} SET ${key} = $1::uuid WHERE id = $2::uuid`,
          w.B.scope.workspaceId,
          ownId(),
        ),
      ),
      '42501',
    );
  });

  it('no context at all: zero rows; actor-only context: inserts rejected and nothing of B visible', async () => {
    const { rows } = await w.rawApp.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${rel}`);
    expect(rows[0]?.n).toBe(0);

    const deps = await w.db.withTenant(w.A.scope, (tx) => s.prepare(tx, w.A.ctx));
    await expectPgError(
      w.db.withActor(w.A.ownerId, (tx) => s.insert(tx, w.A.ctx, deps)),
      '42501',
    );
    const visible = await w.db.withActor(w.A.ownerId, (tx) =>
      tx.$queryRawUnsafe<Counts>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${key} = $1::uuid)::int AS of_b FROM ${rel}`,
        w.B.scope.workspaceId,
      ),
    );
    expect(visible[0]?.of_b).toBe(0);
    // Only the workspace-switcher bridge (FR-AUTH-08) is readable without a workspace: own memberships, own workspaces.
    if (table !== 'memberships' && table !== 'workspaces') expect(visible[0]?.total).toBe(0);
  });

  // Proves the "nothing happened" results above come from tenant isolation, not from a statement that never works.
  it(`positive control: on its own row A's UPDATE is ${s.update === 'denied' ? 'denied too' : 'applied'} and DELETE ${s.delete === 'denied' ? 'denied too' : 'applied'}`, async () => {
    const own = (sql: string) => inRollback(w.db, w.A.scope, (tx) => tx.$executeRawUnsafe(sql, ownId()));
    const update = `UPDATE ${rel} SET ${s.update === 'denied' ? 'id = id' : s.update} WHERE id = $1::uuid`;
    const remove = `DELETE FROM ${rel} WHERE id = $1::uuid`;
    if (s.update === 'denied') await expectPgError(own(update), '42501');
    else expect(await own(update)).toBe(1);
    if (s.delete === 'denied') await expectPgError(own(remove), '42501');
    else expect(await own(remove)).toBe(1);
  });
});

describe('joins along every foreign key between tenant tables', () => {
  it('never pair a row of A with a row of another workspace, on either side', async () => {
    const tenant = new Set<string>(TABLE_NAMES);
    const relevant = fks.filter(
      (fk) => fk.parentSchema === 'app' && tenant.has(fk.child) && tenant.has(fk.parent),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(8);
    for (const fk of relevant) {
      const childKey = TENANT_TABLES[fk.child as TableName].tenantKey;
      const parentKey = TENANT_TABLES[fk.parent as TableName].tenantKey;
      const on = fk.childColumns.map((c, i) => `c.${c} = p.${fk.parentColumns[i]}`).join(' AND ');
      const rows = await w.db.withTenant(w.A.scope, (tx) =>
        tx.$queryRawUnsafe<Counts>(
          `SELECT (SELECT count(*)::int FROM app.${fk.child} c JOIN app.${fk.parent} p ON ${on}
                    WHERE c.${childKey} IS DISTINCT FROM $1::uuid OR p.${parentKey} IS DISTINCT FROM $1::uuid) AS mixed,
                  (SELECT count(*)::int FROM app.${fk.child} c CROSS JOIN app.${fk.parent} p
                    WHERE p.${parentKey} = $2::uuid OR c.${childKey} = $2::uuid) AS reach_b`,
          w.A.scope.workspaceId,
          w.B.scope.workspaceId,
        ),
      );
      expect([fk.name, rows[0]]).toEqual([fk.name, { mixed: 0, reach_b: 0 }]);
    }
  });
});
