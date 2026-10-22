# Phase 1 · Slice 2: exhaustive cross-tenant isolation suite

**Status:** Implemented and covered by automated tests against the local Postgres 17.11 + PgBouncer 1.25.2 stack. The mutation check killed 7/7 mutations. **Pending:** the green CI run on the PR; the Owner's approval to make `Database roles, RLS and tenant isolation` a required status check on `main` (section 8).
**Date:** 2026-10-22 · **Branch:** `feat/p1-s2-isolation-suite` · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 1 slice plan, row S2.

## 1. Requirements

| Addressed                     | How                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-02, SRS 5.3 item 5        | `tests/isolation`: catalog discovery of every product relation, a registry that fails CI on an unclassified table, a per-table SELECT/INSERT/UPDATE/DELETE/RETURNING/CTE/join matrix, runs on every PR |
| SEC-01, SRS 5.3 items 2 and 4 | Registry asserts ENABLE + FORCE RLS, `NOT NULL workspace_id` and composite foreign keys for every tenant table; the matrix proves the policies behaviourally                                           |
| SEC-10 (IDOR, data layer)     | IDOR harness `@platform/isolation-tests/idor`, run for every tenant table, one user-private resource and `resolveTenantScope`                                                                          |
| **Not in this slice:**        | IDOR for server actions and route handlers (they do not exist yet: S4–S8 register them with the same harness); E2E isolation through the UI (S9)                                                       |

## 2. What was built

- `packages/db/src/testing.ts`, exported as `@platform/db/testing`: local connection strings and the SQLSTATE helpers (`sqlStates`, `expectPgError`), moved out of the S1 test helpers so both suites share them. Application code must not import it.
- `tests/isolation` (new workspace package `@platform/isolation-tests`; `pnpm-workspace.yaml` now includes `tests/*`):
  - `src/catalog.ts`: discovery from `pg_catalog` (not `information_schema`, finding S1-5). It covers every table, view, materialized view and foreign table owned by `migrator`/`svc_definer` or in `app`/`identity`, plus every foreign key in `app`.
  - `src/factories.ts`: the **row-factory registry**. Each tenant table declares its tenant key, a `prepare` step (parents) and an `insert` step, the UPDATE assignment app_user may make (or `denied`), whether DELETE is allowed, and its Prisma delegate. `NON_TENANT_RELATIONS` lists the eight relations without tenant rows, with a reason for each.
  - `src/registry.test.ts`: 9 completeness and structure checks (section 6).
  - `src/matrix.test.ts`: 10 checks × 8 tenant tables, plus the foreign-key join sweep.
  - `src/idor.ts` + `src/idor.test.ts`: the harness, its self-test and 10 resource probes.
  - `scripts/mutation-check.ts`: re-introduces 7 isolation bugs one at a time as `migrator` on the local stack. Each must make named tests fail. Every revert runs in `finally`.
- CI (`db-integration` job): the isolation suite and the mutation check now run after the S1 suites, and the JSON report is uploaded as the `isolation-report` artefact (`actions/upload-artifact` pinned by SHA, SEC-13).

## 3. Findings during the slice

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S2-1 | A permissive `FOR UPDATE ... USING (true)` or `FOR DELETE ... USING (true)` policy passed every filtered probe, both the S1 tests and the first S2 draft. PostgreSQL adds the SELECT policies to an UPDATE/DELETE only when the statement reads columns (`WHERE`, `RETURNING`). A blind `UPDATE app.projects SET name = 'x'` is checked against the UPDATE policies alone, and on the mutated database it changed 193 rows across all workspaces | The matrix now runs a **blind write** for every table with UPDATE/DELETE: no `WHERE`, no `RETURNING`, constant `SET`, rolled back. It must affect at least one row and no more rows than A can see. Mutation 3 and mutation 4 now fail the suite |
| S2-2 | With `UPDATE (workspace_id)` granted, moving a row to another workspace is still rejected (42501) by the `WITH CHECK` of the UPDATE policy. The behavioural test alone therefore cannot see the extra grant                                                                                                                                                                                                                                      | Defence in depth holds. The registry compares the declared expectations with `has_column_privilege` and fails on the grant itself (mutation 5)                                                                                                   |
| S2-3 | Vitest's CLI `--outputFile` does not override the `outputFile` of a JSON reporter declared in the config                                                                                                                                                                                                                                                                                                                                         | The mutation check reads the configured report path                                                                                                                                                                                              |

## 4. Security review (authorization, RLS, privacy, abuse, failure paths)

