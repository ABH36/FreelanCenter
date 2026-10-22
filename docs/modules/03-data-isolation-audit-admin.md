# 03 — Data Isolation, Audit and Platform Administration

**Status:** P1 slice 1 implemented (`packages/db`, evidence `docs/reports/PHASE_1_S1_DB_FOUNDATION.md`); verification at the P1 gate; mature P8. **SRS:** SEC-01..06, FR-ADM-01..05, FR-AUD-01..03.

## Outcome

Make every tenant boundary enforceable in PostgreSQL and every sensitive action explainable to support/security staff. Admin capability is separate from workspace membership and uses least privilege.

## Mandatory database pattern

Each tenant-owned table includes `workspace_id`; composite FKs prevent mismatched parents. Transactions set `app.workspace_id` locally, use non-bypass DB roles and `FORCE ROW LEVEL SECURITY`; policies call the NULL-safe `current_workspace()` function specified in SRS §5.3. Never set tenant context on a pooled connection outside the transaction.

```text
Request identity → membership authorization → interactive transaction
→ set_config(workspace, local=true) → query/mutate under RLS → commit
→ immutable audit event
```

## Audit/admin rules

Audit events record actor, workspace/project scope, action, target, result, correlation ID and redacted metadata. They are append-only and have legal retention. Admin actions (suspend, takedown, plan/flag changes) require explicit reason, elevated authorization and notification/audit hooks. Admin search must not bypass data minimization.

## Evidence and operations

The Phase-1 gate is a real Supabase pooled-connection negative-leak suite under concurrency. Test missing context, stale context, cross-tenant joins, background jobs, export and admin operations. Logs are structured/redacted; secrets, tokens and PII never appear. Read ADR-003, threat model and Phase-0 audit conditions first.

## Implementation (P1 slice 1, `packages/db`)

Read `packages/db/prisma/migrations/*/migration.sql` and `packages/db/src/client.ts`; this section records the design decisions behind them.

- **Schemas.** Tenant tables live in `app`, Better Auth tables in `identity`; nothing is created in `public`. Measured on the live Supabase project (2026-10-22): the operator role `postgres` has `BYPASSRLS`, the Data API roles have `USAGE` on `public`, and objects the operator creates there are granted to `anon`/`authenticated`/`service_role` by default. Every product object is therefore owned by `migrator` (no BYPASSRLS) in a schema those roles cannot use.
- **Roles.** `scripts/bootstrap-roles.ts` (idempotent, operator-run) creates `migrator`, `app_user`, `app_auth`, `app_public`, `app_admin` and NOLOGIN `svc_definer`; none is SUPERUSER, BYPASSRLS, CREATEROLE or REPLICATION. `migrator` joins `svc_definer` `WITH INHERIT FALSE, SET TRUE` (Spike B B-7). Request roles get `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`. Passwords travel as SCRAM verifiers, so plaintext never reaches server logs.
- **Context.** `withActor` sets only `app.user_id` (membership `self_select`, workspace `member_select`); `resolveTenantScope` checks membership and returns a branded `TenantScope`; `withTenant` sets both settings plus a per-transaction `statement_timeout` in one `set_config(..., true)` round trip. The raw `app_user` Prisma client is not exported, so an unscoped query cannot be written. A FIFO limiter in front of Prisma turns overload into `DbBusyError` (Spike B B-3).
- **Least privilege.** Column-level grants keep `status`, suspension, plan, ids and ownership columns out of `app_user`'s UPDATE list. Prisma sends enum defaults on INSERT, so `status` is insertable, and the INSERT policies pin it (`workspaces.status = 'active'`, `projects.status = 'draft'`). There is no DELETE on soft-deleted tables.
- **Suspension and deletion (FR-WS-04, Q4).** Write policies call `(SELECT app.workspace_writable())`, so a suspended workspace, or one scheduled for deletion, can still be read and appended to the audit log but cannot be changed. Only `app.admin_set_workspace_status` (executed by `app_admin`) changes the status. It re-checks in the database that the caller is an active platform admin with TOTP enrolled, requires a reason, and writes the audit row in the same transaction.
- **Audit (FR-AUD-01, Q8).** `audit_logs` has no UPDATE or DELETE grant, and triggers reject UPDATE, DELETE and TRUNCATE for every role, including the owner. Platform events (`workspace_id` NULL) enter only through `app.record_platform_audit` (executed by `app_auth`), and tenants cannot see them.
- **Platform admins.** No application role can write `app.platform_admins`. Operators call `app.operator_grant_platform_admin` / `operator_revoke_platform_admin` as `migrator`; both are audited.
- **Notifications.** Only the recipient can read a notification. `INSERT … RETURNING` must also pass the SELECT policy, so notifying another member uses `createMany`.
- **Known limits.** Session tokens are stored in plain text (Spike F F-3, accepted). Whether a definer function is executable by `app_public` is first exercised in S7 (`resolve_host`). The live Supabase run of bootstrap and migrate is pending Owner approval.
