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
/** Host-change events sent per request and marked dispatched per step (DG-24). */
export const DISPATCH_CHUNK = 100;
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

  /** Marks emitted rows dispatched and counts a failure on each row that was not (the sweep retries those). */
  async function settle(
    workspaceId: string,
    done: readonly string[],
    failures: ReadonlyArray<{ id: string; error: string }>,
  ): Promise<void> {
    if (done.length === 0 && failures.length === 0) return;
    await db
      .withJobTenant(workspaceId, async (tx) => {
        if (done.length) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: [...done] }, dispatchedAt: null },
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

  const failureOf = (error: unknown): string =>
    redactString(error instanceof Error ? error.message : String(error)).slice(0, 500);

  /**
   * Emits the given rows of one workspace (those still undispatched) and marks the emitted ones dispatched.
   * Host-change events (one per project, so a suspension of a large workspace writes thousands) go out in
   * batches of DISPATCH_CHUNK per request, each batch marked dispatched as soon as it is sent: the work is
   * bounded per step, progress survives a request that ends early, and what is left is picked up by the sweep
   * (DG-24). Other events are emitted one at a time.
   */
  async function dispatchBatch(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<{ ok: number; failed: number }> {
    const rows = await db.withJobTenant(workspaceId, (tx) =>
      tx.outboxEvent.findMany({
        where: { id: { in: [...ids] }, dispatchedAt: null },
        select: { id: true, event: true, payload: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    let ok = 0;
    let failed = 0;

    const hostRows = rows.filter((r) => r.event === OUTBOX_EVENTS.siteHostsChanged);
    for (let i = 0; i < hostRows.length; i += DISPATCH_CHUNK) {
      const chunk = hostRows.slice(i, i + DISPATCH_CHUNK);
      const items: Array<{ id: string; ids: ReturnType<typeof parseSiteHostsChanged> }> = [];
      const failures: Array<{ id: string; error: string }> = [];
      for (const row of chunk) {
        try {
          items.push({ id: row.id, ids: parseSiteHostsChanged(row.payload) });
        } catch (error) {
          logger?.warn('outbox.emit_failed', { workspaceId, outboxId: row.id, event: row.event });
          failures.push({ id: row.id, error: failureOf(error) });
        }
      }
      let done: string[] = [];
      try {
        await jobs.siteHostsChangedMany(items.map((it) => ({ ids: it.ids, eventId: it.id })));
        done = items.map((it) => it.id);
      } catch (error) {
        logger?.warn('outbox.emit_failed', {
          workspaceId,
          event: OUTBOX_EVENTS.siteHostsChanged,
          count: items.length,
        });
        for (const it of items) failures.push({ id: it.id, error: failureOf(error) });
      }
      await settle(workspaceId, done, failures);
      ok += done.length;
      failed += failures.length;
    }

    const done: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const row of rows.filter((r) => r.event !== OUTBOX_EVENTS.siteHostsChanged)) {
      try {
        await emit(row.event, row.payload, row.id);
        done.push(row.id);
      } catch (error) {
        logger?.warn('outbox.emit_failed', { workspaceId, outboxId: row.id, event: row.event });
        failures.push({ id: row.id, error: failureOf(error) });
      }
    }
    await settle(workspaceId, done, failures);
    return { ok: ok + done.length, failed: failed + failures.length };
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
