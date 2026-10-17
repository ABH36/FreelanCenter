# 07 — AI Automation and Credits

**Status:** Planned (P4). **SRS:** FR-AI-01..12; §8; SEC-07/12/17.

## Outcome

Use AI to accelerate structured website delivery without giving it direct authority over a customer site, data boundary or billing balance.

## Authoritative flow

```text
Authorized prompt + selected scope → rate/entitlement check → reserve credits
→ model router → untrusted PatchOperation[] → schema + policy validation
→ repair (max 2) or refund → diff preview → user accept/reject
→ optimistic draft apply + ChangeSet/audit → commit/refund ledger
```

Models are configuration, not hard-coded identifiers. Light tasks and heavy creative tasks route separately. The model sees minimum necessary context; secrets, full cross-tenant data and instruction-bearing uploads are excluded. The output cannot persist unless it validates and a user accepts it.

## Credits, quality and automation

Credit ledger is append-only: reservation, commit or refund with idempotency key; never decrement a mutable balance after model use. Enforce user/workspace token buckets, global provider concurrency/backoff, budget visibility and clear 429 response. Evals use fixed fixtures per template/category, schema-validity and regression metrics. Publish-time SEO suggestions are accepted-by-default patches, still editable/audited.

## Failure rules and evidence

Timeout, malformed response, failed repair, insufficient credits and duplicate request must not alter draft or overspend. Test prompt injection, cross-tenant leakage, patch path allowlist, idempotency, concurrent reservation and provider outage. Read SRS §8, ADR-008 and Spike C report before implementation.
