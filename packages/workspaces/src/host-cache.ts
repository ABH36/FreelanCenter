/**
 * The host-cache invalidation job handler (FR-DOM-07, P1 S7). Runs inside `sites.host_cache.invalidate.v1` (or
 * the inline transport locally) after a command changed what a project's hosts may show. The event carries ids
 * only; the handler reloads the project's host names through RLS in a job scope and deletes their cached
 * resolutions, including those of soft-deleted domains (a removed host must stop resolving at once).
 */
import type { TenantDatabase } from '@platform/db';
import { invalidateHosts } from '@platform/hosting';
import type { HostCacheInvalidationHandler } from '@platform/jobs';
import { type Logger, redactString } from '@platform/logger';
import type { KeyValueStore } from '@platform/providers';
import { OUTBOX_EVENTS } from './outbox';

export interface HostCacheDeps {
  db: TenantDatabase;
  /** null: no cache configured (local development without Upstash); the handler then has nothing to delete. */
  cache: KeyValueStore | null;
  logger?: Logger;
}

export function createHostCacheInvalidationHandler(deps: HostCacheDeps): HostCacheInvalidationHandler {
  return {
    async invalidate({ workspaceId, projectId }) {
      const domains = await deps.db.withJobTenant(workspaceId, (tx) =>
        tx.domain.findMany({ where: { projectId }, select: { hostname: true } }),
      );
      const hostnames = domains.map((d) => d.hostname);
      const removed = deps.cache && hostnames.length ? await invalidateHosts(deps.cache, hostnames) : 0;
      deps.logger?.info('sites.host_cache.invalidated', {
        workspaceId,
        projectId,
        hosts: hostnames.length,
        removed,
      });
      return { hosts: hostnames.length };
    },

    async deadLetter({ ids, functionId, runId, error }) {
      deps.logger?.error('job.dead_lettered', undefined, {
        functionId,
        runId,
        workspaceId: ids?.workspaceId ?? null,
        projectId: ids?.projectId ?? null,
      });
      if (!ids) return;
      await deps.db.withJobTenant(ids.workspaceId, (tx) =>
        tx.jobDeadLetter.createMany({
          data: [
            {
              workspaceId: ids.workspaceId,
              functionId,
              runId: runId.slice(0, 64),
              event: OUTBOX_EVENTS.siteHostsChanged,
              targetType: 'project',
              targetId: ids.projectId,
              error: redactString(error).slice(0, 300),
            },
          ],
        }),
      );
    },
  };
}
