'use server';
/**
 * Client review server actions (P3 S8a, FR-PUB-05). Thin wrappers over the review service
 * (packages/workspaces/src/review.ts): the user id comes from the server-side session, every id is only a selector,
 * and the service authorizes (read: any member; reply and resolve: owner/admin/editor) and audits. Each action is
 * registered with the IDOR harness in tests/isolation/src/actions.ts. Dates are sent as ISO strings.
 */
import type { ProjectFeedback } from '@platform/workspaces';
import { type EditorResult, runEditor } from '@/lib/editor-run';
import { reviewService } from '@/lib/workspaces';

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
export type ClientFeedback = Iso<ProjectFeedback>;

const plain = <T>(value: T): Iso<T> => JSON.parse(JSON.stringify(value)) as Iso<T>;

export async function reviewFeedbackAction(input: {
  workspaceId: string;
  projectId: string;
}): Promise<EditorResult<ClientFeedback>> {
  return runEditor(async (userId) =>
    plain(
      await (
        await reviewService()
      ).feedback(userId, { workspaceId: input?.workspaceId, projectId: input?.projectId }),
    ),
  );
}

export async function replyToCommentAction(input: {
  workspaceId: string;
  commentId: string;
  body: string;
}): Promise<EditorResult<{ replyId: string }>> {
  return runEditor(async (userId) =>
    (await reviewService()).reply(userId, {
      workspaceId: input?.workspaceId,
      commentId: input?.commentId,
      body: input?.body,
    }),
  );
}

export async function resolveCommentAction(input: {
  workspaceId: string;
  commentId: string;
  resolved: boolean;
}): Promise<EditorResult<{ changed: boolean }>> {
  return runEditor(async (userId) =>
    (await reviewService()).setResolved(userId, {
      workspaceId: input?.workspaceId,
      commentId: input?.commentId,
      resolved: input?.resolved,
    }),
  );
}
