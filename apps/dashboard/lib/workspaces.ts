/**
 * Server-only workspace runtime (P1 S5, S6): the app_user data layer, the job transport, the outbox and the
 * workspace, project, notification and audit services.
 * Built lazily on first use, like the auth runtime, so `next build` needs no secrets.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';
import { cache } from 'react';
import { assertUrlRole, createTenantDatabase } from '@platform/db';
import { type Jobs, createJobs, loadJobsConfig } from '@platform/jobs';
import { getCorrelationIdFromHeaders, runWithContext } from '@platform/logger';
import {
  type AuditService,
  type NotificationService,
  type ProjectService,
  type WorkspaceContext,
  type WorkspaceService,
  createAuditService,
  createInvitationEmailHandler,
  createNotificationEmailHandler,
  createNotificationService,
  createOutbox,
  createProjectService,
  createWorkspaceService,
  deriveInvitationKey,
} from '@platform/workspaces';
import { authRuntime, getSession, logger } from './auth';

/** Preference only (the last workspace opened); every request re-checks membership server-side (FR-AUTH-08). */
export const ACTIVE_WORKSPACE_COOKIE = 'active_workspace';
/** An invitation token kept across sign-in/sign-up (httpOnly, 1 h). Cleared once the invitation is answered. */
export const PENDING_INVITE_COOKIE = 'pending_invite';

interface WorkspaceRuntime {
  service: WorkspaceService;
  projects: ProjectService;
  notifications: NotificationService;
  audit: AuditService;
  jobs: Jobs;
  ready: Promise<void>;
}

const globalForWorkspaces = globalThis as unknown as { __platformWorkspaces?: WorkspaceRuntime };

function build(): WorkspaceRuntime {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  assertUrlRole('app', url);
  const { config, email } = authRuntime();
  const invitationKey = deriveInvitationKey(config.secret);
  const db = createTenantDatabase({ connectionString: url, poolMax: 5, logger });
  const handler = createInvitationEmailHandler({
    db,
    email,
    invitationKey,
    baseURL: config.baseURL,
    appName: config.appName,
    logger,
  });
  const notificationEmail = createNotificationEmailHandler({
    db,
    email,
    baseURL: config.baseURL,
    appName: config.appName,
    logger,
  });
  // The sweep needs the emitter and the emitter's transport needs the sweep: bind it late.
  let sweep = async () => ({ dispatched: 0, failed: 0 });
  const jobs = createJobs(
    loadJobsConfig(),
    { invitationEmail: handler, notificationEmail, outboxSweep: { sweep: () => sweep() } },
    (task) => after(task),
  );
  // Dispatch after the response: a command never waits for Inngest; the sweep re-emits anything lost.
  const outbox = createOutbox({ db, jobs: jobs.emitter, logger, defer: (task) => after(task) });
  sweep = outbox.sweep;
  const service = createWorkspaceService({
    db,
    jobs: jobs.emitter,
    invitationKey,
    baseURL: config.baseURL,
    logger,
  });
  // One role check per process: tenant queries must never run as an owner or BYPASSRLS role.
  const ready = db.verifyRole('app_user');
  ready.catch((error: unknown) => logger.fatal('workspaces.db.role_check_failed', error));
  const projects = createProjectService({ db, outbox, logger });
  const notifications = createNotificationService({ db, logger });
  const audit = createAuditService({ db, logger });
  return { service, projects, notifications, audit, jobs, ready };
}

export function workspaceRuntime(): WorkspaceRuntime {
  globalForWorkspaces.__platformWorkspaces ??= build();
  return globalForWorkspaces.__platformWorkspaces;
}

export async function workspaces(): Promise<WorkspaceService> {
  const runtime = workspaceRuntime();
  await runtime.ready;
  return runtime.service;
}

async function ready(): Promise<WorkspaceRuntime> {
  const runtime = workspaceRuntime();
  await runtime.ready;
  return runtime;
}

export const projectService = async (): Promise<ProjectService> => (await ready()).projects;
export const notificationService = async (): Promise<NotificationService> => (await ready()).notifications;
export const auditService = async (): Promise<AuditService> => (await ready()).audit;

/** The signed-in, verified user's id, or a redirect to /sign-in. Never taken from client input. */
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id || !session.user.emailVerified) redirect('/sign-in');
  return session.user.id;
}

/** Runs a server action inside a correlation-id log context, so its audit rows and logs line up. */
export async function withRequestContext<T>(fn: () => Promise<T>): Promise<T> {
  const correlationId = getCorrelationIdFromHeaders(await headers());
  return runWithContext({ correlationId, app: 'dashboard' }, fn);
}

/** The workspace behind `/w/<slug>` for this user; 404 for non-members and unknown slugs alike. */
export const currentWorkspace = cache(async (slug: string): Promise<WorkspaceContext> => {
  const userId = await requireUserId();
  const ctx = await (await workspaces()).resolveBySlug(userId, slug);
  if (!ctx) notFound();
  return ctx;
});

export const myWorkspaces = cache(async () => (await workspaces()).listMyWorkspaces(await requireUserId()));

export async function rememberWorkspace(slug: string) {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, slug, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 180,
  });
}
