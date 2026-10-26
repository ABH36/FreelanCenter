/**
 * Integration-test fixtures. Every connection uses the role it would use in production; the only privileged one
 * is `platform_admin`, the local stand-in for Supabase's operator role, used for catalog inspection only.
 * Run against the Docker stack: `pnpm db:setup && pnpm test:integration`.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createTenantDatabase, type TenantDatabase, type TenantScope } from '../../src/client';
import { LOCAL_DATABASE_URLS } from '../../src/testing';
import { uuidv7 } from '../../src/uuid';

export { expectPgError, sqlStates } from '../../src/testing';

export const urls = LOCAL_DATABASE_URLS;

export function pool(url: string, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

export function tenantDb(
  overrides: Partial<Parameters<typeof createTenantDatabase>[0]> = {},
): TenantDatabase {
  return createTenantDatabase({ connectionString: urls.app, poolMax: 8, ...overrides });
}

/** Better Auth's role creates users; nothing else can. */
export async function createUser(auth: pg.Pool, opts: { mfa?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await auth.query(
    `INSERT INTO identity.users (id, name, email, email_verified, two_factor_enabled)
     VALUES ($1, 'Test User', $2, true, $3)`,
    [id, `user-${id}@example.test`, opts.mfa ?? false],
  );
  return id;
}

let slugCounter = 0;
export function uniqueSlug(prefix = 'ws'): string {
  slugCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${slugCounter}`;
}

export interface SeededWorkspace {
  scope: TenantScope;
  ownerId: string;
  projectId: string;
  contactId: string;
  domainId: string;
  hostname: string;
}

/** A workspace with an owner, one project, a contact, a subdomain, an audit row and a notification. */
export async function seedWorkspace(db: TenantDatabase, auth: pg.Pool): Promise<SeededWorkspace> {
  const ownerId = await createUser(auth);
  const slug = uniqueSlug();
  return db.withNewWorkspace(ownerId, async (tx, scope) => {
    await tx.workspace.create({
      data: { id: scope.workspaceId, name: `Workspace ${slug}`, slug, createdBy: ownerId },
    });
    await tx.membership.create({ data: { workspaceId: scope.workspaceId, userId: ownerId, role: 'owner' } });
    const project = await tx.project.create({
      data: { workspaceId: scope.workspaceId, name: 'Site', createdBy: ownerId },
    });
    const contact = await tx.clientContact.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: project.id,
        name: 'Client',
        email: 'client@example.test',
      },
    });
    await tx.project.update({ where: { id: project.id }, data: { clientContactId: contact.id } });
    // S6: platform subdomains come only from the allocator (`<label>.<sites_domain>`, db:configure).
    const [domain] = await tx.$queryRaw<Array<{ id: string; hostname: string }>>`
      SELECT domain_id AS id, hostname FROM app.allocate_platform_subdomain(${project.id}::uuid, ${slug})`;
    if (!domain) throw new Error('seed: no subdomain allocated');
    const hostname = domain.hostname;
    await tx.auditLog.create({
      data: {
        workspaceId: scope.workspaceId,
        actorType: 'user',
        actorId: ownerId,
        action: 'workspace.created',
        result: 'success',
      },
    });
    await tx.notification.create({
      data: { workspaceId: scope.workspaceId, userId: ownerId, type: 'workspace.welcome' },
    });
    // S6 tables: a preference, an outbox event and a dead letter.
    await tx.notificationPreference.create({
      data: { workspaceId: scope.workspaceId, userId: ownerId, category: 'project.review', email: false },
    });
    await tx.outboxEvent.create({
      data: {
        workspaceId: scope.workspaceId,
        event: 'notification.email.requested.v1',
        payload: { workspaceId: scope.workspaceId, notificationId: uuidv7() },
      },
    });
    await tx.jobDeadLetter.create({
      data: {
        workspaceId: scope.workspaceId,
        functionId: 'seed-v1',
        runId: 'seed',
        error: 'seeded dead letter',
      },
    });
    await tx.invitation.create({
      data: {
        workspaceId: scope.workspaceId,
        email: `invitee-${slug}@example.test`,
        role: 'editor',
        tokenHash: createHash('sha256').update(slug).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        invitedBy: ownerId,
      },
    });
    return { scope, ownerId, projectId: project.id, contactId: contact.id, domainId: domain.id, hostname };
  });
}

/** Tables in schema `app` that carry a workspace_id column (auto-discovered, SRS 5.3 item 5). */
export async function tenantTables(admin: pg.Pool): Promise<string[]> {
  // pg_catalog, not information_schema: the latter only lists objects the current role has privileges on.
  const { rows } = await admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
  );
  return rows.map((r) => r.relname);
}

/**
 * Runs one statement as svc_definer (migrator holds SET on it, Spike B B-7) inside a rolled-back transaction:
 * how the tests reach table constraints that no application role can write directly any more (S6 domains).
 */
export async function asDefiner(migrator: pg.Pool, sql: string, params: unknown[] = []): Promise<void> {
  const client = await migrator.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE svc_definer');
    await client.query(sql, params);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
