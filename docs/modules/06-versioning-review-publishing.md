# 06 — Versioning, Client Review and Publishing

**Status:** P3 S7a built and approved (publish to staging/live, preflight, review links, live site source; `docs/reports/PHASE_3_S7A_PUBLISHING.md`). P3 S7b built (history, diff, side-by-side preview, rollback, restore into the draft; approved by the Owner 2026-11-16, `docs/reports/PHASE_3_S7B_HISTORY_ROLLBACK.md`). P3 S8a built and approved by the Owner 2026-11-18, merged in PR #98 (client review: comments pinned to sections, approval, replies; `docs/reports/PHASE_3_S8A_CLIENT_REVIEW.md`). P3 S8b approved by the Owner 2026-11-18, live migration applied before the merge (approval gate before Live, automatic review statuses, review notifications; `docs/reports/PHASE_3_S8B_APPROVAL_GATE.md`). **SRS:** FR-PUB-01..07, FR-PRJ-02.

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

**Client review (P3 S8a, plan approved 2026-11-16, migration `20261116120000_p3_s8a_client_review`).**

- Tables: `review_comments` (SRS ReviewComment: version, link, page and section pin or none = whole site/page, author kind client/member, client name and optional e-mail, keyed IP hash, body ≤ 2000, `parent_id` for a member reply, resolution) and `review_approvals` (one per link and version, immutable, name, optional e-mail, IP hash). Guards set authors and times; a reply takes project, version, link and pin from its client comment; only resolution changes; nothing is deleted.
- RLS: members read; owners/admins/editors reply and resolve; app_user can never write a client comment or an approval.
- Visitor functions (app_public), each re-checking the link (revoked, expired, paused/archived project, suspended workspace): `add_review_comment` (answers ok/stale/no_section/invalid/limit or the link state; the version must be the one the link shows now; the page/section must exist in it; 300 client comments per version under an advisory lock), `approve_review_version` (ok/already; audit `review.version_approved`, actor_type client), `get_review_thread` (the link's comments and replies on the version, no e-mail/IP/member identity), `get_review_approval`. Helper `review_link_target` executable by no role.
- Sites: on a staging link every shown section ends with "Comment on this section" and the banner links "Comments and approval" (renderer `review` option, review mode only). Panel `/s/<token>/_review`: approve form, comment form with a pin dropdown (whole site, page, shown section), the thread; no script, CSP `form-action 'self'`; POST `/_review/comment|approve` → 303 back with `?done=`. Same-origin check (Origin, else Sec-Fetch-Site), form bodies ≤ 16 KB, honeypot, Upstash limits 30/h per link and 10/min per IP (fail open), IP kept as HMAC. English and Hindi.
- Dashboard: `review.feedback` (any member), `review.reply`, `review.setResolved` (owner/admin/editor; audits `review.comment_replied/resolved/reopened`, ids only); editor "Client feedback" panel with the open count in the menu, "Show in editor"; approval line in the Publish panel; "Approved by" badge in the history; audit labels.

**Approval gate, statuses and notices (P3 S8b, plan approved 2026-11-18, migration `20261118120000_p3_s8b_approval_gate`).**

- Policy `workspaces.require_client_approval` (FR-PUB-06), default off; owners and admins switch it in Workspace settings → Client review (`setClientApprovalPolicy`, audit `workspace.client_approval_policy_changed`).
- Gate: with the policy on, a Live publish needs a `review_approvals` row of the project whose version has exactly the checksum the new Live version gets (canonical config + image snapshot); otherwise `APPROVAL_REQUIRED`. The service checks it and the BEFORE INSERT trigger `site_versions_approval_gate` repeats it (P5105). Any approval of the project counts, also through a link turned off later. Staging and rollback are not gated. The Publish panel shows "Before Live: approved / needs the client's approval" and disables Live with the reason.
- Statuses (FR-PRJ-02): an AFTER INSERT trigger on `staging_links` moves Draft → In review, and `approve_review_version` moves In review → Approved, both through `review_set_status` as svc_definer with a transaction flag that `projects_guard` recognises; audit `project.status_changed` with actor type `system` and a reason. Nothing moves from any other status; members cannot use the system move.
- Notices: `review_notify` writes `review.client_approved` at once and `review.client_commented` at most once per link per 15 minutes, to the project's creator, owners and admins by their choices for `project.client_review` (default in-app and e-mail on), plus an e-mail outbox row that the sweep dispatches. Payloads are ids and the version number only.
- A refused review POST (cross-site) now gets the styled review page with a link back, still 403 (DG-37 (g)).

**Review polish (P3 S8c, plan approved 2026-11-18, no migration; DG-37 (j)).**

- A Live publish by an owner or admin of an Approved project (with an active platform subdomain) moves it to Live in the same transaction: audit `project.status_changed` as that member with `reason: published_live`, creator notified. Other statuses are not moved by a publish.
- `publishing.status` returns `approval.stagingCoversDraft`; the Publish panel marks an approval "(for earlier content …)" when the draft changed since the staging version.
- A review link that moves Draft → In review notifies owners and admins (not the link's maker) with `project.review_requested`.
- Audit viewer shows the from → to of status rows, on/off of the policy row and "System" for system actors; dashboard times are IST (`apps/dashboard/lib/time.ts`).

## Evidence

Integration tests for atomic publish, retry, stale revision, preview access, comments, approval and rollback; visual/JSON diff snapshots; public-host cache tests. Upstream: Modules 02/04/05. Downstream: domains, leads, SEO, export.
