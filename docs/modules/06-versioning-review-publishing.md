# 06 — Versioning, Client Review and Publishing

**Status:** P3 S7a built and approved (publish to staging/live, preflight, review links, live site source; `docs/reports/PHASE_3_S7A_PUBLISHING.md`). P3 S7b built (history, diff, side-by-side preview, rollback, restore into the draft; awaiting Owner approval, `docs/reports/PHASE_3_S7B_HISTORY_ROLLBACK.md`). S8 (client review) planned. **SRS:** FR-PUB-01..07, FR-PRJ-02.

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

**History and rollback (P3 S7b, plan approved 2026-11-16, no migration).**

- `publishing.history`: versions newest first, 20 per page (cursor = the last version id; UUID v7 tie-breaker), filter all/live/staging, author name, note, time, which one is on Live/Staging now. Any member.
- `publishing.compare` + `version-diff.ts` (`diffConfigs`): what changed between two versions of one project, by what a freelancer recognises (business detail, theme, menu, footer, page added/removed/moved/renamed/search fields, section added/removed/moved/hidden/shown/layout/field), short plain-text before/after, at most 200 entries. Pure function, unit-tested.
- `publishing.getVersion` + dashboard route `/version-preview/<slug>/<versionId>`: a stored version rendered like the editor preview (no script, `frame-ancestors 'self'`, noindex) with the version's own image snapshot, filtered to the asset origin. The history page shows two of them side by side.
- `publishing.rollback`: Live pointer to an earlier **live** version (staging versions refused, `ROLLBACK_TARGET`); owners/admins (`site.publish`, and the S1 `publisher_update` policy underneath); the live version the person saw must still be on Live (`LIVE_CHANGED`); a retry finds Live already there and changes nothing; the target must still parse; no preflight (it passed at publish; rollback is the emergency path); pointer row locked `FOR UPDATE`; `site.rolled_back` audit (from/to numbers); `sites.hosts.changed.v1` outbox for host-cache invalidation. Archived projects refused.
- `builder.restoreVersion` (Owner decision 1): any stored version back into the draft as one change set (`restoreVersion` operation, inverse `restoreConfig` = the whole previous draft), so Undo/Redo work; needs the edit lock (the dashboard action takes and returns it when free), the expected revision and a change id; `draft.version_restored` audit. Live and Staging untouched.
- Follow-ups on record in DG-36 (notifications, pixel diff, hidden images, size limit).

## Evidence

Integration tests for atomic publish, retry, stale revision, preview access, comments, approval and rollback; visual/JSON diff snapshots; public-host cache tests. Upstream: Modules 02/04/05. Downstream: domains, leads, SEO, export.
