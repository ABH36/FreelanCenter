/**
 * P3 S8a: client review, the member side (FR-PUB-05; module 06; plan approved by the Owner 2026-11-16).
 *
 * Clients comment and approve through a staging link (apps/sites, app_public functions). Here members:
 *   - read the project's feedback: client comments (newest version first, each with its pin, its version and link,
 *     the client's name and e-mail, resolution and the members' replies) and the approvals (who, when, which
 *     version, through which link). Any member (`projects.view`).
 *   - reply to a client comment (decision 4: the client sees it on the review page). The database takes the reply's
 *     project, version, link and pin from the comment. Owners, admins and editors (`draft.edit`).
 *   - mark a client comment done, or open it again. Same people. The database stamps who and when.
 * Audit rows carry ids and counts only, never comment text (data-classification.md).
 */
import type { TenantDatabase } from '@platform/db';
import type { Logger } from '@platform/logger';
import { z } from 'zod';
import { WorkspaceError } from './errors';
import { createScopedRunner, parse, requireId } from './scoped';

export const REVIEW_LIMITS = {
  replyMax: 2000,
  /** Client comments listed per project (newest first); the database holds at most 300 per version. */
  listed: 500,
} as const;

export interface ReviewReply {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: Date;
}

export interface ReviewCommentView {
  id: string;
  siteVersionId: string;
  versionNumber: number | null;
  stagingLinkId: string;
  pageId: string | null;
  sectionId: string | null;
  authorName: string;
  authorEmail: string | null;
  body: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  replies: ReviewReply[];
}

export interface ReviewApprovalView {
  id: string;
  siteVersionId: string;
  versionNumber: number | null;
  stagingLinkId: string;
  approverName: string;
  approverEmail: string | null;
  approvedAt: Date;
}

export interface ProjectFeedback {
  comments: ReviewCommentView[];
  approvals: ReviewApprovalView[];
  /** Client comments not marked done. */
  open: number;
}

const replySchema = z
  .string()
  .trim()
  .min(1, 'Write a reply first.')
  .max(REVIEW_LIMITS.replyMax, `Keep the reply under ${REVIEW_LIMITS.replyMax} characters.`);

