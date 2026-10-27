/**
 * @platform/workspaces - workspaces, membership, invitations (P1 S5), projects and their lifecycle, the audit
 * viewer, notifications and the outbox (P1 S6), the host-cache invalidation job (P1 S7), the admin console (P1 S8);
 * modules 01/02/03/09/12. Server-only. Every exported command authorizes with `@platform/auth/rbac` before
 * touching data; the admin service is authorized by the app_admin definer functions.
 */
export const PACKAGE_NAME = '@platform/workspaces' as const;

export {
  ADMIN_PAGE_SIZE,
  ADMIN_REASON,
  type AdminPrincipal,
  type AdminService,
  type AdminServiceDeps,
  type Page,
  type TotpVerifier,
  createAdminService,
} from './admin';

export {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_PAGE_SIZE,
  type AuditEntryRow,
  type AuditFilters,
  type AuditService,
  createAuditService,
  csvCell,
  parseAuditFilters,
  toCsv,
} from './audit';
export { INVITATION_MAIL_KIND, type DeliveryDeps, createInvitationEmailHandler } from './delivery';
export { type HostCacheDeps, createHostCacheInvalidationHandler } from './host-cache';
export { LAST_OWNER_SQLSTATE, WorkspaceError, type WorkspaceErrorCode } from './errors';
export {
  PROJECT_STATUSES,
  PROJECT_TRANSITIONS,
  type ProjectStatus,
  STATUS_LABEL,
  type Transition,
  findTransition,
  isProjectStatus,
  transitionsFrom,
} from './lifecycle';
export {
  type InvitationMail,
  type NotificationMail,
  renderInvitationMail,
  renderNotificationMail,
} from './mail';
export {
  NOTIFICATION_MAIL_KIND,
  type NotificationDeliveryDeps,
  createNotificationEmailHandler,
} from './notification-delivery';
export {
  CATEGORY_NAMES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PAGE_SIZE,
  type NotificationCategory,
  type NotificationRow,
  type NotificationService,
  type Preferences,
  categoryOf,
  createNotificationService,
  emailWanted,
} from './notifications';
export { OUTBOX_EVENTS, type Outbox, type OutboxDeps, SWEEP_BATCH, createOutbox } from './outbox';
export {
  PROJECT_CATEGORIES,
  PROJECT_LIMITS,
  type ProjectAuditAction,
  type ProjectCategory,
  type ProjectDetail,
  type ProjectFilters,
  type ProjectListItem,
  type ProjectService,
  type ProjectServiceDeps,
  type StatusFilter,
  createProjectService,
  likePattern,
  parseStatusFilter,
} from './projects';
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
export { RESERVED_SLUGS, SLUG_PATTERN, type SlugProblem, slugProblem, slugify, subdomainLabel } from './slug';
export {
  type InvitationKey,
  deriveInvitationKey,
  hashInvitationToken,
  invitationToken,
  isWellFormedToken,
} from './token';