- **Exhaustiveness.** A new relation in a product schema (table, view, materialized view or foreign table) fails CI until it is classified. A relation with a `workspace_id` column cannot be classified as non-tenant. Stale registry entries also fail.
- **Every attack has a positive control.** Each "nothing happened" result is paired with the same statement succeeding on A's own row, or being denied there too for append-only and soft-deleted tables. B's row is fingerprinted (`md5(row_to_json)`) by B before and after each write probe. A vacuous pass needs both checks to be wrong at once.
- **Covered statement forms per table:** SELECT by id, by tenant key, `EXISTS`, `IN`, `count(DISTINCT)`; joins through the workspace root, `LATERAL` and an outer join; joins along every foreign key, plus a cross join that tries to reach B; INSERT with valid B parents (Prisma `create` = `INSERT … RETURNING`); UPDATE/DELETE by id, by tenant key, with `RETURNING`, in a writable CTE, and blind; reassigning the tenant key; no context at all; actor-only context.
- **IDOR property.** The outcome for a foreign id (value, or the set of SQLSTATE/Prisma codes) must equal the outcome for an id that never existed, so the API cannot serve as an existence oracle. Read operations must succeed on the attacker's own id. The harness's self-test shows that it flags an oracle, a blind accessor and a silent write.
- **Privacy.** Seed data uses `example.test` addresses and `.sites.test` hostnames. The suite never connects to Supabase: the mutation check refuses any connection string that is not on localhost.
- **Residual.** A malicious migration could also edit the registry. That risk is a code-review matter: both changes land in the same PR, and the registry diff is small and explicit.

## 5. Schema, compatibility, migration and rollback

No migration and no schema change. `@platform/db` gains a test-only subpath export (`./testing`); the runtime API is unchanged. Rollback: revert the PR.

## 6. Tests

Local run, 2026-10-22, Docker Postgres 17.11 + PgBouncer 1.25.2 (database already used by earlier runs, i.e. non-fresh):

| Suite                                                                                                                                                                                             | Result                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Registry (`registry.test.ts`): classification, no unregistered `workspace_id`, no stale entries, RLS + FORCE, tenant-key nullability, composite FKs, grant expectations, non-tenant SELECT denied | 9/9                                                       |
| Matrix (`matrix.test.ts`): 10 checks × 8 tables (workspaces, memberships, invitations, projects, client_contacts, domains, audit_logs, notifications) + FK sweep (9 FKs)                          | 81/81                                                     |
| IDOR (`idor.test.ts`): 7 Prisma operations × 8 tables; another member's notification; `resolveTenantScope`; harness self-test                                                                     | 11/11                                                     |
| **Isolation suite total**                                                                                                                                                                         | **101/101** (about 12 s)                                  |
| Mutation check (`test:mutation`)                                                                                                                                                                  | **7/7 killed**; suite green before and after (section 7)  |
| S1 integration suite (`@platform/db test:integration --coverage`), re-run because the helpers moved                                                                                               | 67/67; coverage 96.4 % lines, 88.1 % branches (gate 80 %) |
| Repository `pnpm lint`, `pnpm typecheck`, `pnpm test`                                                                                                                                             | pass                                                      |

**Not run yet:** the GitHub Actions job (it runs on the PR) and the clean-worktree CI-equivalent run (the evidence for it is added to this report before the merge).

## 7. Mutation evidence

| #   | Mutation (applied as `migrator`, then reverted)                              | Failing tests                                                                             |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `CREATE TABLE app.mutation_probe (id uuid, workspace_id uuid)`               | 2: registry classification; "every relation with a workspace_id column has a row factory" |
| 2   | `CREATE POLICY … ON app.projects FOR SELECT TO app_user USING (true)`        | 6: projects SELECT ×2, JOIN, actor-only, FK join sweep, IDOR projects                     |
| 3   | `CREATE POLICY … ON app.projects FOR UPDATE … USING (true)`                  | 1: projects UPDATE (blind write reached 193 rows, A sees 3)                               |
| 4   | `CREATE POLICY … ON app.notifications FOR DELETE … USING (true)`             | 1: notifications DELETE (blind write reached 72 rows, A sees 1)                           |
| 5   | `GRANT UPDATE (workspace_id) ON app.domains TO app_user`                     | 1: registry grant expectations                                                            |
| 6   | `ALTER TABLE app.invitations NO FORCE ROW LEVEL SECURITY`                    | 1: registry RLS + FORCE                                                                   |
| 7   | Composite FK `domains (workspace_id, project_id)` replaced by `(project_id)` | 1: registry composite foreign keys                                                        |

## 8. Open decisions for the Owner

1. **Required status check (part of this slice's gate).** `main` currently has no branch protection and no ruleset (`gh api …/branches/main/protection` → 404). Proposal: protect `main` with the required checks `Database roles, RLS and tenant isolation` and `Format, lint, typecheck, test, build`, and require branches to be up to date before merging. GitHub applies the protection immediately, and it changes how everyone merges, so it needs the Owner's explicit approval. Command: section 9.
2. **CA fingerprint (S1 open decision 1): done.** On 2026-10-22 the Owner's dashboard download (`prod-ca-2021.crt`) matched SHA-256 `80:70:25:AD:…:E6:CA:FA`. That file is now the pinned `.supabase-root-ca.local.pem`.

## 9. Branch protection command (after approval)

```sh
gh api -X PUT repos/ABH36/FreelanCenter/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "Database roles, RLS and tenant isolation" },
      { "context": "Format, lint, typecheck, test, build" }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`required_pull_request_reviews: null` keeps the current solo-Owner workflow, in which the Owner merges their own PRs. `enforce_admins: false` leaves an emergency override available to the Owner. Both are choices for the Owner to confirm.
