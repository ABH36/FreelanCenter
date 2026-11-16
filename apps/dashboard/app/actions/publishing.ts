'use server';
/**
 * Publishing server actions (P3 S7a, module 06). Thin wrappers over the publishing service
 * (packages/workspaces/src/publishing.ts): the user id comes from the server-side session, every id is only a
 * selector, and the service authorizes (staging: owner/admin/editor; live: owner/admin), checks the revision, runs
 * preflight and audits. Each action is registered with the IDOR harness in tests/isolation/src/actions.ts. Dates are
 * sent as ISO strings.
 */
import {
  type PreflightCheck,
  type PublishResult,
  type PublishingStatus,
  type RollbackResult,
  WorkspaceError,
} from '@platform/workspaces';
import { type EditorResult, runEditor } from '@/lib/editor-run';
import { builderService, publishingService } from '@/lib/workspaces';

interface Target {
  workspaceId: string;
  projectId: string;
}

type Iso<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K] extends (infer U)[]
        ? Iso<U>[]
        : T[K] extends object | null
          ? Iso<NonNullable<T[K]>> | Extract<T[K], null>
          : T[K];
};
export type ClientPublishingStatus = Iso<PublishingStatus>;

const plain = <T>(value: T): Iso<T> => JSON.parse(JSON.stringify(value)) as Iso<T>;

export async function publishingStatusAction(input: Target): Promise<EditorResult<ClientPublishingStatus>> {
  return runEditor(async (userId) =>
    plain(await (await publishingService()).status(userId, input?.workspaceId, input?.projectId)),
  );
}

export async function preflightAction(
  input: Target & { kind: 'staging' | 'live' },
): Promise<EditorResult<{ revision: number; ok: boolean; checks: PreflightCheck[] }>> {
  return runEditor(async (userId) =>
    (await publishingService()).preflight(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      kind: input?.kind,
    }),
  );
}

/** FR-PUB-01/02. `publishKey` is a UUID the browser makes per click, so a retried request publishes once. */
export async function publishAction(
  input: Target & { kind: 'staging' | 'live'; expectedRevision: number; publishKey: string; note?: string },
): Promise<EditorResult<PublishResult>> {
  return runEditor(async (userId) =>
    (await publishingService()).publish(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      kind: input?.kind,
      expectedRevision: input?.expectedRevision,
      publishKey: input?.publishKey,
      note: input?.note,
    }),
  );
}

export async function createStagingLinkAction(
  input: Target,
): Promise<EditorResult<ClientPublishingStatus['stagingLinks'][number]>> {
  return runEditor(async (userId) =>
    plain(
      await (
        await publishingService()
      ).createStagingLink(userId, {
        workspaceId: input?.workspaceId,
        projectId: input?.projectId,
      }),
    ),
  );
}

/**
 * P3 S7b (FR-PUB-03): one-click rollback. `expectedLiveVersionId` is the live version the page showed; owners and
 * admins only (the service checks).
 */
export async function rollbackAction(
  input: Target & { versionId: string; expectedLiveVersionId: string },
): Promise<EditorResult<RollbackResult>> {
  return runEditor(async (userId) =>
    (await publishingService()).rollback(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      versionId: input?.versionId,
      expectedLiveVersionId: input?.expectedLiveVersionId,
    }),
  );
}

/**
 * P3 S7b (decision 1): put a stored version into the draft, as one undoable change. The edit lock is taken for the
 * call when nobody holds it (and given back if it was not the caller's before); someone else editing is
 * LOCK_REQUIRED. `changeId` is a UUID the browser makes per click, `expectedRevision` the draft revision it saw.
 */
export async function restoreVersionAction(
  input: Target & { versionId: string; expectedRevision: number; changeId: string },
): Promise<EditorResult<{ revision: number }>> {
  return runEditor(async (userId) => {
    const builder = await builderService();
    const target = { workspaceId: input?.workspaceId, projectId: input?.projectId };
    const before = await builder.getDraft(userId, target.workspaceId, target.projectId);
    const hadLock = before.lock?.mine === true;
    if (!hadLock) {
      const lock = await builder.acquireLock(userId, target);
      if (!lock.held) throw new WorkspaceError('LOCK_REQUIRED');
    }
    try {
      return await builder.restoreVersion(userId, {
        ...target,
        versionId: input?.versionId,
        expectedRevision: input?.expectedRevision,
        changeId: input?.changeId,
      });
    } finally {
      if (!hadLock) await builder.releaseLock(userId, target).catch(() => undefined);
    }
  });
}

export async function revokeStagingLinkAction(input: {
  workspaceId: string;
  linkId: string;
}): Promise<EditorResult<{ revoked: boolean }>> {
  return runEditor(async (userId) =>
    (await publishingService()).revokeStagingLink(userId, {
      workspaceId: input?.workspaceId,
      linkId: input?.linkId,
    }),
  );
}
