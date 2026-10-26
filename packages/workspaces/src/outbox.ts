/**
 * Transactional outbox (cross-module contracts: "persist state and an outbox/event record atomically where a job
 * must follow"; S5 decision D4). A command writes its outbox rows in its own transaction; after commit the
 * request calls `dispatch`, and the `outbox.sweep.v1` cron job calls `sweep` for rows whose emit was lost (a
 * crash, a network error, a timeout, a process ending before a deferred dispatch ran). The outbox id is the
 * event id, so Inngest de-duplicates a row emitted by both; the job functions are idempotent on top of that
 * (ADR-007 rule 2).
 */
import type { TenantDatabase } from '@platform/db';
import { type JobEmitter, parseNotificationEmailRequested, parseSiteHostsChanged } from '@platform/jobs';
import { type Logger, redactString } from '@platform/logger';

export const OUTBOX_EVENTS = {
  notificationEmail: 'notification.email.requested.v1',
  /** S7: a project's hosts changed; drop their cached resolutions (apps/sites). */
  siteHostsChanged: 'sites.hosts.changed.v1',
} as const;

export const SWEEP_BATCH = 100;
/** An undispatched row younger than this is still being dispatched by its request. */
export const SWEEP_MIN_AGE_SECONDS = 60;

export interface OutboxDeps {
  db: TenantDatabase;
  jobs: JobEmitter;
  logger?: Logger;
  /** Runs the after-commit dispatch later (Next `after()`); without it, dispatch is awaited. */
  defer?: (task: () => Promise<void>) => void;
  /** Tests only: sweep rows younger than SWEEP_MIN_AGE_SECONDS. */
  sweepMinAgeSeconds?: number;
}

export function createOutbox(deps: OutboxDeps) {
  const { db, jobs, logger } = deps;
  const minAge = deps.sweepMinAgeSeconds ?? SWEEP_MIN_AGE_SECONDS;

  async function emit(event: string, payload: unknown, eventId: string): Promise<void> {
    switch (event) {
      case OUTBOX_EVENTS.notificationEmail:
        return jobs.notificationEmailRequested(parseNotificationEmailRequested(payload), { eventId });
      case OUTBOX_EVENTS.siteHostsChanged:
        return jobs.siteHostsChanged(parseSiteHostsChanged(payload), { eventId });
      default:
        throw new Error(`unknown outbox event ${event}`);
    }
  }

  /**
   * Emits the given rows of one workspace (those still undispatched) and marks the emitted ones dispatched: one
   * read, one update, plus one update per failure (counted on the row, left for the sweep).
   */
  async function dispatchBatch(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<{ ok: number; failed: number }> {
    const rows = await db.withJobTenant(workspaceId, (tx) =>
      tx.outboxEvent.findMany({
        where: { id: { in: [...ids] }, dispatchedAt: null },
        select: { id: true, event: true, payload: true },
      }),
    );
    const done: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const row of rows) {
      try {
        await emit(row.event, row.payload, row.id);
        done.push(row.id);
      } catch (error) {
        logger?.warn('outbox.emit_failed', { workspaceId, outboxId: row.id, event: row.event });
        failures.push({
          id: row.id,
          error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      }
    }
    if (done.length || failures.length) {
      await db
        .withJobTenant(workspaceId, async (tx) => {
          if (done.length) {
            await tx.outboxEvent.updateMany({
              where: { id: { in: done }, dispatchedAt: null },
              data: { dispatchedAt: new Date(), attempts: { increment: 1 } },
            });
          }
          for (const f of failures) {
            await tx.outboxEvent.updateMany({
              where: { id: f.id, dispatchedAt: null },
              data: { attempts: { increment: 1 }, lastError: f.error },
            });
          }
        })
        .catch((e: unknown) => logger?.error('outbox.mark_failed', e, { workspaceId }));
    }
    return { ok: rows.length - failures.length, failed: failures.length };
  }

  async function dispatchNow(workspaceId: string, ids: readonly string[]): Promise<void> {
    try {
      await dispatchBatch(workspaceId, ids);
    } catch (error) {
      logger?.error('outbox.dispatch_failed', error, { workspaceId, count: ids.length });
    }
  }

  return {
    /**
     * After commit. Never throws: whatever is not emitted now is emitted by the sweep. With `defer` (the dashboard
     * passes Next `after()`) it runs after the response, so a command never waits for the job provider.
     */
    async dispatch(workspaceId: string, ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      if (deps.defer) deps.defer(() => dispatchNow(workspaceId, ids));
      else await dispatchNow(workspaceId, ids);
    },

    /** Cron: rows still undispatched SWEEP_MIN_AGE_SECONDS after they were written, oldest first, at most SWEEP_BATCH. */
    async sweep(): Promise<{ dispatched: number; failed: number }> {
      const pending = await db.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ id: string; workspace_id: string }>>`
          SELECT id, workspace_id FROM app.outbox_pending(${SWEEP_BATCH}::int, ${minAge}::int)`,
      );
      let dispatched = 0;
      let failed = 0;
      const byWorkspace = new Map<string, string[]>();
      for (const row of pending)
        byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row.id]);
      for (const [workspaceId, ids] of byWorkspace) {
        const result = await dispatchBatch(workspaceId, ids).catch(() => ({ ok: 0, failed: ids.length }));
        dispatched += result.ok;
        failed += result.failed;
      }
      if (pending.length) logger?.info('outbox.swept', { dispatched, failed });
      return { dispatched, failed };
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
