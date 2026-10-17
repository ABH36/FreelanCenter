import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/client';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.SPIKE_B_LIVE_APP_URL;
const schema = process.env.SPIKE_B_LIVE_SCHEMA;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

if (!url || !schema) throw new Error('Live Prisma proof variables are missing');

const base = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
  transactionOptions: { maxWait: 20_000, timeout: 20_000 },
});

function forWorkspace(workspaceId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRawUnsafe(`SELECT set_config('app.workspace_id', '${workspaceId}', TRUE)`),
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

async function withWorkspace<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return base.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.workspace_id', '${workspaceId}', TRUE)`);
    return fn(tx);
  });
}

afterAll(() => base.$disconnect());

describe('live Supabase Prisma 7 adapter proof', () => {
  it('extension-scoped Prisma reads are isolated and base Prisma fails closed after reuse', async () => {
    const a = forWorkspace(A);
    const b = forWorkspace(B);
    expect(await a.project.count()).toBe(2);
    expect(await b.project.count()).toBe(1);
    await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? a : b).project.findMany()));
    const noContext = await Promise.all(Array.from({ length: 20 }, () => base.project.count()));
    expect(noContext.every((count) => count === 0)).toBe(true);
  });

  it('interactive Prisma transaction remains pinned and retains transaction-local context', async () => {
    const result = await withWorkspace(A, async (tx) => {
      const one = (
        await tx.$queryRawUnsafe<{ pid: number; workspace: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id', true) AS workspace",
        )
      )[0];
      await tx.project.findMany();
      const two = (
        await tx.$queryRawUnsafe<{ pid: number; workspace: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('app.workspace_id', true) AS workspace",
        )
      )[0];
      return { one, two };
    });
    expect(result.one?.pid).toBe(result.two?.pid);
    expect(result.one?.workspace).toBe(A);
    expect(result.two?.workspace).toBe(A);
  });

  it('400 concurrent Prisma extension/interactive operations have no tenant leak or error', async () => {
    const a = forWorkspace(A);
    const b = forWorkspace(B);
    let leaks = 0;
    let errors = 0;
    await Promise.all(
      Array.from({ length: 300 }, async (_, index) => {
        const workspaceId = index % 2 ? B : A;
        try {
          const rows = await (index % 2 ? b : a).project.findMany();
          const expected = workspaceId === A ? 2 : 1;
          if (rows.length !== expected || rows.some((row) => row.workspaceId !== workspaceId)) leaks += 1;
        } catch {
          errors += 1;
        }
      }),
    );
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const workspaceId = index % 2 ? B : A;
        try {
          const rows = await withWorkspace(workspaceId, (tx) => tx.project.findMany());
          const expected = workspaceId === A ? 2 : 1;
          if (rows.length !== expected || rows.some((row) => row.workspaceId !== workspaceId)) leaks += 1;
        } catch {
          errors += 1;
        }
      }),
    );
    expect({ leaks, errors, schema }).toEqual({ leaks: 0, errors: 0, schema });
  });
});
