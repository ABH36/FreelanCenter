# 09 — Leads, Notifications and Analytics

**Status:** Planned (P5). Basic notifications implemented in P1 S6 (awaiting Owner approval; evidence `docs/reports/PHASE_1_S6_PROJECTS_LIFECYCLE.md`): in-app inbox per member (RLS: recipient only), unread count, mark read / all read, per-category preferences for in-app and e-mail (`project.review`, `project.status`, `workspace.members`), e-mail through the transactional outbox and the `notification.email.v1` job (capture transport until DG-10), dead letters in `app.job_dead_letters`. Templates are escaped plain HTML/text like the S4/S5 mails; React Email is not adopted yet (S6 decision D7). **SRS:** FR-LEAD-01..08, FR-NOT-01..03.

## Outcome

Capture business enquiries reliably, protect public forms from abuse, notify owners promptly and provide privacy-preserving operational insight.

## Flow

```text
Visitor form → host/site resolution → schema + honeypot + captcha + rate checks
→ create scoped Lead → enqueue idempotent notification → retries/DLQ
→ inbox status/assignment/notes → retention/deletion workflow
```

Each public request is bound to an active published site key and strict payload cap. Store minimal attribution; click analytics is cookieless by default. Email is baseline; WhatsApp/SMS adapters are optional configuration. AI triage/replies are drafts only, never auto-send without owner consent.

## Abuse, privacy and evidence

Rate-limit per IP/site, validate origin/CORS policy, rotate/revoke site keys, keep captcha secrets server-side, and avoid raw PII in logs. Notification attempts use provider idempotency, exponential retry and dead-letter visibility. Test spam/bypass, tenant isolation, duplicate submit, provider outage, retention deletion, CSV authorization and end-to-end delivery latency. CRM campaign/automation is post-v1 unless approved by ADR.
