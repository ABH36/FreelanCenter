/**
 * SPIKE B - proves (or disproves) the SRS Section 5.3 claims against a real Postgres 17 + PgBouncer
 * (transaction mode) + Prisma 7. Every assertion documents an observed fact; results are written to
 * results/spike-b-results.json for the Phase 0 report.
 *
 * Run:  pnpm spike:up && pnpm spike:generate && pnpm spike:test
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  forWorkspace,
  makeBaseClient,
  URL_APP,
  URL_APP_P1,
  URL_MIGRATOR,
  URL_PUBLIC,
  URL_SUPERUSER,
  withWorkspace,
  type BaseClient,
} from '../src/db';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PA = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003',
] as const;
const PB = ['b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002'] as const;

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const record = (key: string, value: unknown) => {
  results[key] = value;
};

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
const stats = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    meanMs: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2),
    p50Ms: +percentile(s, 0.5).toFixed(2),
    p95Ms: +percentile(s, 0.95).toFixed(2),
  };
};

async function withSuperuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: URL_SUPERUSER });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function reseed() {
  await withSuperuser(async (c) => {
    await c.query('TRUNCATE lead, domain, project, workspace CASCADE');
    await c.query(`INSERT INTO workspace (id, name) VALUES ('${A}', 'Workspace A'), ('${B}', 'Workspace B')`);
    for (const [i, id] of PA.entries())
      await c.query('INSERT INTO project (id, workspace_id, name) VALUES ($1, $2, $3)', [
        id,
        A,
        `A-project-${i + 1}`,
      ]);
    for (const [i, id] of PB.entries())
      await c.query('INSERT INTO project (id, workspace_id, name) VALUES ($1, $2, $3)', [
        id,
        B,
        `B-project-${i + 1}`,
      ]);
    for (let i = 0; i < 5; i++)
      await c.query('INSERT INTO lead (workspace_id, project_id, name) VALUES ($1, $2, $3)', [
        A,
        PA[0],
        `A-lead-${i}`,
      ]);
    for (let i = 0; i < 4; i++)
      await c.query('INSERT INTO lead (workspace_id, project_id, name) VALUES ($1, $2, $3)', [
        B,
        PB[0],
        `B-lead-${i}`,
      ]);
    await c.query(
      'INSERT INTO domain (workspace_id, project_id, hostname) VALUES ($1, $2, $3), ($4, $5, $6)',
      [A, PA[0], 'a.test', B, PB[0], 'b.test'],
    );
  });
}

let base: BaseClient;
let tuned: BaseClient;
let wsA: ReturnType<typeof forWorkspace>;
let wsB: ReturnType<typeof forWorkspace>;

beforeAll(async () => {
  base = makeBaseClient(URL_APP);
  tuned = makeBaseClient(URL_APP, true);
  wsA = forWorkspace(base, A);
  wsB = forWorkspace(base, B);
  await reseed();
});

afterAll(async () => {
  await base.$disconnect();
  await tuned.$disconnect();
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '../results/spike-b-results.json');
  mkdirSync(dirname(out), { recursive: true });
  results['finishedAt'] = new Date().toISOString();
  writeFileSync(out, JSON.stringify(results, null, 2));
});

describe('roles and table settings', () => {
  it('app roles are not superuser and cannot bypass RLS; RLS is enabled AND forced on every tenant table', async () => {
    const { roles, tables } = await withSuperuser(async (c) => ({
      roles: (
        await c.query(
          "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_user','app_public','migrator','svc_definer') ORDER BY 1",
        )
      ).rows,
      tables: (
        await c.query(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('workspace','project','lead','domain') ORDER BY 1",
        )
      ).rows,
    }));
    record('roles', roles);
    record('tables', tables);
    for (const r of roles) {
      expect(r.rolsuper, `${r.rolname} superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} bypassrls`).toBe(false);
    }
    for (const t of tables) {
      expect(t.relrowsecurity, `${t.relname} rls`).toBe(true);
      expect(t.relforcerowsecurity, `${t.relname} force`).toBe(true);
    }
  });
});

describe('isolation through the Prisma extension via transaction-mode PgBouncer', () => {
  it('each workspace sees only its own rows (including nested relation loads)', async () => {
    expect(await wsA.project.count()).toBe(3);
    expect(await wsB.project.count()).toBe(2);
    expect(await wsA.lead.count()).toBe(5);
    expect(await wsB.lead.count()).toBe(4);
    const nested = await wsA.project.findMany({ include: { leads: true } });
    for (const p of nested) {
      expect(p.workspaceId).toBe(A);
      for (const l of p.leads) expect(l.workspaceId).toBe(A);
    }
  });

  it('FAIL-CLOSED: a query with no tenant context returns zero rows, on fresh AND re-used connections', async () => {
    // warm every server connection with tenant-scoped work first
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? wsA : wsB).project.count()));
    const counts: number[] = [];
    for (let i = 0; i < 20; i++) counts.push(await base.project.count()); // base client = no context
    record('noContextCounts', counts);
    expect(counts.every((n) => n === 0)).toBe(true);
    // raw SQL on the extended client is not intercepted either -> also no context -> zero
    const raw = await wsA.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM project`;
    record('rawQueryOnExtendedClientCount', raw[0]?.n);
    expect(raw[0]?.n).toBe(0);
  });

  it('FINDING: the SRS 5.3 policy form current_setting(..., true)::uuid errors on re-used pooled connections', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? wsA : wsB).project.count()));
    let errors = 0;
    let firstMessage = '';
    for (let i = 0; i < 20; i++) {
      try {
        await base.$queryRawUnsafe("SELECT current_setting('app.workspace_id', true)::uuid AS x");
      } catch (e) {
        errors++;
        firstMessage ||= e instanceof Error ? e.message : String(e);
      }
    }
    record('naiveCastErrors', { errorsOutOf20: errors, firstMessage });
    // If this fails the finding is wrong and the SRS wording can stay; the NULLIF form is safe either way.
    expect(errors).toBeGreaterThan(0);
  });

  it('WITH CHECK: cannot write into another workspace, cannot move a row across workspaces', async () => {
    const insertOther = await wsA.project.create({ data: { workspaceId: B, name: 'smuggled' } }).then(
      () => 'ALLOWED',
      (e: Error) => e.message,
    );
    const moveAcross = await wsA.project.update({ where: { id: PA[0] }, data: { workspaceId: B } }).then(
      () => 'ALLOWED',
      (e: Error) => e.message,
    );
    record('writeAcrossTenants', { insertOther, moveAcross });
    expect(insertOther).not.toBe('ALLOWED');
    expect(moveAcross).not.toBe('ALLOWED');
  });

  it('cross-tenant UPDATE/DELETE by id touches nothing', async () => {
    const upd = await wsA.project.updateMany({ where: { id: PB[0] }, data: { name: 'hacked' } });
    const del = await wsA.project.deleteMany({ where: { id: PB[0] } });
    const name = await withSuperuser(
      async (c) => (await c.query('SELECT name FROM project WHERE id = $1', [PB[0]])).rows[0]?.name,
    );
    record('crossTenantMutation', { updated: upd.count, deleted: del.count, bStillNamed: name });
    expect(upd.count).toBe(0);
    expect(del.count).toBe(0);
    expect(name).toBe('B-project-1');
  });

  it('composite FK: a lead cannot reference another workspace project even with a valid own workspace_id', async () => {
    const msg = await wsA.lead.create({ data: { workspaceId: A, projectId: PB[0], name: 'cross-fk' } }).then(
      () => 'ALLOWED',
      (e: Error) => e.message,
    );
    record('compositeFk', msg);
    expect(msg).not.toBe('ALLOWED');
  });

  it('the table OWNER (migrator) is also constrained by FORCE RLS: no accidental reads', async () => {
    const c = new pg.Client({ connectionString: URL_MIGRATOR });
    await c.connect();
    const n = (await c.query('SELECT count(*)::int AS n FROM project')).rows[0].n;
    await c.end();
    record('ownerNoContextCount', n);
    expect(n).toBe(0);
  });
});

describe('transaction pinning and concurrency (the F-02 question)', () => {
  it('an interactive $transaction keeps ONE server connection and the tenant setting for its whole duration', async () => {
    const seen = await withWorkspace(base, A, async (tx) => {
      const p1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid;
      const s1 = (
        await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('app.workspace_id', true) AS s`
      )[0]?.s;
      await tx.project.findMany();
      const p2 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid;
      const s2 = (
        await tx.$queryRaw<{ s: string }[]>`SELECT current_setting('app.workspace_id', true) AS s`
      )[0]?.s;
      return { p1, p2, s1, s2 };
    });
    // outside a transaction the pooler is free to give each statement a different server connection
    const pids = new Set<number>();
    for (let i = 0; i < 30; i++)
      pids.add((await base.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? -1);
    record('txPinning', { ...seen, distinctServerPidsOutsideTx: pids.size });
    expect(seen.p1).toBe(seen.p2);
    expect(seen.s1).toBe(A);
    expect(seen.s2).toBe(A);
  });

  it('FINDING (backpressure): with DEFAULT Prisma settings a 300-wide burst can fail with a transaction-queue timeout', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) =>
        (i % 2 ? wsB : wsA).project.findMany({ include: { leads: true } }),
      ),
    );
    const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    const firstError =
      failed[0]?.reason instanceof Error ? failed[0].reason.message.split('\n').filter(Boolean).pop() : null;
    // timing-dependent by nature, so this is recorded, not asserted (an earlier run of the same burst passed)
    record('burstDefaultSettings', { operations: 300, failed: failed.length, firstError });
  });

  it('300 concurrent extension reads + 100 concurrent interactive transactions (tuned): zero cross-tenant leaks, zero errors', async () => {
    const tA = forWorkspace(tuned, A);
    const tB = forWorkspace(tuned, B);
    let leaks = 0;
    let errors = 0;
    await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        const ws = i % 2 ? B : A;
        try {
          const rows = await (i % 2 ? tB : tA).project.findMany({ include: { leads: true } });
          for (const p of rows) {
            if (p.workspaceId !== ws) leaks++;
            for (const l of p.leads) if (l.workspaceId !== ws) leaks++;
          }
          if (rows.length !== (ws === A ? 3 : 2)) leaks++;
        } catch {
          errors++;
        }
      }),
    );
    await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const ws = i % 3 ? B : A;
        try {
          const rows = await withWorkspace(tuned, ws, (tx) => tx.lead.findMany());
          for (const l of rows) if (l.workspaceId !== ws) leaks++;
          if (rows.length !== (ws === A ? 5 : 4)) leaks++;
        } catch {
          errors++;
        }
      }),
    );
    record('concurrencyTuned', { operations: 400, leaks, errors });
    expect(leaks).toBe(0);
    expect(errors).toBe(0);
  });

  it('latency overhead of the set_config wrapper (300 sequential findMany, take 5)', async () => {
    const time = async (fn: () => Promise<unknown>) => {
      const s: number[] = [];
      for (let i = 0; i < 300; i++) {
        const t = performance.now();
        await fn();
        s.push(performance.now() - t);
      }
      return stats(s);
    };
    await time(() => wsA.project.findMany({ take: 5 })); // warm-up
    const scoped = await time(() => wsA.project.findMany({ take: 5 }));
    const plain = await time(() => base.project.findMany({ take: 5 }));
    record('latency', { withTenantWrapper: scoped, withoutWrapperNoContext: plain });
    expect(scoped.n).toBe(300);
  });
});

describe('the anti-pattern the SRS forbids: session-level SET behind a transaction-mode pooler', () => {
  const zeroRowsWithoutContext = async () => {
    const c = new pg.Client({ connectionString: URL_APP_P1 });
    await c.connect();
    const n = (await c.query('SELECT count(*)::int AS n FROM project')).rows[0].n as number;
    await c.end();
    return n === 0;
  };

  it('a session-level SET leaks to a DIFFERENT client, and the no-context isolation check detects it', async () => {
    const guardBefore = await zeroRowsWithoutContext();
    const x = new pg.Client({ connectionString: URL_APP_P1 });
    await x.connect();
    await x.query(`SET app.workspace_id = '${A}'`); // WRONG: session-level, not transaction-local
    const y = new pg.Client({ connectionString: URL_APP_P1 }); // a different client, no context of its own
    await y.connect();
    const leakedRows = (await y.query('SELECT count(*)::int AS n FROM project')).rows[0].n as number;
    const guardDuringLeak = await zeroRowsWithoutContext();
    await x.query('RESET app.workspace_id');
    await x.end();
    await y.end();
    const guardAfterCleanup = await zeroRowsWithoutContext();
    record('sessionSetLeak', {
      guardBefore,
      leakedRowsSeenByOtherClient: leakedRows,
      guardDuringLeak,
      guardAfterCleanup,
    });
    expect(guardBefore).toBe(true);
    expect(leakedRows).toBe(3); // client Y saw workspace A's projects without ever setting a context
    expect(guardDuringLeak).toBe(false); // the "no context => zero rows" suite check FAILS, i.e. it catches the bug
    expect(guardAfterCleanup).toBe(true);
  });
});

describe('public (visitor) path: SECURITY DEFINER functions only', () => {
  beforeEach(reseed);

  const asPublic = async <T>(fn: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({ connectionString: URL_PUBLIC });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  it('resolve_host works with no tenant context; unknown host returns nothing', async () => {
    const [hit, miss] = await asPublic(async (c) => [
      (await c.query('SELECT * FROM resolve_host($1)', ['a.test'])).rows,
      (await c.query('SELECT * FROM resolve_host($1)', ['nope.test'])).rows,
    ]);
    record('resolveHost', { hit, missCount: miss.length });
    expect(hit).toEqual([{ workspace_id: A, project_id: PA[0] }]);
    expect(miss).toHaveLength(0);
  });

  it('app_public has NO direct table access', async () => {
    const attempts = await asPublic(async (c) => {
      const out: Record<string, string> = {};
      for (const t of ['domain', 'project', 'lead', 'workspace']) {
        out[t] = await c.query(`SELECT * FROM ${t}`).then(
          () => 'ALLOWED',
          (e: Error) => e.message,
        );
      }
      return out;
    });
    record('publicDirectAccess', attempts);
    for (const v of Object.values(attempts)) expect(v).toMatch(/permission denied/);
  });

  it('insert_lead derives workspace_id from the project: the lead lands in the right tenant only', async () => {
    const id = await asPublic(
      async (c) =>
        (await c.query('SELECT insert_lead($1, $2) AS id', [PA[1], 'visitor'])).rows[0].id as string | null,
    );
    const none = await asPublic(
      async (c) =>
        (await c.query('SELECT insert_lead($1, $2) AS id', ['ffffffff-ffff-4fff-8fff-ffffffffffff', 'ghost']))
          .rows[0].id as string | null,
    );
    const [a, b] = [await wsA.lead.count(), await wsB.lead.count()];
    record('publicInsertLead', {
      createdId: id,
      unknownProjectResult: none,
      workspaceALeads: a,
      workspaceBLeads: b,
    });
    expect(id).toBeTruthy();
    expect(none).toBeNull();
    expect(a).toBe(6);
    expect(b).toBe(4);
  });
});
