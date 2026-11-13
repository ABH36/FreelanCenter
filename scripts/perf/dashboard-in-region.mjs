// NFR-PERF-04 in region (DG-28, P3 S0; DASHBOARD_GO_LIVE_PLAN.md §3.2.5): the harness shape of
// packages/workspaces/test/perf (CLIENTS concurrent clients, 500 ms p95 budget) run against the deployed dashboard.
// Read-only pages only; nothing in the live data changes. Two numbers per route:
//   client p95  full page time as this machine sees it (network + server), next to a /api/health round-trip baseline;
//   server p95  per request, the span of the server's own work (session, workspace, service calls) from the
//               `perf.server` log lines that requests carrying `x-perf-request` produce (apps/dashboard/lib/perf.ts).
// The budget applies to the server number, as in the local harness (service calls, no browser network).
//
// The session is the Owner's: they put the value of the `__Secure-better-auth.session_token` cookie into
// .env.local as PERF_SESSION_COOKIE themselves, and sign out afterwards, which revokes it. It is never printed.
//
//   node scripts/perf/dashboard-in-region.mjs --slug <workspace-slug> --deployment <dpl_id> [--clients 10] [--rounds 10]
//        [--out report.json]
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const P95_BUDGET_MS = 500;
const COOKIE_NAME = '__Secure-better-auth.session_token';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const origin = arg('origin', 'https://dashboard-liard-tau-14.vercel.app');
const slug = arg('slug');
const deployment = arg('deployment');
const CLIENTS = Number(arg('clients', 10));
const ROUNDS = Number(arg('rounds', 20));
const out = arg('out');
if (!slug || !/^[a-z0-9-]+$/.test(slug)) fail('pass --slug <workspace-slug>');
if (!deployment) fail('pass --deployment <dpl_id> (the deployment whose logs hold the server timings)');

const local = {};
for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) local[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const session = local.PERF_SESSION_COOKIE;
if (!session) fail('PERF_SESSION_COOKIE is missing in .env.local');
const cookie = `${COOKIE_NAME}=${session.startsWith(`${COOKIE_NAME}=`) ? session.slice(COOKIE_NAME.length + 1) : session}`;

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;
}
const round1 = (n) => Math.round(n * 10) / 10;
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: round1(percentile(s, 50)),
    p95: round1(percentile(s, 95)),
    max: round1(s.at(-1) ?? NaN),
  };
}

