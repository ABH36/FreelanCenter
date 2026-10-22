/**
 * Read-only proof of the product Prisma client against a deployed database through its transaction pooler
 * (Supabase Supavisor, port 6543). Writes nothing. Run: `pnpm test:live` with DB URLs in .env.local.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConnectionRole,
  createAuthPrismaClient,
  createTenantDatabase,
  type TenantDatabase,
} from '../../src/client';
import { parseDotEnv } from '../../src/env';
import { uuidv7 } from '../../src/uuid';

const env = {
  ...parseDotEnv(readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8')),
  ...process.env,
};
let db: TenantDatabase;

beforeAll(() => {
  // Queue sized for the burst below; the 10 s default would correctly reject part of it over a real network.
  db = createTenantDatabase({
    connectionString: env.DATABASE_URL!,
    env,
    poolMax: 8,
    maxQueue: 1_000,
    queueTimeoutMs: 120_000,
  });
});
afterAll(() => db.disconnect());

describe('live Prisma client through the transaction pooler', () => {
  it('connects as app_user without SUPERUSER/BYPASSRLS', async () => {
    await expect(db.verifyRole()).resolves.toBeUndefined();
  });

  it('300 concurrent actor/tenant transactions keep their own context and see no foreign rows', async () => {
    const results = await Promise.all(
      Array.from({ length: 300 }, async () => {
        const actor = uuidv7();
        const started = performance.now();
        const ok = await db.withActor(actor, async (tx) => {
          const [ctx] = await tx.$queryRaw<Array<{ actor: string; ws: string }>>`
            SELECT current_setting('app.user_id') AS actor, current_setting('app.workspace_id') AS ws`;
          const visible =
            (await tx.membership.count()) + (await tx.workspace.count()) + (await tx.project.count());
          return ctx?.actor === actor && ctx?.ws === '' && visible === 0;
        });
        return { ok, ms: performance.now() - started };
      }),
    );
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    process.stdout.write(
      `live: 300 tx, p50 ${Math.round(ms[150]!)} ms, p95 ${Math.round(ms[285]!)} ms (includes queueing behind 8 connections)
`,
    );
    expect(await db.resolveTenantScope(uuidv7(), uuidv7())).toBeNull();
  });

  it('measures uncontended transaction latency and the network round trip', async () => {
    const tx: number[] = [];
    const rtt: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await db.withActor(uuidv7(), async (t) => {
        const q = performance.now();
        await t.$queryRaw`SELECT 1`;
        rtt.push(performance.now() - q);
        return t.membership.count();
      });
      tx.push(performance.now() - started);
    }
    const p50 = (xs: number[]) => Math.round([...xs].sort((a, b) => a - b)[10]!);
    process.stdout.write(`live: uncontended withActor p50 ${p50(tx)} ms; single round trip p50 ${p50(rtt)} ms
`);
    expect(tx.length).toBe(20);
  });

  it('the auth client connects as app_auth', async () => {
    const auth = createAuthPrismaClient({ connectionString: env.DATABASE_URL_AUTH!, env, poolMax: 2 });
    try {
      await assertConnectionRole(auth, 'app_auth');
      expect(await auth.user.count()).toBeGreaterThanOrEqual(0);
    } finally {
      await auth.$disconnect();
    }
  });
});
