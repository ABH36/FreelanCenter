/**
 * Integration-test fixtures. Every connection uses the role it would use in production; the only privileged one
 * is `platform_admin`, the local stand-in for Supabase's operator role, used for catalog inspection only.
 * Run against the Docker stack: `pnpm db:setup && pnpm test:integration`.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createTenantDatabase, type TenantDatabase, type TenantScope } from '../../src/client';
import { LOCAL_DATABASE_URLS } from '../../src/env';
import { uuidv7 } from '../../src/uuid';

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
  const hostname = `${slug}.sites.test`;
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
    const domain = await tx.domain.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: project.id,
        hostname,
        type: 'subdomain',
        status: 'active',
        activatedAt: new Date(),
      },
    });
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

/** Every SQLSTATE found on an error from `pg` or Prisma (driver-adapter errors nest it under meta/cause). */
export function sqlStates(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found: string[] = [];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = (error as Record<string, unknown>)[key];
    if (
      (key === 'code' || key === 'originalCode') &&
      typeof value === 'string' &&
      /^[0-9A-Z]{5}$/.test(value)
    ) {
      found.push(value);
    } else if (typeof value === 'string') {
      for (const m of value.matchAll(/\b(?:Code: `|code: |SQLSTATE )([0-9A-Z]{5})\b/g))
        found.push(m[1] as string);
    } else if (value && typeof value === 'object') {
      found.push(...sqlStates(value, seen));
    }
  }
  return found;
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const states = sqlStates(error);
    if (states.includes(code)) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`expected SQLSTATE ${code}, got [${states.join(', ')}]: ${message}`, { cause: error });
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}