async function get(pathname, perfId) {
  const headers = { cookie, 'user-agent': 'freelancenter-perf-s0' };
  if (perfId) headers['x-perf-request'] = perfId;
  const start = performance.now();
  const res = await fetch(`${origin}${pathname}`, { headers, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, ms: performance.now() - start, body };
}

// Preflight: the session works and the workspace has a project to open.
const pre = await get(`/w/${slug}/projects?status=all`);
if (pre.status !== 200) fail(`projects page answered ${pre.status} (session expired or wrong slug?)`);
const projectId = new RegExp(`/w/${slug}/projects/([0-9a-f-]{36})`).exec(pre.body)?.[1];
if (!projectId) fail('no project link found on the projects page');

const routes = {
  overview: `/w/${slug}`,
  'projects list': `/w/${slug}/projects`,
  'projects search': `/w/${slug}/projects?q=a`,
  'projects filter': `/w/${slug}/projects?status=all&category=gym`,
  'project page': `/w/${slug}/projects/${projectId}`,
  notifications: `/w/${slug}/notifications`,
  'audit log': `/w/${slug}/audit`,
};

// Network baseline: the health endpoint does no database or session work.
const health = [];
for (let i = 0; i < 30; i++) health.push((await get('/api/health')).ms);

// Warm-up (not measured): CLIENTS concurrent passes, so the platform has scaled out to the measured concurrency and
// instance cold starts (new function instance, first pooled connections) are not counted as page time. A single
// sequential pass warmed one instance only, and the burst then put cold-start time into the first seconds (S0 run 2).
await Promise.all(
  Array.from({ length: CLIENTS }, async () => {
    for (let pass = 0; pass < 2; pass++) for (const p of Object.values(routes)) await get(p);
  }),
);

const runId = `s0-${Date.now().toString(36)}`;
const runStart = new Date(Date.now() - 60_000).toISOString();
const samples = []; // { route, perfId, status, ms }
let seq = 0;
await Promise.all(
  Array.from({ length: CLIENTS }, async () => {
    for (let r = 0; r < ROUNDS; r++) {
      for (const [route, p] of Object.entries(routes)) {
        const perfId = `${runId}-${(seq++).toString(36)}-${randomUUID().slice(0, 8)}`;
        const res = await get(p, perfId);
        samples.push({ route, perfId, status: res.status, ms: res.ms });
      }
    }
  }),
);
const bad = samples.filter((s) => s.status !== 200);
console.log(`run ${runId}: ${samples.length} requests, ${bad.length} not 200`);

// Server timings: read this run's perf.server lines from the deployment's runtime logs.
function vercelLogs(extra) {
  const r = spawnSync(
    'vercel',
    ['logs', '--deployment', deployment, '--since', runStart, '--json', '--limit', '10000', ...extra],
    {
      cwd: path.join(root, 'apps/dashboard'),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  );
  return r.stdout ?? '';
}
await new Promise((resolve) => setTimeout(resolve, 20_000)); // log ingestion delay
const ops = new Map(); // perfId -> [{ op, startedAt, ms }]
let cursor = null;
for (let page = 0; page < 20; page++) {
  const text = vercelLogs(cursor ? ['--next', cursor] : []);
  cursor = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'summary') cursor = rec.pagination?.hasMore ? rec.pagination.next : null;
    if (rec.type !== 'log' || !rec.data?.message?.includes('perf.server')) continue;
    let entry;
    try {
      entry = JSON.parse(rec.data.message);
    } catch {
      continue;
    }
    const d = entry.data;
    if (entry.message !== 'perf.server' || !d?.perfRequest?.startsWith(runId)) continue;
    if (!ops.has(d.perfRequest)) ops.set(d.perfRequest, []);
    ops.get(d.perfRequest).push({ op: d.op, startedAt: d.startedAt, ms: d.ms });
  }
  if (!cursor) break;
}

const report = {
  runId,
  origin,
  slug,
  clients: CLIENTS,
  rounds: ROUNDS,
  budgetMs: P95_BUDGET_MS,
  at: new Date().toISOString(),
};
report.healthBaseline = stats(health);
report.routes = {};
let pass = true;
for (const route of Object.keys(routes)) {
  const mine = samples.filter((s) => s.route === route && s.status === 200);
  const server = mine
    .map((s) => ops.get(s.perfId))
    .filter(Boolean)
    .map(
      (list) => Math.max(...list.map((o) => o.startedAt + o.ms)) - Math.min(...list.map((o) => o.startedAt)),
    );
  const row = {
    client: stats(mine.map((s) => s.ms)),
    server: stats(server),
    serverCoverage: `${server.length}/${mine.length}`,
  };
  row.withinBudget = row.server.p95 <= P95_BUDGET_MS;
  if (!row.withinBudget || server.length < mine.length * 0.9) pass = false;
  report.routes[route] = row;
}
report.pass = pass && bad.length === 0;

console.log(`health RTT baseline: p50 ${report.healthBaseline.p50} ms, p95 ${report.healthBaseline.p95} ms`);
console.log(
  'route'.padEnd(18),
  'client p50/p95'.padEnd(18),
  'server p50/p95'.padEnd(18),
  'server lines',
  'budget',
);
for (const [route, row] of Object.entries(report.routes)) {
  console.log(
    route.padEnd(18),
    `${row.client.p50} / ${row.client.p95}`.padEnd(18),
    `${row.server.p50} / ${row.server.p95}`.padEnd(18),
    row.serverCoverage.padEnd(12),
    row.withinBudget ? 'ok' : 'OVER',
  );
}
console.log(report.pass ? 'PASS' : 'FAIL');
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.pass ? 0 : 1);
