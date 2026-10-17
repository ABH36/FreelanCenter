# 03 — Data Isolation, Audit and Platform Administration

**Status:** Planned baseline P1; mature P8. **SRS:** SEC-01..06, FR-ADM-01..05, FR-AUD-01..03.

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
