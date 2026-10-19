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

## Current implementation state (DG-04 implementation; verification pending)

- **Shared logger package (`@platform/logger`):** Implemented in `packages/logger` providing structured JSON output, level filtering (`trace`, `debug`, `info`, `warn`, `error`, `fatal`), and deep redaction conforming to SEC-05, SEC-15, and cross-module privacy rules.
- **Redaction coverage:** Automatic redaction of credentials and secrets (Bearer/Basic authorization headers, JWTs, database URLs with passwords, URL query secret params, API keys for Anthropic, OpenAI, AWS, GitHub, Stripe/Razorpay, Supabase), cookies (preserving standard directives while scrubbing values), and common PII (emails, phone numbers, credit card numbers, national IDs/Aadhaar).
- **Correlation ID & Context:** Server-side generation (`crypto.randomUUID()`), header sanitization (`getCorrelationIdFromHeaders` for `x-correlation-id`, `x-request-id`, `x-trace-id`), and ambient propagation across async boundaries via `AsyncLocalStorage` (`runWithContext`, `withCorrelationId`, `getLogContext`).
- **Health endpoints:** `/api/health` on both `dashboard` and `sites` applications are instrumented with safe structured logging, returning `x-correlation-id` and the deliberately public `deploymentSurface` marker only; credentials, database URLs and other sensitive environment values are not exposed.
- **Evidence:** 38 automated tests passed (32 package tests in `@platform/logger`, 3 route tests in `dashboard`, 3 route tests in `sites`). See `docs/reports/PHASE_1_DG03_STRUCTURED_LOGGER.md`.
- **CI supply-chain baseline:** Every third-party GitHub Action in `.github/workflows/ci.yml` is pinned to an immutable commit SHA. `.github/dependabot.yml` checks `github-actions` weekly and opens reviewable update PRs; updates must retain full-SHA pins and pass the normal CI/security gates. See `docs/reports/PHASE_1_DG04_CI_ACTION_PINNING.md`.
