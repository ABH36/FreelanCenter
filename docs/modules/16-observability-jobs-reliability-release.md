# 16 — Observability, Jobs, Reliability and Release

**Status:** Cross-cutting; foundation P1, launch gate P8. **SRS:** FR-OBS-01..04, FR-NOT-01..03, NFR-REL/OPS/PERF, §8.7.

## Outcome

Operate the platform with evidence: a user action can be traced across request, database, job and provider; failures recover safely; releases are reversible.

## Operational contract

Every request/job has correlation ID, structured redacted logs, metrics and trace context. Durable jobs use named events, validated payloads, idempotency keys, retry policy, exponential backoff and dead-letter handling. A job is never the only place a synchronous user response is required.

```text
Command/event → transactional write + outbox/event handoff → durable job
→ attempt/retry → provider result → state/audit/metric → alert or DLQ
```

Key metrics: tenant/RLS errors, auth failures, publish duration/failure, render latency/error, queue age/DLQ, lead notification time, AI cost/validation failure, DNS state age, payment webhook failures and backup/restore results. Define per-service SLOs/error budgets before beta; alerts have owner and runbook.

## Delivery and evidence

CI must format, lint, typecheck, unit/integration/RLS/E2E tests, export smoke build, dependency/secret scans and traceability check. Pin GitHub Actions to immutable SHAs. Release through preview/staging, migration compatibility checks, feature flags and rollback plan; migrations are expand/contract and tested from a clean restore. Prove recovery through failure injection and backup restore—not assertions.

Local and preview deployment rules are defined in `docs/governance/DEVELOPMENT_ENVIRONMENT_POLICY.md`. Preview URLs can prove deployment flow but cannot substitute for the production two-domain isolation proof required by ADR-002; custom-domain/DNS/SSL evidence remains a P7A gate.
