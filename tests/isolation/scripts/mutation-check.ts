/**
 * Mutation check: proves the isolation suite is not vacuous (SEC-02). Each mutation re-introduces one class of
 * isolation bug as `migrator` on the LOCAL Docker database, runs the suite, requires the named test(s) to fail,
 * and always reverts the mutation. Exit code 1 when a mutation survives or a revert fails.
 *
 *   pnpm --filter @platform/isolation-tests test:mutation
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LOCAL_DATABASE_URLS, isLocalHost } from '../../../packages/db/src/env.ts';

interface Mutation {
  name: string;
  apply: string;
  revert: string;
  /** Substrings of the full test names that must fail. */
  mustFail: string[];
}

const MUTATIONS: Mutation[] = [
  {
    name: 'new tenant table without a row factory',
    apply: 'CREATE TABLE app.mutation_probe (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)',
    revert: 'DROP TABLE app.mutation_probe',
    mustFail: ['every relation with a workspace_id column has a row factory'],
  },
  {
    name: 'permissive SELECT policy (cross-tenant read)',
    apply: 'CREATE POLICY mutation ON app.projects FOR SELECT TO app_user USING (true)',
    revert: 'DROP POLICY mutation ON app.projects',
    mustFail: [
      'app.projects SELECT: B row is invisible',
      'IDOR: Prisma model operations by id, workspace A against workspace B projects',
    ],
  },
  {
    name: 'permissive UPDATE policy (blind cross-tenant write)',
    apply: 'CREATE POLICY mutation ON app.projects FOR UPDATE TO app_user USING (true) WITH CHECK (true)',
    revert: 'DROP POLICY mutation ON app.projects',
    mustFail: ['app.projects UPDATE:'],
  },
  {
    name: 'permissive DELETE policy (blind cross-tenant delete)',
    apply: 'CREATE POLICY mutation ON app.notifications FOR DELETE TO app_user USING (true)',
    revert: 'DROP POLICY mutation ON app.notifications',
    mustFail: ['app.notifications DELETE:'],
  },
  {
    name: 'tenant key made updatable',
    apply: 'GRANT UPDATE (workspace_id) ON app.domains TO app_user',
    revert: 'REVOKE UPDATE (workspace_id) ON app.domains FROM app_user',
    mustFail: ['declared UPDATE / DELETE expectations match app_user grants'],
  },
  {
    name: 'FORCE row-level security removed',
    apply: 'ALTER TABLE app.invitations NO FORCE ROW LEVEL SECURITY',
    revert: 'ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY',
    mustFail: ['ENABLE and FORCE row-level security'],
  },
  {
    name: 'composite foreign key replaced by a plain one',
    apply: `ALTER TABLE app.domains DROP CONSTRAINT domains_workspace_id_project_id_fkey;
            ALTER TABLE app.domains ADD CONSTRAINT domains_workspace_id_project_id_fkey
              FOREIGN KEY (project_id) REFERENCES app.projects (id) ON DELETE RESTRICT ON UPDATE CASCADE`,
    revert: `ALTER TABLE app.domains DROP CONSTRAINT domains_workspace_id_project_id_fkey;
             ALTER TABLE app.domains ADD CONSTRAINT domains_workspace_id_project_id_fkey
               FOREIGN KEY (workspace_id, project_id) REFERENCES app.projects (workspace_id, id)
               ON DELETE RESTRICT ON UPDATE CASCADE`,
    mustFail: ['composite on workspace_id'],
  },
];

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
// The JSON reporter configured in vitest.config.ts.
const REPORT = fileURLToPath(new URL('../results/isolation-report.json', import.meta.url));

interface VitestJson {
  testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>;
}

function failedTests(): string[] {
  rmSync(REPORT, { force: true });
  // One command string: no arguments to escape, and Windows needs a shell to find pnpm.cmd.
  spawnSync('pnpm exec vitest run', {
    cwd: PACKAGE_DIR,
    stdio: 'ignore',
    shell: true,
  });
  if (!existsSync(REPORT)) throw new Error('vitest wrote no report');
  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as VitestJson;
  return report.testResults.flatMap((f) =>
    f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName),
  );
}

const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<number> {
  if (!isLocalHost(LOCAL_DATABASE_URLS.migrator))
    throw new Error('mutation check runs on the local stack only');
  const migrator = new pg.Client({ connectionString: LOCAL_DATABASE_URLS.migrator });
  await migrator.connect();
  let survivors = 0;
  try {
    const baseline = failedTests();
    if (baseline.length > 0) {
      say(`baseline is not green, fix it first:\n  ${baseline.join('\n  ')}`);
      return 1;
    }
    say('baseline: suite green');
    for (const m of MUTATIONS) {
      await migrator.query(m.apply);
      let failed: string[];
      try {
        failed = failedTests();
      } finally {
        await migrator.query(m.revert);
      }
      const missed = m.mustFail.filter((needle) => !failed.some((name) => name.includes(needle)));
      if (missed.length > 0) survivors += 1;
      say(`${missed.length === 0 ? 'KILLED ' : 'SURVIVED'}  ${m.name}  (${failed.length} failing)`);
      for (const name of failed) say(`           - ${name}`);
      for (const needle of missed) say(`           expected a failure matching: ${needle}`);
    }
    const after = failedTests();
    if (after.length > 0) {
      say(`suite not green after reverting:\n  ${after.join('\n  ')}`);
      return 1;
    }
    say(`after revert: suite green\n${MUTATIONS.length - survivors}/${MUTATIONS.length} mutations killed`);
    return survivors === 0 ? 0 : 1;
  } finally {
    await migrator.end();
  }
}

process.exitCode = await main();
