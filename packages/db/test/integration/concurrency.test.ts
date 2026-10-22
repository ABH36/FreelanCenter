/**
 * Pooled-connection behaviour of the product client (SRS 5.3 item 3, Spike B results 7-9, findings B-3/B-4).
 * PgBouncer runs with pool_size 4, so server connections are reused constantly across tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Logger } from '@platform/logger';
import { type TenantDatabase } from '../../src/client';
import { DbBusyError } from '../../src/errors';
import { pool, seedWorkspace, tenantDb, urls, type SeededWorkspace } from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let A: SeededWorkspace;
let B: SeededWorkspace;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth);
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
});
afterAll(async () => {
  await db.disconnect();
  await auth.end();
});

describe('transaction pinning', () => {
  it('one withTenant call keeps one backend and its context across statements', async () => {
    const [first, second] = await db.withTenant(A.scope, async (tx) => {
      const one = await tx.$queryRaw<
        Array<{ pid: number; ws: string }>
      >`SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id') AS ws`;
      await tx.project.count();
      const two = await tx.$queryRaw<
        Array<{ pid: number; ws: string }>
      >`SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id') AS ws`;
      return [one[0]!, two[0]!];
    });
    expect(second.pid).toBe(first.pid);
    expect([first.ws, second.ws]).toEqual([A.scope.workspaceId, A.scope.workspaceId]);
  });
});

describe('no context leakage under concurrency', () => {
  it('600 interleaved tenant transactions: 0 leaks, 0 errors', async () => {
    // Queue sized for the whole burst; the default (500) would reject the excess by design (next block).
    const burst = tenantDb({ maxQueue: 1_000, queueTimeoutMs: 60_000 });
    const scopes = [A.scope, B.scope];
    const results = await Promise.allSettled(
      Array.from({ length: 600 }, (_, i) => {
        const scope = scopes[i % 2]!;
        return burst.withTenant(scope, async (tx) => {
          const [ctx] = await tx.$queryRaw<Array<{ ws: string; actor: string }>>`
            SELECT current_setting('app.workspace_id') AS ws, current_setting('app.user_id') AS actor`;
          const projects = await tx.project.findMany({ select: { workspaceId: true }, take: 5 });
          const domains = await tx.domain.findMany({ select: { workspaceId: true } });
          const leaked =
            ctx?.ws !== scope.workspaceId ||
            ctx?.actor !== scope.actorUserId ||
            [...projects, ...domains].some((row) => row.workspaceId !== scope.workspaceId);
          return { leaked, rows: projects.length + domains.length };
        });
      }),
    );
    const errors = results.filter((r) => r.status === 'rejected');
    const values = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(errors).toEqual([]);
    expect(values.filter((v) => v.leaked)).toEqual([]);
    expect(values.every((v) => v.rows > 0)).toBe(true);
    expect(burst.stats).toEqual({ active: 0, queued: 0 });
    await burst.disconnect();
  });

  it('after the burst, a context-free query on every reused connection still sees nothing', async () => {
    const raw = pool(urls.app, 4);
    try {
      const counts = await Promise.all(
        Array.from({ length: 40 }, () =>
          raw.query<{ n: number }>('SELECT count(*)::int AS n FROM app.projects'),
        ),
      );
      expect(counts.map((c) => c.rows[0]?.n)).toEqual(Array(40).fill(0));
    } finally {
      await raw.end();
    }
  });
});

describe('backpressure (Spike B B-3)', () => {
  it('overload is rejected fast with DbBusyError instead of random Prisma timeouts', async () => {
    const small = tenantDb({ poolMax: 2, maxQueue: 10, queueTimeoutMs: 5_000 });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 60 }, () =>
          small.withTenant(A.scope, (tx) => tx.$executeRaw`SELECT pg_sleep(0.05)`),
        ),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.every((r) => r.reason instanceof DbBusyError)).toBe(true);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(12);
    } finally {
      await small.disconnect();
    }
  });

  it('a runaway statement is cancelled by the per-transaction statement_timeout', async () => {
    const strict = tenantDb({ poolMax: 1, statementTimeoutMs: 200, transactionTimeoutMs: 5_000 });
    try {
      await expect(strict.withTenant(A.scope, (tx) => tx.$executeRaw`SELECT pg_sleep(3)`)).rejects.toThrow(
        /57014|statement timeout/i,
      );
      // The connection is healthy afterwards and the timeout did not leak into the next transaction.
      const [row] = await strict.withTenant(
        A.scope,
        (tx) => tx.$queryRaw<Array<{ t: string }>>`SELECT current_setting('statement_timeout') AS t`,
      );
      expect(row?.t).toBe('200ms');
    } finally {
      await strict.disconnect();
    }
  });

  it('rejects a statement timeout that is not below the transaction timeout', () => {
    expect(() => tenantDb({ statementTimeoutMs: 5_000, transactionTimeoutMs: 5_000 })).toThrow(RangeError);
  });

  it('logs slow transactions with the workspace id and nothing else sensitive', async () => {
    const entries: Array<[string, unknown]> = [];
    const logger = {
      warn: (message: string, data?: unknown) => void entries.push([message, data]),
    } as unknown as Logger;
    const slow = tenantDb({ poolMax: 1, slowTransactionMs: 10, logger });
    try {
      await slow.withTenant(A.scope, (tx) => tx.$executeRaw`SELECT pg_sleep(0.03)`);
      await slow.withActor(A.ownerId, (tx) => tx.$executeRaw`SELECT pg_sleep(0.03)`);
    } finally {
      await slow.disconnect();
    }
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual([
      'db.transaction.slow',
      { durationMs: expect.any(Number), workspaceId: A.scope.workspaceId },
    ]);
    expect(entries[1]).toEqual([
      'db.transaction.slow',
      { durationMs: expect.any(Number), workspaceId: null },
    ]);
  });
});

describe('anti-pattern detection (Spike B result 9)', () => {
  it('a session-level SET leaks to the next client, and the fail-closed check catches it', async () => {
    // One server connection behind PgBouncer: whatever one client leaves on it, the next client inherits.
    const single = pool(urls.appSinglePool, 1);
    try {
      await single.query(`SELECT set_config('app.workspace_id', $1, false)`, [A.scope.workspaceId]); // the bug
      const leaked = await single.query<{ n: number }>('SELECT count(*)::int AS n FROM app.projects');
      expect(leaked.rows[0]?.n).toBeGreaterThan(0); // the no-context check flips: this is what the suite catches
    } finally {
      await single.query('RESET app.workspace_id');
      const clean = await single.query<{ n: number }>('SELECT count(*)::int AS n FROM app.projects');
      expect(clean.rows[0]?.n).toBe(0);
      await single.end();
    }
  });
});
