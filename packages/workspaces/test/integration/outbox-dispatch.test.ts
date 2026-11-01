/**
 * DG-24: dispatching the outbox rows of a very large suspension. 1,500 `sites.hosts.changed.v1` rows (one per
 * project, as the admin suspend writes them) must go out in bounded batches, every row must be marked dispatched,
 * and the work must never queue more concurrent database transactions than the tenant client allows.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createOutbox, DISPATCH_CHUNK } from '../../src/outbox';
import type { JobEmitter } from '@platform/jobs';
import { closeAll, db, jobs, runJobs, workspaceWith } from '../harness';

afterAll(closeAll);

describe('DG-24: outbox dispatch of a large suspension', () => {
  it(
    'sends 1,500 host-change events in chunks of at most ' +
      DISPATCH_CHUNK +
      ' and marks every row dispatched',
    async () => {
      const ws = await workspaceWith();
      const rows = Array.from({ length: 1_500 }, () => ({
        id: crypto.randomUUID(),
        workspaceId: ws.id,
        event: 'sites.hosts.changed.v1',
        payload: { workspaceId: ws.id, projectId: crypto.randomUUID() },
      }));
      const scope = await db.resolveTenantScope(ws.owner.id, ws.id);
      await db.withTenant(scope!, (tx) => tx.outboxEvent.createMany({ data: rows }));

      const sizes: number[] = [];
      const emitter: JobEmitter = {
        ...jobs.emitter,
        siteHostsChangedMany: async (items) => {
          sizes.push(items.length);
          return jobs.emitter.siteHostsChangedMany(items);
        },
      };
      const deferred: Array<Promise<void>> = [];
      const outbox = createOutbox({ db, jobs: emitter, defer: (task) => void deferred.push(task()) });

      await outbox.dispatch(
        ws.id,
        rows.map((r) => r.id),
      );
      await Promise.all(deferred);
      await runJobs();

      expect(sizes.reduce((a, b) => a + b, 0)).toBe(1_500);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(DISPATCH_CHUNK);
      expect(sizes.length).toBe(Math.ceil(1_500 / DISPATCH_CHUNK));
      const pending = await db.withTenant(scope!, (tx) =>
        tx.outboxEvent.count({ where: { workspaceId: ws.id, dispatchedAt: null } }),
      );
      expect(pending).toBe(0);
    },
    180_000,
  );

  it('a failing batch is counted on its rows and left for the sweep; the other batches still go out', async () => {
    const ws = await workspaceWith();
    const rows = Array.from({ length: 250 }, () => ({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      event: 'sites.hosts.changed.v1',
      payload: { workspaceId: ws.id, projectId: crypto.randomUUID() },
    }));
    const scope = await db.resolveTenantScope(ws.owner.id, ws.id);
    await db.withTenant(scope!, (tx) => tx.outboxEvent.createMany({ data: rows }));

    let call = 0;
    const emitter: JobEmitter = {
      ...jobs.emitter,
      siteHostsChangedMany: async (items) => {
        call += 1;
        if (call === 2) throw new Error('provider down');
        return jobs.emitter.siteHostsChangedMany(items);
      },
    };
    const outbox = createOutbox({ db, jobs: emitter });
    await outbox.dispatch(
      ws.id,
      rows.map((r) => r.id),
    );
    await runJobs();

    const left = await db.withTenant(scope!, (tx) =>
      tx.outboxEvent.findMany({
        where: { workspaceId: ws.id, dispatchedAt: null },
        select: { attempts: true, lastError: true },
      }),
    );
    expect(left).toHaveLength(DISPATCH_CHUNK);
    expect(left.every((r) => r.attempts === 1 && r.lastError === 'provider down')).toBe(true);
  }, 120_000);
});
