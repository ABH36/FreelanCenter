# Phase 3, slice S1: builder data model

**Status:** built on `feat/p3-s1-builder-data-model`; awaiting the Owner's approval of the slice. The live migration is a separate, Owner-approved step (section 7). **Date:** 2026-11-14 · **Requirements (foundations):** FR-BLD-06 (optimistic concurrency, undo), FR-BLD-07 (edit lock), FR-PUB-01/02/03 (immutable versions, pointers, rollback) · **Plan decisions:** Q7 (immutability), Q15 (publish policy) · **Modules:** 05, 06 · **Design approved by the Owner 2026-11-14.**

## 1. Why

The builder (S2–S5), publishing (S7), AI (P4) and client onboarding (P5) all need one data model for drafts, changes and published versions. S1 builds it in the database, so its safety rules hold whatever any later service does.

## 2. What was built

Migration `20261114180000_p3_s1_builder_data_model`. It adds 3 types, 5 tables and 6 trigger functions, plus one helper, `app.project_editable`. Every table carries `workspace_id`, has RLS with FORCE, has composite foreign keys to `projects`, and grants each column only to the role that needs it.

| Table                | Rules the database enforces                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_drafts`        | One draft per project. A new draft starts at revision 1. Every update must move the revision by exactly one (`P5101`), so a save `WHERE revision = <expected>` from a stale editor changes nothing. Authorship columns come from the transaction's actor. The config must be a JSON object of at most 512 KB                                 |
| `change_sets`        | `source` is manual, ai or client. Status moves only forward: proposed → applied or rejected, applied → undone (`P5102`). An applied change carries its inverse and `result_revision = base_revision + 1`. The decision columns are set by the database, and a client cannot set them (no grant). Change sets are never deleted               |
| `site_versions`      | Immutable for every role. `app_user` has no UPDATE or DELETE grant. Row triggers refuse UPDATE and DELETE even for the table owner, and a statement trigger refuses TRUNCATE. The checksum must be a SHA-256 hex digest                                                                                                                      |
| `site_pointers`      | One staging and one live pointer per project. A pointer accepts only a version of its own project and kind (`P5103`). Rollback moves the pointer; the version never changes                                                                                                                                                                  |
| `project_edit_locks` | One lock per project. The database sets the holder to the actor and the lifetime to 2 minutes from the heartbeat. The holder renews the lock and keeps `acquired_at`; any editor may take it after it expires, and an owner or admin may take it over at any time. Releasing it means deleting it, which the holder or an owner/admin may do |

**Policies (SRS 7, Q15).**

- Every member reads.
- Owners, admins and editors write drafts, change sets and locks, but only in a writable workspace and an editable project. Archived or deleted projects are read-only.
- Editors publish to staging only. Live versions and live pointers are for owners and admins.
- Visitors (`app_public`) cannot read any of these tables.

**Approved decisions not enforced in the database:**

- Undo depth 50 is enforced by the service in S2.
- A draft is created when a template is chosen, which is the FR-PRJ-01 path in S2.

## 3. Findings

| ID   | Finding                                                                                                                                                                                                                                                                                                                                       | Consequence                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-1 | Prisma sends its own values for `@default(now())` columns. Without an INSERT grant on those columns every create failed with `permission denied`                                                                                                                                                                                              | Those columns are granted (S8b did the same). The guards overwrite them with the database's own time and actor, so the client value never survives                                        |
| S1-2 | A BEFORE trigger runs before the RLS `WITH CHECK`. For a row aimed at another workspace, the pointer guard answered `P5103` ("no such version") where every other table answers `42501`. The answer was the same whether the version existed or not, so nothing leaked, but it differed from the uniform answer the isolation matrix requires | The guard leaves rows outside the current workspace to RLS. The matrix shows a uniform `42501`                                                                                            |
| S1-3 | The table owner (`migrator`) sees no rows under FORCE RLS, so a plain "owner cannot update" test proved nothing                                                                                                                                                                                                                               | The test now lifts FORCE RLS inside a rolled-back transaction and shows that the row triggers refuse UPDATE and DELETE. TRUNCATE is refused in any case                                   |
| S1-4 | `migrator` may not set `session_replication_role`, so a test cannot bypass the lock guard that way. That is correct                                                                                                                                                                                                                           | To expire a lock, the test lifts FORCE RLS and the guard, updates the row and restores both inside one transaction. DDL is transactional, so no other session sees the table without them |
| S1-5 | The auto-discovered isolation test requires rows of both seeded workspaces in every tenant table. I first ran only the new test files, and the full CI-equivalent caught the gap                                                                                                                                                              | `seedWorkspace` now seeds every builder table                                                                                                                                             |

## 4. Security review

- **Tenant isolation:** the five tables are in the isolation matrix and the IDOR harness. Every cross-tenant read, insert, update and delete either finds 0 rows or gets `42501`, and the joins are composite on `workspace_id`.
- **Least privilege:**
  - Column grants only.
  - No DELETE, except on edit locks.
  - No UPDATE on versions.
  - Revisions, authorship, decisions and lock times are set by the database.
- **Integrity:**
  - Immutability does not rely on grants alone; triggers enforce it as well.
  - Change-set history only moves forward, and pointers cannot cross projects or kinds.
- **Privacy:** builder tables hold business content (Confidential, `docs/data-classification.md`). An edit lock holds only a member id and times. Visitors have no access.
- **Residual:** draft configs are validated only for shape and size at the database. Schema validation of a `SiteConfig` is the service's job in S2.

## 5. Tests and evidence

| Check                                                                            | Result                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder-model.test.ts` (new)                                                    | 17/17                                                                                                                                                                                                                                                |
| `@platform/db` integration, twice on a fresh database                            | 160/160, 160/160; coverage 92.9 % lines                                                                                                                                                                                                              |
| Isolation suite (matrix, IDOR, registry)                                         | 290/290                                                                                                                                                                                                                                              |
| Catalog (tenant tables, trigger function executors)                              | 18/18                                                                                                                                                                                                                                                |
| `db:verify` (now also checks that `app_public` cannot read the 5 builder tables) | 38/38                                                                                                                                                                                                                                                |
| `db:drift` (migration and `schema.prisma` agree)                                 | no difference                                                                                                                                                                                                                                        |
| Full CI-equivalent (`5f417e3`)                                                   | 34 steps passed. Failures: `db:integration-*`, fixed in `359e54d` and re-run green (S1-5); visual and browsers (Windows only, known); `perf` (also fails on `main` on this machine under load, P3 auth hardening report; GitHub CI is the reference) |

## 6. Migrations and contracts

- One forward-only migration. Rollback is a new migration that drops the five tables, the trigger functions, `project_editable` and the three types; nothing else references them.
- Contracts: `docs/governance/CROSS_MODULE_CONTRACTS.md` already defines `SiteDraft` (mutable, with revision) and `SiteVersion` (immutable). This slice implements both without changing them.
- Docs updated: module 05 and module 06 (data model), and `docs/data-classification.md`.

## 7. Live migration (separate approval)

After the PR is merged, the live database gets this migration only with the Owner's approval, following the Phase 2 S8b procedure:

1. A read-only pre-check.
2. `prisma migrate deploy`.
3. Status and drift checks.
4. `db:verify --target env`.
5. A record in this section.

Until then, production keeps running without these tables. Nothing in production uses them yet.
