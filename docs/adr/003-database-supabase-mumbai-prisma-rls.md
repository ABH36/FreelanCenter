# ADR-003: Supabase Postgres (Mumbai), Prisma 7, RLS with transaction-local tenant context

**Status:** Accepted for planning · **Date:** 2026-09-21 · **SRS:** 5.3, SEC-01, SEC-02, D14 · **Supersedes** the "Neon or Supabase" wording in SRS v1.1

## Context

D14 locks the primary region to Mumbai (ap-south-1). Desk research found that **Neon has no Mumbai region** (nearest: Singapore); Supabase does ([Neon regions](https://neon.com/docs/introduction/regions), [Supabase regions](https://supabase.com/docs/guides/platform/regions)). The SRS listed "Neon or Supabase" as interchangeable, which D14 makes false.

## Decision

- **Provider: Supabase Postgres in `ap-south-1`.** Fallback if Supabase proves unsuitable: AWS RDS/Aurora in ap-south-1 (more operations work). Neon only if D14 is relaxed.
- **ORM:** Prisma 7 with the `@prisma/adapter-pg` driver adapter. `DATABASE_URL` = pooled (port 6543, transaction mode); `DIRECT_URL` = direct, used only by migrations.
- **Isolation pattern (Spike B):**
  1. Roles: `migrator` (owner), `app_user`, `app_public`, `svc_definer`. **No superuser or BYPASSRLS anywhere** (managed Postgres does not give it).
  2. Every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `USING/WITH CHECK (workspace_id = current_workspace())`.
  3. `current_workspace()` = `NULLIF(current_setting('app.workspace_id', true), '')::uuid` - **the NULLIF is mandatory** (Spike B finding B-1).
  4. Tenant context set with transaction-local `set_config(..., true)`; one request-scoped `withWorkspace` transaction per request; the per-query client extension only as a convenience.
  5. Public/visitor paths use `SECURITY DEFINER` functions owned by a NOBYPASSRLS role with explicit narrow policies; `migrator` is a member of that role `WITH INHERIT FALSE`.
  6. Prisma `transactionOptions` (maxWait/timeout) and pool size are set explicitly; concurrency is bounded in the data-access layer (Spike B finding B-3).
  7. Composite FKs `(workspace_id, x_id)` on every child table.

## Consequences

- Isolation is enforced by the database, and a test suite can prove it.

* Per-query wrapper costs extra round trips (p50 8.05 ms vs 2.48 ms locally) -> batch work in one transaction per request.
* Supabase's shared pooler (Supavisor) is **not** the PgBouncer used in Spike B. Its prepared-statement behaviour and role restrictions are unverified.

## Verification

The isolated `pg` harness passed 3× through the shared pooler (6543) and once through the configured direct endpoint (5432) on 2026-10-15. On 2026-10-16, the same live scratch-project proof passed through the real Prisma 7 `@prisma/adapter-pg` extension and interactive transaction: scoped extension reads, no-context fail-closed behavior, transaction pinning, and 400 concurrent Prisma operations had 0 leaks and 0 errors. A final cleanup audit found no temporary tables, function or roles. This closes the Phase-1 Task-0 database gate.

## Evidence

[docs/spikes/SPIKE_B_RLS_POOLING.md](../spikes/SPIKE_B_RLS_POOLING.md): 16/16 tests x3 runs on Postgres 17.11 + PgBouncer 1.25.2 + Prisma 7.10.

Live evidence is recorded in the same Spike B report. Re-run it after relevant Prisma, Supabase pooler or RLS-pattern changes.
