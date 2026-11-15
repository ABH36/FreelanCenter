# 06 — Versioning, Client Review and Publishing

**Status:** P3 S7a built (publish to staging/live, preflight, review links, live site source; awaiting Owner approval, `docs/reports/PHASE_3_S7A_PUBLISHING.md`). S7b (history, diff, rollback) and S8 (client review) planned. **SRS:** FR-PUB-01..07, FR-PRJ-02.

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
- Visitors (`app_public`) cannot read any of these tables; S7a adds two visitor functions (below).

**Publishing (P3 S7a).**

- `publishing.publish` (packages/workspaces/src/publishing.ts): publish key replay → draft row lock → expected revision → preflight (blocking refuses) → image URL snapshot (`site_versions.assets`) → checksum → version (number set by the database) → pointer → Live only: `sites.hosts.changed.v1` outbox row. One transaction with its audit row.
- Roles: `site.publish_staging` (owner, admin, editor) for staging and review links; `site.publish` (owner, admin) for live.
- Preflight (`preflight.ts`): blocking for Live = schema, template demo contact details, broken links/contact buttons; for Staging only schema blocks. Warnings: form destination (until P5), placeholder text, weak alt text, contrast, SEO, long words, empty home page.
- Review links: `staging_links` rows + `s1.` HMAC tokens (preview secret, domain-separated), 14 days, revocable, `/s/<token>` on the preview host, always the current staging version.
- Visitor path: `resolve_host` outcome `live` carries the live version id; `get_published_version(id)` returns a live version's content (cached in process by id); `get_staging_site(link)` answers ok/revoked/expired/unavailable/unknown. Live pages are `public, max-age=0, s-maxage=60`; host-cache invalidation on every live publish. CDN purge and the staging host form wait for the sites domain (DG-33).

## Evidence

Integration tests for atomic publish, retry, stale revision, preview access, comments, approval and rollback; visual/JSON diff snapshots; public-host cache tests. Upstream: Modules 02/04/05. Downstream: domains, leads, SEO, export.
