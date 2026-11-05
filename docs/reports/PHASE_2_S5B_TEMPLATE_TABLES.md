# Phase 2, slice 5b: template tables, catalogue and seed (live migration pending)

**Status:** built on `feat/p2-s5b-template-tables`, awaiting Owner approval. **The migration is NOT applied live.** **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 data model (`Template`, `TemplateVersion`) · **Module:** `docs/modules/04-template-engine-renderer.md` · **Depends on:** S5a (PR #48).

## 1. Requirements

| Requirement                                                        | State after S5b                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan: `Template`, `TemplateVersion` (built-ins platform-owned)     | Implemented on the local stack: two tables, immutable versions, platform built-ins (`workspace_id` NULL) and private workspace templates, catalogue functions, seed command. **Not live until the Owner approves the migration** |
| FR-TPL-01 / FR-TPL-10 (templates stored as validated data)         | The three reference templates are loadable from the database through the catalogue; the seed file is generated from the S5a definitions with the real `templateSchema`                                                           |
| ADR-004 (no creator code), SEC-16 (marketplace safety, groundwork) | Tenants cannot create platform or marketplace templates; versions are immutable; content is bounded JSON; marketplace visibility is reserved for P6 and is not writable by tenants                                               |
| SEC-01/02 (RLS, isolation suite as merge gate)                     | Both tables are in the isolation matrix and IDOR harness (216 tests); the mutation check has two new mutations (13/13 killed)                                                                                                    |

Nothing is marked "verified".

## 2. Design

- **`templates`**: `workspace_id` NULL = platform built-in (`visibility = platform`); otherwise a private template of that workspace. Constraint: owner is NULL **iff** visibility is `platform`. Slug format, name and description length, category taxonomy (CHECK). Platform slugs are unique (partial index); private slugs are unique per workspace. Owner, visibility and slug cannot change after creation (trigger).
- **`template_versions`**: immutable (`UPDATE`/`DELETE`/`TRUNCATE` rejected by trigger, and no grant). Numbered 1, 2, 3 without gaps (checked **after** the RLS check, so a cross-tenant attempt never reveals whether a template exists). `config` is a JSON object up to 256 KB (the SiteConfig contract), `manifest` up to 64 KB, `content_hash` a SHA-256 hex. Composite FK `(workspace_id, template_id)` for private rows; the guard trigger covers platform rows, where a composite FK is silent.
- **Tenants** (`app_user`): see only their own private templates; owners, admins and editors create and rename them; viewers read. No DELETE (soft delete). A suspended workspace cannot write (existing `workspace_writable`).
- **Catalogue**: `app.list_catalog_templates()` and `app.get_catalog_template(id, version?)`, `SECURITY DEFINER` owned by `svc_definer`, search path pinned, executable by `app_user` and `app_public` only. They return **published platform and marketplace templates only**, latest version unless one is asked for. A draft, archived, deleted or private template returns nothing and the caller cannot tell why. The tables stay invisible across tenants, so the cross-tenant matrix applies unchanged.
- **Built-ins**: `app.operator_publish_builtin_template(...)` and `app.operator_archive_builtin_template(slug, reason)`, executable by `migrator` only. Publishing is idempotent (unchanged content hash creates nothing), appends the next version when content changed, serialises concurrent runs per slug (advisory lock), and writes a platform audit row (`admin.template.created`, `admin.template.version_published`, `admin.template.archived`).
- **Seed**: `pnpm --filter @platform/db db:seed-templates [--target local|env] [--dry-run]` reads `packages/templates/seed/builtin-templates.json` (committed, so template changes are reviewable diffs; a test fails when it is stale), re-verifies shape and content hashes, and applies everything in **one transaction** (all or nothing). `--dry-run` never connects.

## 3. Findings

| ID    | Finding                                                                                                                                                                                                                                                                                          | Consequence                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5-7  | **Design flaw caught by the isolation suite.** My version-guard trigger was `BEFORE INSERT`; it ran before the RLS check and answered 23503 for a cross-tenant insert, where policy says 42501. The error would have told an attacker "that template is not yours" instead of the uniform denial | Guard is now `AFTER INSERT` (the RLS `WITH CHECK` is evaluated first). The local database was rebuilt from scratch and the whole suite re-run                               |
| S5-8  | Shape of a platform-owned row: a fake "platform workspace" would need a user, a membership and a suspend-able status, and every query would have to special-case it                                                                                                                              | Platform built-ins have `workspace_id` NULL (as platform audit rows already do) with a CHECK that ties NULL to the `platform` visibility                                    |
| S5-9  | `db:verify` and four integration tests encoded "app_public executes exactly `resolve_host`" and the definer function list                                                                                                                                                                        | Updated deliberately to the new, still exact, lists (three public functions, 27 definers); `db:verify` also checks that a visitor can list the catalogue and cannot publish |
| S5-10 | `projects.template_id` / `template_version_id` (P1 columns) have no foreign key                                                                                                                                                                                                                  | Left as is: a project is attached to a template version in P3 (`SiteDraft` creation). A cross-owner FK (platform templates have no workspace) will be designed there        |
| S5-11 | The first run of the `db` unit suite in a clean worktree can exceed 5 s per test on this machine                                                                                                                                                                                                 | Already bounded in S4 (30 s); unchanged                                                                                                                                     |

## 4. Security, privacy, abuse and failure paths

- **Catalogue poisoning** is the new asset to protect: tenant INSERT/UPDATE is pinned to `private` and to the tenant's own workspace by RLS and by column grants; platform rows are written only through the operator function; a policy that allowed otherwise is one of the two new mutations the isolation suite must catch (it does).
- **No existence oracle:** cross-tenant version inserts fail at RLS or the composite FK with a uniform error; the catalogue never joins tenant rows.
- **Stored content is data:** JSON objects with size limits and a hash; rendering still validates every config on read (S4), so a bad stored version cannot reach a visitor as markup.
- **Privacy:** templates hold no personal data (demo contact details are fake). Classification: public content.
- **Failure paths:** seed run is atomic; a tampered or stale seed file stops before any statement; the operator function rolls back on any CHECK failure; the catalogue returns an empty set rather than an error for anything not published.
- **Audit:** every platform template change writes a platform audit row with slug, version and content hash.

## 5. Tests (local Docker stack, real roles through PgBouncer)

| Suite                      | Result                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:drift`                 | no difference                                                                                                                                                                                                                                                                                                                                                                     |
| `db:verify`                | 31 checks pass (was 28)                                                                                                                                                                                                                                                                                                                                                           |
| `@platform/db` integration | all pass: 15 template tests (private templates, roles, versions, bounds, immutability, platform built-ins, audit, 8-way concurrent seed, catalogue for tenants and visitors, archive and republish, operator-function privileges), 6 seed tests (golden hash shared with `@platform/templates`, tampering refused, apply, rollback, content served), catalog expectations updated |
| Isolation suite            | 216 tests (was 189): both tables in the matrix and IDOR harness, plus template-specific tests                                                                                                                                                                                                                                                                                     |
| Isolation mutation check   | **13 of 13** killed (was 11): "tenant policy allows platform templates" and "tenant role granted an operator template function" are new                                                                                                                                                                                                                                           |
| `@platform/templates`      | 28 tests including the seed file drift test                                                                                                                                                                                                                                                                                                                                       |

## 6. CI-equivalent run

(filled in after the clean-worktree run)

## 7. Live migration plan (requires the Owner's separate approval)

Nothing below has been run against the live Supabase database. Proposed procedure, same shape as the approved P1 S9 migration:

1. **Read-only pre-check** as `migrator` on the live database: remote host, no BYPASSRLS, S1 to S9 migrations applied, `20261105120000_p2_s5b_templates` absent, `app.templates` absent.
2. **Apply:** `prisma migrate deploy` with `DB_TARGET=env` (forward-only; creates two enums, two tables, five trigger/guard functions, four definer functions, policies and grants; no change to existing tables, no data change).
3. **Verify:** `prisma migrate status` up to date; live database against `schema.prisma`: no difference (`db:drift` equivalent for the live target); `db:verify --target env` (31 checks, includes the new catalogue and privilege checks); the live suite (`test:live`) as in S9.
4. **Seed** (separate step, also needs approval): `db:seed-templates --target env --dry-run` first, then without `--dry-run`; expected: three templates at version 1, one platform audit row per template and version; read back through the catalogue as `app_public`.
5. **Rollback:** forward-only. If the migration must be undone before anything uses it, a new migration drops the two tables, the two enums and the nine functions (nothing else references them: `projects.template_id` has no foreign key). The seed is repeatable and archivable (`operator_archive_builtin_template`).
6. **Risk:** low. New objects only; existing tables, roles and policies untouched; no downtime; the sites app does not read the new tables yet (S6 adds the preview route).

## 8. Open items

1. Approve S5b (code, tests, report).
2. **Approve the live migration** and, separately, the live seed (section 7). Not requested yet: I will ask again, with the pre-check output, after the PR is merged.
3. Nothing else is open for this slice.
