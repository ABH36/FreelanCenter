/**
 * NFR-PERF-04 (dashboard API p95 <= 500 ms, excluding AI), measured on the S6 service calls a dashboard request
 * makes: the project list (default, search, filter, next page), the project page, a transition, a create, the
 * inbox and unread count, and the audit page. One workspace holds SEEDED projects; CLIENTS concurrent clients
 * each run ROUNDS rounds. Every timing is a full service call (scope check + RLS transaction(s)) through
 * PgBouncer, which is what a server action or page loader does; network to the browser is not included.
 *
 *   pnpm --filter @platform/workspaces test:perf      (local Docker stack; writes test/perf/report.json)
 */
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectStatus } from '../../src/lifecycle';
import { createOutbox } from '../../src/outbox';
import { createProjectService } from '../../src/projects';
import { audit, closeAll, db, jobs, notifications, workspaceWith } from '../harness';

// As in the dashboard, the outbox dispatch runs after the response (Next after()); it is still executed here,
// concurrently, so its database load is part of the run. The 100-per-day abuse limit would stop the seeding;
// everything else is the production service.
const background: Array<Promise<void>> = [];
const outbox = createOutbox({ db, jobs: jobs.emitter, defer: (task) => void background.push(task()) });
const projects = createProjectService({ db, outbox, createsPerDay: 1_000_000 });

const SEEDED = Number(process.env.PERF_PROJECTS ?? 1000);
const CLIENTS = Number(process.env.PERF_CLIENTS ?? 10);
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 20);
const P95_BUDGET_MS = 500;

afterAll(closeAll);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe('NFR-PERF-04: dashboard API p95', () => {
  it(`p95 <= ${P95_BUDGET_MS} ms per operation with ${CLIENTS} concurrent clients`, async () => {
    const ws = await workspaceWith(['admin', 'editor']);
    const owner = ws.owner.id;
    const editor = ws.members.editor!.id;
    // Seed in parallel batches (creation itself is measured separately below).
    const ids: string[] = [];
    for (let i = 0; i < SEEDED; i += 20) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(20, SEEDED - i) }, (_, j) =>
          projects.createProject(owner, {
            workspaceId: ws.id,
            requestKey: crypto.randomUUID(),
            name: `Perf ${i + j} ${['Gym', 'Taxi', 'Salon', 'Clinic'][(i + j) % 4]}`,
            category: ['gym', 'taxi', 'salon', 'clinic'][(i + j) % 4],
            city: ['Pune', 'Jaipur', 'Indore', 'Surat'][(i + j) % 4],
          }),
        ),
      );
      ids.push(...batch.map((b) => b.id));
    }

    const timings: Record<string, number[]> = {};
    async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        (timings[name] ??= []).push(performance.now() - start);
      }
    }

    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, client) => {
        for (let round = 0; round < ROUNDS; round++) {
          const page = await timed('listProjects', () => projects.listProjects(owner, ws.id));
          await timed('listProjects (search)', () => projects.listProjects(owner, ws.id, { q: 'salon' }));
          await timed('listProjects (filter)', () =>
            projects.listProjects(owner, ws.id, { status: 'draft', category: 'gym' }),
          );
          await timed('listProjects (next page)', () =>
            projects.listProjects(owner, ws.id, { cursor: page.nextCursor }),
          );
          const id = ids[(client * ROUNDS + round) % ids.length]!;
          await timed('getProject', () => projects.getProject(owner, ws.id, id));
          // Each client walks its own projects back and forth: draft <-> in_review.
          const own = ids[client * ROUNDS + round]!;
          const from: ProjectStatus = 'draft';
          await timed('transitionProject', () =>
            projects.transitionProject(editor, { workspaceId: ws.id, projectId: own, from, to: 'in_review' }),
          );
          await timed('createProject', () =>
            projects.createProject(editor, {
              workspaceId: ws.id,
              requestKey: crypto.randomUUID(),
              name: `Perf new ${client}-${round}`,
            }),
          );
          await timed('unreadCount', () => notifications.unreadCount(owner, ws.id));
          await timed('listNotifications', () => notifications.listNotifications(owner, ws.id));
          await timed('listAuditLog', () => audit.listAuditLog(owner, ws.id));
        }
      }),
    );

    await Promise.all(background);
    const report = Object.fromEntries(
      Object.entries(timings).map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return [
          name,
          {
            n: sorted.length,
            p50: Math.round(percentile(sorted, 50)),
            p95: Math.round(percentile(sorted, 95)),
            p99: Math.round(percentile(sorted, 99)),
            max: Math.round(sorted.at(-1)!),
          },
        ];
      }),
    );
    const summary = {
      seededProjects: SEEDED,
      clients: CLIENTS,
      rounds: ROUNDS,
      budgetMs: P95_BUDGET_MS,
      report,
    };
    writeFileSync(new URL('./report.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const [name, r] of Object.entries(report))
      expect([name, r.p95 <= P95_BUDGET_MS]).toEqual([name, true]);
  });
});
