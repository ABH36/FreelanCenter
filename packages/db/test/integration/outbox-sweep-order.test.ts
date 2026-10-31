/**
 * P1 S9 (S8-6): `app.outbox_pending` hands the sweep the least-tried rows first, then the oldest, so a burst of
 * rows that keep failing cannot hold healthy rows back. System context only, as the sweep job calls it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { TenantDatabase } from '../../src/client';
import { pool, seedWorkspace, tenantDb, urls, type SeededWorkspace } from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let A: SeededWorkspace;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  A = await seedWorkspace(db, auth);
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end()]);
});

describe('app.outbox_pending order', () => {
  it('lists never-tried rows before failing ones, each group oldest first', async () => {
    const hour = 3_600_000;
    const make = (age: number, attempts: number) =>
      db.withTenant(A.scope, async (tx) => {
        const { id } = await tx.outboxEvent.create({
          data: {
            workspaceId: A.scope.workspaceId,
            event: 'sweep.order.test.v1',
            payload: {},
            createdAt: new Date(Date.now() - age),
          },
          select: { id: true },
        });
        if (attempts > 0) await tx.outboxEvent.update({ where: { id }, data: { attempts } });
        return id;
      });
    // Oldest first among the failing ones would put these two at the head under the S6 order.
    const failingOld = await make(5 * hour, 7);
    const failingNew = await make(4 * hour, 7);
    const lessFailing = await make(3 * hour, 2);
    const freshOld = await make(2 * hour, 0);
    const freshNew = await make(1 * hour, 0);
    const mine = new Set([failingOld, failingNew, lessFailing, freshOld, freshNew]);

    const rows = await db.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(500, 0)`,
    );
    const order = rows.map((r) => r.id).filter((id) => mine.has(id));
    expect(order).toEqual([freshOld, freshNew, lessFailing, failingOld, failingNew]);
  });

  it('still skips rows with 20 attempts and honours the minimum age and the limit', async () => {
    const spent = await db.withTenant(A.scope, async (tx) => {
      const { id } = await tx.outboxEvent.create({
        data: { workspaceId: A.scope.workspaceId, event: 'sweep.order.test.v1', payload: {} },
        select: { id: true },
      });
      await tx.outboxEvent.update({ where: { id }, data: { attempts: 20 } });
      return id;
    });
    const all = await db.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(500, 0)`,
    );
    expect(all.map((r) => r.id)).not.toContain(spent);
    const young = await db.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(500, 86400)`,
    );
    expect(young.map((r) => r.id)).not.toContain(spent);
    const one = await db.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.outbox_pending(1, 0)`,
    );
    expect(one.length).toBeLessThanOrEqual(1);
  });
});
