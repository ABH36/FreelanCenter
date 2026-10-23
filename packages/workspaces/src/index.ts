/**
 * @platform/workspaces - workspaces, membership, RBAC-checked commands and invitations (modules 01/02, P1 S5).
 * Server-only. Every exported command authorizes with `@platform/auth/rbac` before touching data.
 */
export const PACKAGE_NAME = '@platform/workspaces' as const;

export { INVITATION_MAIL_KIND, type DeliveryDeps, createInvitationEmailHandler } from './delivery';
export { LAST_OWNER_SQLSTATE, WorkspaceError, type WorkspaceErrorCode } from './errors';
export { type InvitationMail, renderInvitationMail } from './mail';
export {
  type AcceptOutcome,
  type AuditAction,
  INVITATION_TTL_MS,
  type InvitationRow,
  LIMITS,
  type MemberRow,
  type WorkspaceContext,
  type WorkspaceService,
  type WorkspaceServiceDeps,
  type WorkspaceSummary,
  createWorkspaceService,
} from './service';
export { RESERVED_SLUGS, SLUG_PATTERN, type SlugProblem, slugProblem, slugify } from './slug';
export {
  type InvitationKey,
  deriveInvitationKey,
  hashInvitationToken,
  invitationToken,
  isWellFormedToken,
} from './token';