export function createReviewService(deps: { db: TenantDatabase; logger?: Logger }) {
  const { command, query } = createScopedRunner(deps.db, deps.logger);

  return {
    /** The project's client comments with replies, and its approvals. Any member. */
    async feedback(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown },
    ): Promise<ProjectFeedback> {
      const projectId = requireId(input.projectId);
      return query(actorUserId, input.workspaceId, 'projects.view', async (tx) => {
        const project = await tx.project.findFirst({
          where: { id: projectId, deletedAt: null },
          select: { id: true },
        });
        if (!project) throw new WorkspaceError('NOT_FOUND');
        const [comments, approvals] = await Promise.all([
          tx.reviewComment.findMany({
            where: { projectId, authorKind: 'client' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: REVIEW_LIMITS.listed,
            select: {
              id: true,
              siteVersionId: true,
              stagingLinkId: true,
              pageId: true,
              sectionId: true,
              authorName: true,
              authorEmail: true,
              body: true,
              createdAt: true,
              resolvedAt: true,
              resolvedBy: true,
              siteVersion: { select: { number: true } },
              replies: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, body: true, authorUserId: true, createdAt: true },
              },
            },
          }),
          tx.reviewApproval.findMany({
            where: { projectId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 100,
            select: {
              id: true,
              siteVersionId: true,
              stagingLinkId: true,
              approverName: true,
              approverEmail: true,
              createdAt: true,
              siteVersion: { select: { number: true } },
            },
          }),
        ]);
        const ids = new Set<string>();
        for (const c of comments) {
          if (c.resolvedBy) ids.add(c.resolvedBy);
          for (const r of c.replies) if (r.authorUserId) ids.add(r.authorUserId);
        }
        const who = new Map<string, string>();
        if (ids.size > 0) {
          const rows = await tx.$queryRaw<{ user_id: string; name: string | null }[]>`
            SELECT user_id, name FROM app.workspace_members() WHERE user_id = ANY(${[...ids]}::uuid[])`;
          for (const r of rows) if (r.name) who.set(r.user_id, r.name);
        }
        const views: ReviewCommentView[] = comments.map((c) => ({
          id: c.id,
          siteVersionId: c.siteVersionId,
          versionNumber: c.siteVersion.number,
          stagingLinkId: c.stagingLinkId,
          pageId: c.pageId,
          sectionId: c.sectionId,
          authorName: c.authorName ?? '',
          authorEmail: c.authorEmail,
          body: c.body,
          createdAt: c.createdAt,
          resolvedAt: c.resolvedAt,
          resolvedByName: c.resolvedBy ? (who.get(c.resolvedBy) ?? null) : null,
          replies: c.replies.map((r) => ({
            id: r.id,
            body: r.body,
            authorName: r.authorUserId ? (who.get(r.authorUserId) ?? null) : null,
            createdAt: r.createdAt,
          })),
        }));
        return {
          comments: views,
          approvals: approvals.map((a) => ({
            id: a.id,
            siteVersionId: a.siteVersionId,
            versionNumber: a.siteVersion.number,
            stagingLinkId: a.stagingLinkId,
            approverName: a.approverName,
            approverEmail: a.approverEmail,
            approvedAt: a.createdAt,
          })),
          open: views.filter((v) => !v.resolvedAt).length,
        };
      });
    },

    /** Answer a client comment; the client sees it on the review page (decision 4). */
    async reply(
      actorUserId: string,
      input: { workspaceId: unknown; commentId: unknown; body: unknown },
    ): Promise<{ replyId: string }> {
      const commentId = requireId(input.commentId);
      const body = parse(replySchema, input.body, 'body');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'review.comment_replied', capability: 'draft.edit' },
        async (tx, scope) => {
          const parent = await tx.reviewComment.findFirst({
            where: { id: commentId, authorKind: 'client' },
            select: { id: true, projectId: true, siteVersionId: true, stagingLinkId: true },
          });
          if (!parent) throw new WorkspaceError('NOT_FOUND');
          const reply = await tx.reviewComment.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: parent.projectId,
              siteVersionId: parent.siteVersionId,
              stagingLinkId: parent.stagingLinkId,
              authorKind: 'member',
              body,
              parentId: parent.id,
            },
            select: { id: true },
          });
          return {
            result: { replyId: reply.id },
            audit: {
              targetType: 'review_comment',
              targetId: parent.id,
              projectId: parent.projectId,
              metadata: { replyId: reply.id },
            },
          };
        },
      );
    },

    /** Mark a client comment done (`resolved: true`) or open it again. A repeat changes nothing. */
    async setResolved(
      actorUserId: string,
      input: { workspaceId: unknown; commentId: unknown; resolved: unknown },
    ): Promise<{ changed: boolean }> {
      const commentId = requireId(input.commentId);
      const resolved = parse(z.boolean(), input.resolved, 'resolved');
      return command<{ changed: boolean }>(
        actorUserId,
        input.workspaceId,
        {
          action: resolved ? 'review.comment_resolved' : 'review.comment_reopened',
          capability: 'draft.edit',
        },
        async (tx, scope) => {
          const comment = await tx.reviewComment.findFirst({
            where: { id: commentId, authorKind: 'client' },
            select: { id: true, projectId: true, resolvedAt: true },
          });
          if (!comment) throw new WorkspaceError('NOT_FOUND');
          if ((comment.resolvedAt !== null) === resolved) return { result: { changed: false }, audit: null };
          await tx.reviewComment.update({
            where: { id: comment.id },
            data: resolved
              ? { resolvedAt: new Date(), resolvedBy: scope.actorUserId }
              : { resolvedAt: null, resolvedBy: null },
            select: { id: true },
          });
          return {
            result: { changed: true },
            audit: { targetType: 'review_comment', targetId: comment.id, projectId: comment.projectId },
          };
        },
      );
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
