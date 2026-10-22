# Phase 1 · Slice 1: `packages/db` foundation

**Status:** Implemented and covered by automated tests; full CI-equivalent run passed in a clean LF worktree on a fresh database (2026-10-22). **Pending:** a green CI run of the new `db-integration` job, a live Supabase bootstrap and migrate (needs Owner approval and a corrected `DIRECT_URL`), and Owner review.
**Date:** 2026-10-22 · **Branch:** `feat/p1-s1-db-foundation` · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 1 slice plan, row S1.

## 1. Requirements

| Addressed                                                                                                                        | How                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01, SRS 5.3 items 1-4                                                                                                        | Non-bypass roles, ENABLE + FORCE RLS on every `app` table, NULLIF context functions, transaction-local context only, composite FKs                  |
| SEC-10 (data layer)                                                                                                              | Raw `app_user` client not exported; `TenantScope` can only come from a server-side membership check; column-level grants                            |
| FR-AUTH-08 (bridge)                                                                                                              | `withActor` + membership `self_select` + workspace `member_select` (workspace switcher reads)                                                       |
| FR-WS-04 (database part)                                                                                                         | `app.workspace_writable()` in every write policy; `app.admin_set_workspace_status` (admin + MFA + reason + audit)                                   |
| FR-AUD-01 (store)                                                                                                                | Append-only `audit_logs`: no UPDATE/DELETE grant, triggers block UPDATE/DELETE/TRUNCATE for every role; `record_platform_audit` for platform events |
| FR-WS-05 hook (Q4), Q8, Q9                                                                                                       | `deleted_at`/`scheduled_purge_at` with write block; audit never deleted; globally unique hostnames + one subdomain per project                      |
| NFR-MAINT-01 (db), NFR-OPS-01 (db)                                                                                               | Coverage gate at 80 % (measured 97.9 % lines / 89.7 % branches); `pnpm --filter @platform/db db:setup` on a clean checkout                          |
| **Not in this slice:** SEC-02 merge-gate completeness (S2), all UI and auth flows (S4+), `resolve_host` (S7), admin console (S8) |

## 2. What was built

- `docker/`: Postgres 17.11 behind PgBouncer 1.25.2 (transaction mode, `pool_size` 4, plus a one-connection alias for the leak test). Images are pinned by digest. Trust auth on 127.0.0.1 only, so the repository holds no passwords. Init reproduces Supabase: a non-superuser operator with BYPASSRLS, the Data API roles, and their default privileges in `public`.
- `scripts/bootstrap-roles.ts`: idempotent role reconciliation. It checks every URL's role, requires passwords of 32+ characters on remote hosts, sends passwords as SCRAM-SHA-256 verifiers (never plaintext), sets request-role timeouts, then verifies attributes, memberships and a real login per role.
- `prisma/schema.prisma` + `migrations/20261022140000_p1_foundation`: `identity` (Better Auth: users, sessions, accounts, verifications, two_factors, rate_limits) and `app` (platform_admins, workspaces, memberships, invitations, projects, client_contacts, domains, audit_logs, notifications), UUID v7 everywhere, CHECK constraints, partial unique indexes, policies, grants, five SECURITY DEFINER functions owned by `svc_definer`, audit triggers.
- `src/`: `createTenantDatabase` (`withActor`, `resolveTenantScope`, `withTenant`, `withNewWorkspace`, `verifyRole`), `createAuthPrismaClient`, `TransactionLimiter`, TLS-aware `connectionConfig`, typed errors, `uuidv7`.
- CI: a new `db-integration` job. It runs bootstrap twice (idempotency), migrate, the drift check, the integration suite with the coverage gate, then the suite again on the same database.

## 3. Findings during the slice

