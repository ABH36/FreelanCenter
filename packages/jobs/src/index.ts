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
  parseIds,
  parseInvitationCreated,
} from './events';
export {
  APP_ID,
  type DeadLetter,
  type Defer,
  INVITATION_EMAIL_FUNCTION,
  type InvitationEmailHandler,
  type JobEmitter,
  type Jobs,
  type RouteHandler,
  SERVE_PATH,
  createInlineJobs,
  createInngestClient,
  createInngestJobs,
  createInvitationEmailFunction,
  createJobs,
} from './runtime';
