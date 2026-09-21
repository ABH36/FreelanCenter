/**
 * SPIKE B - tenant-scoped Prisma clients (disposable; the real implementation lands in Phase 1, packages/db).
 * Both patterns keep the tenant id in a TRANSACTION-LOCAL GUC (`set_config(..., true)`), which is the only
 * variant that is safe behind a transaction-mode pooler.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/client';

export const URL_SUPERUSER = 'postgresql://postgres:postgres@localhost:55432/spike'; // seeding + assertions only
export const URL_APP = 'postgresql://app_user:app_pw@localhost:56432/spike'; // via PgBouncer, pool_size=2
export const URL_APP_P1 = 'postgresql://app_user:app_pw@localhost:56432/spike_p1'; // via PgBouncer, pool_size=1
export const URL_PUBLIC = 'postgresql://app_public:public_pw@localhost:56432/spike';
export const URL_MIGRATOR = 'postgresql://migrator:migrator_pw@localhost:56432/spike';

/**
 * `tuned` raises the transaction queue wait/timeout. Prisma defaults (maxWait 2s, timeout 5s) make bursts larger than
 * the client-side pool (pg default max 10) fail with "Unable to start a transaction in the given time".
 */
export function makeBaseClient(url: string = URL_APP, tuned = false) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    ...(tuned ? { transactionOptions: { maxWait: 20_000, timeout: 20_000 } } : {}),
  });
}
export type BaseClient = ReturnType<typeof makeBaseClient>;

/**
 * Pattern 1 - client extension. Every model operation is executed as a batch transaction:
 *   BEGIN; SELECT set_config('app.workspace_id', $1, true); <the query>; COMMIT;
 * Raw SQL ($queryRaw/$executeRaw) is NOT intercepted and therefore runs with no tenant context (fail-closed).
 */
export function forWorkspace(base: BaseClient, workspaceId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/** Pattern 2 - explicit interactive transaction, for service-layer code that needs several statements. */
export function withWorkspace<T>(
  base: BaseClient,
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, TRUE)`;
    return fn(tx);
  });
}
