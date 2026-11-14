'use server';
/**
 * Editor server actions (P3 S3, module 05). Thin wrappers over the draft service (packages/workspaces/src/builder.ts):
 * the user id comes from the server-side session, every id is only a selector, and the service authorizes, validates
 * the patch, checks the lock and the revision, and audits. Each action is registered with the IDOR harness in
 * tests/isolation/src/actions.ts. The editor calls them with plain objects; results are plain data.
 */
import { redirect } from 'next/navigation';
import type { DraftView } from '@platform/workspaces';
import { isWorkspaceError } from '@platform/workspaces';
import { type ActionState, field, runAction } from '@/lib/actions';
import { builderService, requireUserId, withRequestContext } from '@/lib/workspaces';

export type EditorResult<T = undefined> =
  { ok: true; value: T } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> };

async function run<T>(fn: (userId: string) => Promise<T>): Promise<EditorResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, value: await withRequestContext(() => fn(userId)) };
  } catch (error) {
    if (isWorkspaceError(error)) {
      return { ok: false, code: error.code, error: error.message, fieldErrors: error.fieldErrors };
    }
    throw error;
  }
}

interface Target {
  workspaceId: string;
  projectId: string;
}

/** FR-PRJ-01: "Start from this template" on the project page; opens the editor. */
export async function startDraftAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const state = await runAction(async () => {
    await (
      await builderService()
    ).createDraftFromTemplate(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
      templateId: field(form, 'templateId'),
    });
  });
  if (state.error) return state;
  const slug = field(form, 'slug');
  const projectId = field(form, 'projectId');
  redirect(
    /^[a-z0-9-]{3,48}$/.test(slug) && /^[0-9a-f-]{36}$/.test(projectId)
      ? `/w/${slug}/projects/${projectId}/editor`
      : '/',
  );
}

/** The current draft, for the editor after a conflict (someone else saved). */
export async function reloadDraftAction(input: Target): Promise<EditorResult<DraftView>> {
  return run(async (userId) =>
    (await builderService()).getDraft(userId, input?.workspaceId, input?.projectId),
  );
}

/** FR-BLD-06: one autosave. */
export async function saveDraftChangeAction(
  input: Target & { changeId: string; expectedRevision: number; operations: unknown },
): Promise<EditorResult<{ revision: number }>> {
  return run(async (userId) =>
    (await builderService()).applyChange(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      changeId: input?.changeId,
      expectedRevision: input?.expectedRevision,
      operations: input?.operations,
    }),
  );
}

export async function undoDraftAction(
  input: Target & { expectedRevision: number },
): Promise<EditorResult<{ revision: number }>> {
  return run(async (userId) =>
    (await builderService()).undo(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      expectedRevision: input?.expectedRevision,
    }),
  );
}

export async function redoDraftAction(
  input: Target & { expectedRevision: number },
): Promise<EditorResult<{ revision: number }>> {
  return run(async (userId) =>
    (await builderService()).redo(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      expectedRevision: input?.expectedRevision,
    }),
  );
}

/** FR-BLD-07: take the lock or renew it (the editor's 30 s heartbeat). */
export async function editLockAction(input: Target) {
  return run(async (userId) =>
    (await builderService()).acquireLock(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
    }),
  );
}

/** Owners and admins only (the service refuses others); audited with the previous holder. */
export async function takeOverEditLockAction(input: Target) {
  return run(async (userId) =>
    (await builderService()).takeOverLock(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
    }),
  );
}

export async function releaseEditLockAction(input: Target) {
  return run(async (userId) =>
    (await builderService()).releaseLock(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
    }),
  );
}
