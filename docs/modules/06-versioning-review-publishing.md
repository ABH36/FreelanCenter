# 06 — Versioning, Client Review and Publishing

**Status:** Planned (P3). **SRS:** FR-PUB-01..07, FR-PRJ-02.

## Outcome

Turn an editable draft into reviewable and live immutable versions with atomic rollback. A deployment is a data-pointer change, not mutable production editing.

## State and flow

```text
Draft + expected revision → preflight → immutable SiteVersion(staging/live)
→ protected review URL + comments/approval → atomically change live pointer
→ cache invalidation → audit/notification

Rollback → authorize → point live to prior immutable version → invalidate cache → audit
```

Preflight blocks invalid schema, unsafe/missing form destination and other blocking rules; warns on placeholders, alt text, contrast, SEO and mobile overflow. Client approval is tied to exact version, actor and time. Staging is protected/noindex and excluded from analytics.

## Safety rules

- Deduplicate publish requests by idempotency key and expected draft revision.
- Never mutate a SiteVersion; assets/config must remain available through retention windows.
- Cache invalidation must be host/version scoped; failure leaves prior live pointer active.
- Approval policy is server-enforced per workspace.

**Data model (P3 S1).**

- `site_versions` is immutable for every role: there is no grant, and triggers refuse UPDATE, DELETE and TRUNCATE.
- `site_pointers` holds one staging and one live pointer per project. A pointer accepts only a version of its own project and kind.
- Publish policy Q15 is enforced in RLS: editors may publish staging only, and owners and admins publish live.
- Visitors (`app_public`) cannot read any of these tables; S7 adds the published-version function.

## Evidence

Integration tests for atomic publish, retry, stale revision, preview access, comments, approval and rollback; visual/JSON diff snapshots; public-host cache tests. Upstream: Modules 02/04/05. Downstream: domains, leads, SEO, export.
