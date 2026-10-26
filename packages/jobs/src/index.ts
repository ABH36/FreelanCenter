/**
 * @platform/jobs - durable background jobs (ADR-007, Inngest). Server-only. The only package allowed to import
 * the Inngest SDK; everything else emits through `JobEmitter`.
 */
export const PACKAGE_NAME = '@platform/jobs' as const;

export { type JobsConfig, type JobsTransport, JobsConfigError, loadJobsConfig } from './config';
export {
  EVENTS,
  type InvitationCreated,
  InvalidPayloadError,
  type NotificationEmailRequested,
  parseIds,
  parseInvitationCreated,
  parseNotificationEmailRequested,
  parseSiteHostsChanged,
  type SiteHostsChanged,
} from './events';
export {
  APP_ID,
  type DeadLetter,
  HOST_CACHE_INVALIDATION_FUNCTION,
  type HostCacheInvalidationHandler,
  type Defer,
  INVITATION_EMAIL_FUNCTION,
  type InvitationEmailHandler,
  type JobEmitter,
  type JobHandlers,
  type Jobs,
  NOTIFICATION_EMAIL_FUNCTION,
  type NotificationEmailHandler,
  OUTBOX_SWEEP_FUNCTION,
  type OutboxSweeper,
  type RouteHandler,
  SERVE_PATH,
  createInlineJobs,
  createInngestClient,
  createInngestJobs,
  createInvitationEmailFunction,
  createJobs,
  createNotificationEmailFunction,
  createHostCacheInvalidationFunction,
  createOutboxSweepFunction,
} from './runtime';
