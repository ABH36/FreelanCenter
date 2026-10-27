/**
 * Workspace service suite harness: the local Docker database through PgBouncer as `app_user` (tenant data) and
 * `app_auth` (creating identity users), a capture mail sink, the host cache on the local Upstash emulator (S7) and the inline job
 * transport whose deferred tasks the tests run explicitly.
 */
import pg from 'pg';
import { createTenantDatabase, uuidv7 } from '@platform/db';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { createInlineJobs } from '@platform/jobs';
import { LOCAL_UPSTASH } from '@platform/hosting/testing';
import { createCaptureProvider, createUpstashStore } from '@platform/providers';
import { createAuditService } from '../src/audit';
import { createInvitationEmailHandler } from '../src/delivery';
import { createHostCacheInvalidationHandler } from '../src/host-cache';
import { createNotificationEmailHandler } from '../src/notification-delivery';
import { createNotificationService } from '../src/notifications';
import { createOutbox } from '../src/outbox';
import { createProjectService } from '../src/projects';
import { createWorkspaceService } from '../src/service';
import { deriveInvitationKey } from '../src/token';

export const BASE_URL = 'http://localhost:3000';
export const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;

export const db = createTenantDatabase({ connectionString: LOCAL_DATABASE_URLS.app, poolMax: 8 });
export const auth = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.auth, max: 3 });
export const mail = createCaptureProvider();
export const invitationKey = deriveInvitationKey('workspace-suite-local-only-secret-0123456789');

const tasks: Array<() => Promise<void>> = [];
export const handler = createInvitationEmailHandler({
  db,
  email: mail,
  invitationKey,
  baseURL: BASE_URL,
  appName: 'Platform',
});
export const notificationHandler = createNotificationEmailHandler({
  db,
  email: mail,
  baseURL: BASE_URL,
  appName: 'Platform',
});
/**
 * S7: the host-resolution cache apps/sites reads and the invalidation job deletes from, over the Upstash REST
 * protocol (the stack's serverless-redis-http emulator).
 */
export const hostCache = createUpstashStore(LOCAL_UPSTASH);
export const hostCacheHandler = createHostCacheInvalidationHandler({ db, cache: hostCache });
export const jobs = createInlineJobs(
  {
    invitationEmail: handler,
    notificationEmail: notificationHandler,
    hostCacheInvalidation: hostCacheHandler,
  },
  (task) => void tasks.push(task),
);
export const service = createWorkspaceService({ db, jobs: jobs.emitter, invitationKey, baseURL: BASE_URL });
export const outbox = createOutbox({ db, jobs: jobs.emitter });
export const projects = createProjectService({ db, outbox });
export const notifications = createNotificationService({ db });
export const audit = createAuditService({ db });

/** Runs the job work queued so far (the inline transport defers it past the "response"). */
export async function runJobs(): Promise<void> {
  while (tasks.length) await tasks.shift()!();
}

let seq = 0;
export function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${RUN}-${seq}`;
}

export interface TestUser {
  id: string;
  email: string;
}

export async function createUser(options: { verified?: boolean } = {}): Promise<TestUser> {
  const id = uuidv7();
  const email = `${unique('ws')}@example.test`;
  await auth.query(
    `INSERT INTO identity.users (id, name, email, email_verified) VALUES ($1, 'Suite User', $2, $3)`,
    [id, email, options.verified ?? true],
  );
  return { id, email };
}

/** A workspace with an owner, plus members of the given roles (added through real invitations). */
export async function workspaceWith(roles: Array<'admin' | 'editor' | 'viewer'> = []) {
  const owner = await createUser();
  const { id, slug } = await service.createWorkspace(owner.id, {
    name: 'Suite Workspace',
    slug: unique('suite'),
  });
  const members: Record<string, TestUser & { membershipId: string }> = {};
  for (const role of roles) {
    const user = await createUser();
    const { invitationId } = await service.createInvitation(owner.id, {
      workspaceId: id,
      email: user.email,
      role,
    });
    const { url } = await service.invitationLink(owner.id, { workspaceId: id, invitationId });
    const result = await service.acceptInvitation(user.id, url.split('/invite/')[1]!);
    if (result.outcome !== 'accepted') throw new Error(`setup: ${role} could not join (${result.outcome})`);
    const list = await service.listMembers(owner.id, id);
    members[role] = { ...user, membershipId: list.find((m) => m.userId === user.id)!.membershipId };
  }
  const ownerMembership = (await service.listMembers(owner.id, id)).find((m) => m.userId === owner.id)!;
  return { id, slug, owner: { ...owner, membershipId: ownerMembership.membershipId }, members };
}

export async function closeAll() {
  await db.disconnect();
  await auth.end();
}
