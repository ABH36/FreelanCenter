/**
 * Tenant-scoped data access (SRS 5.3, ADR-003, Spike B / Spike F patterns).
 *
 * The raw PrismaClient for `app_user` is never exported. Every query runs inside one interactive transaction
 * that first sets the transaction-local context with `set_config(..., true)`:
 *   app.user_id       the authenticated actor (membership `self_select`, workspace `member_select`)
 *   app.workspace_id  the workspace, only after the actor's membership was verified server-side
 * A query outside these helpers cannot exist, and one with no context returns zero rows (fail closed).
 * Session-level `SET` is forbidden: it leaks across pooled connections (Spike B result 9).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import type { Logger } from '@platform/logger';
import { connectionConfig } from './connection';
import { InvalidScopeError, UnsafeRoleError } from './errors';
import { PrismaClient, type MemberRole, type Prisma } from './generated/client';
import { TransactionLimiter } from './limiter';
import { isUuid, uuidv7 } from './uuid';

export type Tx = Prisma.TransactionClient;

declare const tenantScopeBrand: unique symbol;

/**
 * Proof that the actor is a member of the workspace. Only `resolveTenantScope` and `withNewWorkspace` create
 * one, so a workspace id from a browser cannot reach `withTenant` without a membership check (FR-AUTH-08).
 */
export interface TenantScope {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly role: MemberRole;
  /** false while the workspace is suspended or scheduled for deletion: RLS then rejects writes (FR-WS-04). */
  readonly writable: boolean;
  readonly [tenantScopeBrand]: true;
}

export interface PoolOptions {
  connectionString: string;
  /** Client-side pool size (Spike B B-3: explicit, never the driver default). Default 10. */
  poolMax?: number;
  /** Prisma interactive-transaction timeout. Default 15 s. */
  transactionTimeoutMs?: number;
  /** Prisma wait for a pooled connection once admitted by the limiter. Default 5 s. */
  connectionWaitMs?: number;
  /** Variables used to resolve TLS settings (`DATABASE_SSL_ROOT_CERT`). Default `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface TenantDatabaseOptions extends PoolOptions {
  /** Waiting transactions beyond this are rejected with DbBusyError. Default 500. */
  maxQueue?: number;
  /** Queue wait before DbBusyError. Default 10 s. */
  queueTimeoutMs?: number;
  /** Per-transaction `statement_timeout`. Default 10 s; must be below the transaction timeout. */
  statementTimeoutMs?: number;
  /** Transactions slower than this are logged as warnings with their workspace id. Default 1 s. */
  slowTransactionMs?: number;
  logger?: Logger;
}

export interface TenantDatabase {
  /** Actor-only context: lists the actor's own memberships and workspaces, nothing else. */
  withActor<T>(actorUserId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Verifies membership and returns a scope, or null when the actor is not a member (treat as 404). */
  resolveTenantScope(actorUserId: string, workspaceId: string): Promise<TenantScope | null>;
  /** One request-scoped transaction under workspace RLS (prefer one per request: Spike B B-4). */
  withTenant<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Context for creating a workspace: a fresh server-generated id. The callback must insert the workspace
   * and the actor's owner membership; nothing else can reference an id that does not exist yet.
   */
  withNewWorkspace<T>(actorUserId: string, fn: (tx: Tx, scope: TenantScope) => Promise<T>): Promise<T>;
  /**
   * Workspace context with no actor, for background jobs only (ADR-007): the id comes from a signed, ids-only
   * event this platform emitted after an authorized command, never from a browser. With no actor,
   * `app.current_member_role()` is NULL, so every role-gated write (memberships, invitations, workspace
   * settings) is refused by RLS; reads and audit appends work. ESLint confines callers to job handlers.
   */
  withJobTenant<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * No context at all (no workspace, no actor), for the outbox sweep only: every tenant policy returns nothing,
   * and the one function that answers in this context, `app.outbox_pending()`, returns event ids and their
   * workspace ids. ESLint confines callers to packages/workspaces/src/outbox.ts.
   */
  withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Fails unless the connection role is `expectedRole` and has neither SUPERUSER nor BYPASSRLS. */
  verifyRole(expectedRole?: string): Promise<void>;
  readonly stats: { active: number; queued: number };
  disconnect(): Promise<void>;
}

const DEFAULTS = {
  poolMax: 10,
  transactionTimeoutMs: 15_000,
  connectionWaitMs: 5_000,
  maxQueue: 500,
  queueTimeoutMs: 10_000,
  statementTimeoutMs: 10_000,
  slowTransactionMs: 1_000,
};

/** A Prisma client with an explicit pool and transaction options. Internal: use the role-specific factories. */
export function createPrismaClient(options: PoolOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      ...connectionConfig(options.connectionString, options.env),
      max: options.poolMax ?? DEFAULTS.poolMax,
    }),
    transactionOptions: {
      maxWait: options.connectionWaitMs ?? DEFAULTS.connectionWaitMs,
      timeout: options.transactionTimeoutMs ?? DEFAULTS.transactionTimeoutMs,
    },
  });
}

