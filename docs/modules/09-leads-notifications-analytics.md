# 09 — Leads, Notifications and Analytics

**Status:** Planned (P5). **SRS:** FR-LEAD-01..08, FR-NOT-01..03.

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