| ID   | Finding                                                                                                                                                                                                                                                                                               | Consequence                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-1 | Live Supabase (read-only inspection): `postgres` has **BYPASSRLS**; `service_role` has BYPASSRLS; `anon`/`authenticated`/`service_role` get ALL on objects `postgres` creates in `public`                                                                                                             | Migrations must never run as `postgres`; product schemas are `app`/`identity` owned by `migrator`; catalog test forbids foreign grantees    |
| S1-2 | After `ALTER FUNCTION … OWNER TO svc_definer`, a `GRANT`/`REVOKE` by `migrator` only raises a WARNING and changes nothing (`INHERIT FALSE` means no owner rights). Spike B issued its `REVOKE … FROM PUBLIC` after the transfer, so its visitor functions were most likely still executable by PUBLIC | EXECUTE grants now come before the transfer; a grant to migrator itself is made under `SET ROLE svc_definer`; catalog test asserts the ACLs |
| S1-3 | Prisma sends enum defaults explicitly in `INSERT`                                                                                                                                                                                                                                                     | `status` stays in the INSERT column grant; the INSERT policies pin the allowed value                                                        |
| S1-4 | `INSERT … RETURNING` must pass the SELECT policy                                                                                                                                                                                                                                                      | Notifying another member uses `createMany`; tested                                                                                          |
| S1-5 | `information_schema` hides grants that the inspecting role cannot see; a grant audit based on it passes vacuously                                                                                                                                                                                     | Catalog tests read `pg_class.relacl`/`pg_attribute.attacl` with `aclexplode`                                                                |
| S1-6 | Postgres image healthcheck over the socket passes while initdb's temporary server runs; the first client is then cut off                                                                                                                                                                              | Healthcheck over TCP with a start period; fresh-volume bootstrap passed 3/3                                                                 |
| S1-7 | `DIRECT_URL` in `.env.local` fails password authentication (its password differs from `DATABASE_URL`'s)                                                                                                                                                                                               | Owner to correct it before the live run                                                                                                     |

## 4. Security review (authorization, RLS, privacy, abuse, failure paths)

- No context returns zero rows on every table, including on reused pooled connections. A malformed id is rejected before `set_config`. A session-level `SET` is detected (anti-pattern test) and forbidden by a static scan of `apps/` and `packages/`.
- Cross-tenant SELECT/UPDATE/DELETE/RETURNING/joins/nested includes leak nothing. WITH CHECK and composite FKs stop cross-workspace inserts and parent references. Moving a row across workspaces fails for lack of a column privilege.
- Privilege escalation paths that are closed: self-unsuspend (no column grant), inserting a suspended workspace or a live project (policy), self-promotion through actor context (no membership INSERT without workspace context), writing `platform_admins` (no grant for any app role), custom domains before P7A (policy), forging platform audit as `platform_admin` (function check).
- The admin suspension function re-checks platform-admin status and TOTP enrolment in the database and requires a reason. It is idempotent (no duplicate audit row).
- Abuse and availability: bounded queue with `DbBusyError`; per-transaction `statement_timeout`; role-level `lock_timeout` and `idle_in_transaction_session_timeout`; JSON size limits on audit metadata and notification payloads.
- Privacy: data-access errors carry no SQL parameters or URLs. The slow-transaction log carries only the duration and the workspace id. Audit metadata is size-bounded; callers must redact it (data-classification.md).
- Residual: Better Auth session tokens are stored in plain text (Spike F F-3, accepted). Only `app_auth` can read them.

## 5. Schema, compatibility, migration and rollback

This is the first product migration (forward-only). `pnpm db:drift` proves that `schema.prisma` and the migrations agree (tables, columns, indexes, FKs). Policies, grants, functions and CHECKs live in SQL and are asserted by the catalog tests. Rollback before any product data exists: drop schemas `app` and `identity` and the six roles. After data exists, use forward fixes only.

## 6. Tests

| Suite                                                                                                                                                                                                                  | Result                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unit (`pnpm --filter @platform/db test`): uuid, env, TLS config, SCRAM (RFC 7677 vector), limiter, static scan                                                                                                         | 19/19                                                                                               |
| Integration (`test:integration`), Docker Postgres 17.11 + PgBouncer 1.25.2                                                                                                                                             | **67/67**, run twice on the same database; coverage 97.9 % lines, 89.7 % branches, 97.4 % functions |
| Catalog (in integration): roles, memberships, timeouts, RLS coverage, policy roles, NULLIF form, raw ACLs, column privileges, public schema empty, definer ownership/search_path/EXECUTE, triggers, runtime role guard | 18/18                                                                                               |
| Concurrency (in integration): pinning, 600 interleaved transactions (0 leaks, 0 errors), reused-connection no-context check, backpressure, statement timeout, slow log, session-SET leak detection                     | 8/8                                                                                                 |

**Not run yet:** the GitHub Actions job (it runs on the PR) and the live Supabase bootstrap + migrate + suite.

## 7. Observability

`db.transaction.slow` warning (duration, workspace id). Every admin suspension and platform-admin change writes an audit row with `correlation_id`. No metrics yet (FR-OBS-01 metrics/tracing: S9).

## 8. Open decisions for the Owner

1. Approve applying bootstrap + migrate to the live Supabase `ap-south-1` project. This needs a corrected `DIRECT_URL` and new role URLs in `.env.local`; the passwords would be generated locally and never printed.
2. Turn off Supabase's Data API (or remove `public` from its exposed schemas) as defence in depth. The product does not use it.
