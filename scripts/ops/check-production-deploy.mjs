// P3 S9a (DG-39 (a)): confirms that Vercel deployed a `main` commit to Production for both projects.
//
// On 2026-11-18 Vercel built nothing for the merge 23c2b0d (PR #104): no deployment and no commit status, while CI
// passed, and the production check first ran against the old build. Vercel's GitHub integration records each
// deployment as a GitHub Deployment ("Production – dashboard", "Production – sites") with a status; this script
// waits for a `success` status on both for the given commit and fails, with what to do next, when one fails or none
// appears in time. It only reads (the workflow's GITHUB_TOKEN with `deployments: read`): no Vercel token, no cost,
// and it never redeploys by itself (a redeploy needs the Owner's OK).
//
//   GH_TOKEN=... node scripts/ops/check-production-deploy.mjs --repo ABH36/FreelanCenter --sha <commit>
//     [--timeout-minutes 20] [--interval-seconds 30]
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENVIRONMENTS = ['Production – dashboard', 'Production – sites'];

/**
 * The state of one environment from its deployments for the commit (newest first, each with its statuses newest
 * first). A deployment that ever reached `success` counts, also when a later merge has since made it `inactive`.
 */
export function decide(deployments) {
  if (deployments.length === 0) return { state: 'missing', detail: 'no deployment yet' };
  for (const d of deployments) {
    if (d.statuses.some((s) => s.state === 'success'))
      return { state: 'ok', detail: d.statuses.find((s) => s.state === 'success').environment_url ?? '' };
  }
  const latest = deployments[0].statuses[0]?.state ?? 'pending';
  if (latest === 'failure' || latest === 'error') return { state: 'failed', detail: `status ${latest}` };
  return { state: 'pending', detail: `status ${latest}` };
}

function arg(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'production-deploy-check',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path.split('?')[0]}`);
  return response.json();
}

async function environmentState(repo, sha, environment, token) {
  const query = new URLSearchParams({ sha, environment, per_page: '10' });
  const deployments = await github(`/repos/${repo}/deployments?${query}`, token);
  const withStatuses = [];
  for (const d of deployments)
    withStatuses.push({
      statuses: await github(`/repos/${repo}/deployments/${d.id}/statuses?per_page=20`, token),
    });
  return decide(withStatuses);
}

async function main() {
  const args = process.argv.slice(2);
  const repo = arg(args, 'repo', process.env.GITHUB_REPOSITORY);
  const sha = arg(args, 'sha', process.env.GITHUB_SHA);
  const token = process.env.GH_TOKEN;
  const timeoutMs = Number(arg(args, 'timeout-minutes', '20')) * 60_000;
  const intervalMs = Number(arg(args, 'interval-seconds', '30')) * 1000;
  if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? '') || !token) {
    console.error('error: needs --repo, a full 40-character --sha and GH_TOKEN');
    process.exit(2);
  }

  const started = Date.now();
  let states = {};
  for (;;) {
    for (const env of ENVIRONMENTS)
      if (states[env]?.state !== 'ok') states[env] = await environmentState(repo, sha, env, token);
    const all = Object.values(states);
    const done = all.every((s) => s.state === 'ok') || all.some((s) => s.state === 'failed');
    if (done || Date.now() - started >= timeoutMs) break;
    console.log(ENVIRONMENTS.map((e) => `${e}: ${states[e].state}`).join(' · '));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const ok = ENVIRONMENTS.every((e) => states[e].state === 'ok');
  const lines = [
    `### Production deployment of ${sha.slice(0, 7)}`,
    '',
    '| Project | Result | Detail |',
    '| --- | --- | --- |',
    ...ENVIRONMENTS.map((e) => `| ${e} | ${states[e].state} | ${states[e].detail} |`),
    '',
    ok
      ? 'Both projects run this commit in Production.'
      : 'Production does not run this commit. Do not start a production check. Look at the project in Vercel; ' +
        'with the Owner’s OK, deploy `main` at this commit from Git (DG-39 (a), S8c report section 9).',
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