export async function assertConnectionRole(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  expectedRole: string,
): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ usr: string; su: boolean; bypass: boolean }>>`
    SELECT current_user AS usr, rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  if (!row || row.usr !== expectedRole) {
    throw new UnsafeRoleError(
      `database connection must use role ${expectedRole}, got ${row?.usr ?? 'unknown'}`,
    );
  }
  if (row.su || row.bypass) throw new UnsafeRoleError(`role ${row.usr} must not be SUPERUSER or BYPASSRLS`);
}

/**
 * A once-per-process start-up check that remembers success only. A failure is reported and forgotten, so the next
 * caller runs the check again: a transient failure must not break the instance until it is recycled (S8-9, a
 * serverless function frozen in the middle of its first connection). A wrong role still fails every call.
 */
export function onceUntilSuccess(
  check: () => Promise<void>,
  onFailure?: (error: unknown) => void,
): () => Promise<void> {
  let passed: Promise<void> | null = null;
  return () =>
    (passed ??= check().catch((error: unknown) => {
      passed = null;
      onFailure?.(error);
      throw error;
    }));
}

/** The `app_user` data-access layer. One instance per process. */
export function createTenantDatabase(options: TenantDatabaseOptions): TenantDatabase {
  const poolMax = options.poolMax ?? DEFAULTS.poolMax;
  const transactionTimeoutMs = options.transactionTimeoutMs ?? DEFAULTS.transactionTimeoutMs;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs;
  if (statementTimeoutMs >= transactionTimeoutMs) {
    throw new RangeError('statementTimeoutMs must be lower than transactionTimeoutMs');
  }
  const slowMs = options.slowTransactionMs ?? DEFAULTS.slowTransactionMs;
  const prisma = createPrismaClient({ ...options, poolMax, transactionTimeoutMs });
  const limiter = new TransactionLimiter({
    concurrency: poolMax,
    maxQueue: options.maxQueue ?? DEFAULTS.maxQueue,
    queueTimeoutMs: options.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs,
  });
  const statementTimeout = `${statementTimeoutMs}ms`;

  function run<T>(workspaceId: string, actorUserId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return limiter.run(async () => {
      const started = performance.now();
      try {
        return await prisma.$transaction(async (tx) => {
          // One round trip; every value is transaction-local (third argument true).
          await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true),
                                      set_config('app.user_id', ${actorUserId}, true),
                                      set_config('statement_timeout', ${statementTimeout}, true)`;
          return fn(tx);
        });
      } finally {
        const durationMs = Math.round(performance.now() - started);
        if (durationMs >= slowMs) {
          options.logger?.warn('db.transaction.slow', { durationMs, workspaceId: workspaceId || null });
        }
      }
    });
  }

  function requireUuid(value: string, field: string): void {
    if (!isUuid(value)) throw new InvalidScopeError(field);
  }

  function makeScope(fields: Omit<TenantScope, typeof tenantScopeBrand>): TenantScope {
    return Object.freeze({ ...fields }) as TenantScope;
  }

  return {
    // async: validation failures surface as rejected promises, like every other failure.
    async withActor(actorUserId, fn) {
      requireUuid(actorUserId, 'actorUserId');
      return run('', actorUserId, fn);
    },

    async resolveTenantScope(actorUserId, workspaceId) {
      requireUuid(actorUserId, 'actorUserId');
      requireUuid(workspaceId, 'workspaceId');
      const membership = await run('', actorUserId, (tx) =>
        tx.membership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
          select: { role: true, workspace: { select: { status: true, deletedAt: true } } },
        }),
      );
      if (!membership) return null;
      return makeScope({
        workspaceId,
        actorUserId,
        role: membership.role,
        writable: membership.workspace.status === 'active' && membership.workspace.deletedAt === null,
      });
    },

    async withTenant(scope, fn) {
      requireUuid(scope.workspaceId, 'workspaceId');
      requireUuid(scope.actorUserId, 'actorUserId');
      return run(scope.workspaceId, scope.actorUserId, fn);
    },

    async withNewWorkspace(actorUserId, fn) {
      requireUuid(actorUserId, 'actorUserId');
      const scope = makeScope({ workspaceId: uuidv7(), actorUserId, role: 'owner', writable: true });
      return run(scope.workspaceId, actorUserId, (tx) => fn(tx, scope));
    },

    async withJobTenant(workspaceId, fn) {
      requireUuid(workspaceId, 'workspaceId');
      return run(workspaceId, '', fn);
    },

    async withSystem(fn) {
      return run('', '', fn);
    },

    verifyRole(expectedRole = 'app_user') {
      return assertConnectionRole(prisma, expectedRole);
    },

    get stats() {
      return limiter.stats;
    },

    disconnect() {
      return prisma.$disconnect();
    },
  };
}

/**
 * The `app_auth` client for Better Auth (ADR-006): identity schema only, no tenant context. Call
 * `assertConnectionRole(client, 'app_auth')` at start-up.
 */
export function createAuthPrismaClient(options: PoolOptions): PrismaClient {
  return createPrismaClient(options);
}
