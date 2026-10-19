# 10 — Marketplace and Template Licensing

**Status:** Planned (P6). **SRS:** FR-MKT-01..12.

## Outcome

Enable a safe two-sided template marketplace without allowing untrusted code or losing creator IP. Marketplace depends on working templates, billing/entitlements, moderation and payout capability.

## Contracts and flow

```text
Creator package (declarative config/assets/manifest) → automated validation
→ security/content/performance vetting → human queue when required
→ approved version → browse/demo → purchase → TemplateLicense
→ add to workspace/project under entitlement
```

Template versions use semver and projects remain pinned until an explicit, diffed upgrade. A paid template’s export eligibility comes from the licence, not the export format. Free, workspace-owned and Exportable paid licences follow the SRS export policy; own customer data remains exportable.

## Safety and evidence

Reject executable template code, malicious URLs, unlicensed/unsafe assets, schema invalidity and banned content. Payment/refund/payout events are idempotent and auditable; payout holds and tax/KYC policy require provider/legal approval. Test licence enforcement at API level, takedown, upgrade migration, duplicate submissions, refund race and no-leak export denial. Read ADR-004, ADR-011 and SRS D13.
