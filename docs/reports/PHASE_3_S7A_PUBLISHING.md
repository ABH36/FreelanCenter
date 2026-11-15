# Phase 3, slice S7a: publishing, preflight, staging links and the live site source

> **Decisions S7a-1 and S7a-2 (section 3) were delegated by the Owner on 2026-11-15** ("decide what is best and enterprise for our product, real users and the real market") and taken as recommended: broken links and contact buttons block Live (warning on Staging); the project workflow status stays independent of publishing, and the approval policy comes with S8 (FR-PUB-06).

**Status:** built on `feat/p3-s7a-publishing`; **approved by the Owner 2026-11-15**; live migration applied 2026-11-15 with the Owner's OK (section 10); PR #90. **Date:** 2026-11-15 · **Requirements:** FR-PUB-01 (publish to staging, protected, `noindex`, no analytics), FR-PUB-02 (publish to live, atomic pointer switch, cache invalidation), FR-PUB-04 (rule-based preflight, blocking vs warning), NFR-PERF-02 (live cache policy, partial) · **ADRs:** 002, 004, 005 · **Module:** 06 · **Design approved by the Owner 2026-11-15** (six decisions, S7a/S7b split). **New migration:** `20261115210000_p3_s7a_publishing` (live application needs a separate Owner OK).

S7b (version history, JSON diff, side-by-side preview, one-click rollback; FR-PUB-03) follows after this slice is approved.

## 1. Why

Until now an edited site could only be seen inside the editor. S7a lets a freelancer publish it: to **Staging**, a review copy the client opens from a link without an account, and to **Live**, the public website at the project's address. Before either, the same checks the server enforces tell them what is wrong.

No sites domain has been bought yet (DG-11), so S7a builds and proves everything that does not need one. Live sites on production wait for the domain (section 8, DG-33).

## 2. What was built

**Database** (migration `20261115210000_p3_s7a_publishing`):

| Change                            | What it does                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_versions.assets`            | The image URLs the version shows (asset id → width → URL), snapshotted at publish. A published page never depends on the asset library                                                                                                             |
| `site_versions.publish_key`       | The browser's idempotency key, unique per project: a retried publish returns the version it already made                                                                                                                                           |
| `site_versions.number`            | 1, 2, 3 … per project, set by the trigger, unique per project. The table stays immutable (S1 triggers, no UPDATE grant)                                                                                                                            |
| `staging_links` (new)             | One row per review link: project, author, 14-day lifetime (CHECK), one-way revocation (guard trigger), no DELETE. RLS like preview links: members read, owners/admins/editors create, revoking also allowed in a suspended workspace (protective)  |
| `resolve_host` (changed)          | New outcome **`live`** with the live version id, exactly when the host would have shown the placeholder and the project has a live pointer. Suspended, paused, archived and unknown are unchanged                                                  |
| `get_published_version(id)` (new) | app_public: the content of one **live** version. A staging version or an unknown id returns nothing                                                                                                                                                |
| `get_staging_site(link)` (new)    | app_public: what a review link may show now: `ok` (the project's current staging version), `revoked`, `expired`, `unavailable` (paused/archived/deleted project, suspended workspace, nothing on staging) or `unknown`. Names the sender for pages |

svc_definer, which owns the visitor functions, gains column-level SELECT on exactly the columns they read, through new `definer_select` policies.

**Publishing service** (`packages/workspaces/src/publishing.ts`), one RLS transaction per publish with its audit row:

1. replay by publish key (same key, other kind = `IDEMPOTENCY_MISMATCH`);
2. `SELECT … FOR UPDATE` on the draft row, so publishes of one project are serialised and the version number is gap-free;
3. the revision must be the one the person saw, otherwise `DRAFT_CONFLICT`;
4. preflight on that exact config; any blocking check refuses with `PREFLIGHT_BLOCKED` and the reasons;
5. image URL snapshot, SHA-256 checksum over the canonical config and assets;
6. version insert, pointer upsert;
7. Live only: a `sites.hosts.changed.v1` outbox row, so apps/sites forgets the project's cached host answers immediately after commit (decision 5).

Roles (decision 4, Q15): new capability `site.publish_staging` (owner, admin, editor) for staging and review links; Live stays `site.publish` (owner, admin). The S1 RLS policies enforce the same rule underneath.

**Preflight** (`packages/workspaces/src/preflight.ts`), a pure function, so the editor shows exactly what the server enforces:

| Rule             | Live                        | Staging  | What it catches                                                                                                                   |
| ---------------- | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| schema           | blocking                    | blocking | the draft is not a valid SiteConfig                                                                                               |
| demo-contact     | **blocking** (decision 3)   | warning  | the template's sample business name, phone, WhatsApp or e-mail is still on the site (compared by digits / case-insensitively)     |
| broken-link      | **blocking** (S7a-1, below) | warning  | a button or text link to a page or section that does not exist or is hidden; a call/WhatsApp/e-mail button with no number/address |
| form-destination | warning (decision 2)        | warning  | a contact form is shown, but messages are not delivered until lead capture exists (P5); becomes blocking then                     |
| placeholder-text | warning                     | warning  | text added by "Add section" left unchanged                                                                                        |
| alt-text         | warning                     | warning  | an image description shorter than 5 characters or generic ("image", "IMG_2041.jpg")                                               |
| contrast         | warning                     | warning  | theme colours below WCAG AA (the S5 checks)                                                                                       |
| seo              | warning                     | warning  | a page without a search title or description                                                                                      |
| mobile-overflow  | warning                     | warning  | a word longer than 28 characters that cannot wrap on a 320 px phone                                                               |
| empty-page       | warning                     | warning  | the home page shows no section                                                                                                    |

Hidden sections are not checked. Each rule lists at most 8 places and summarises the rest. Messages name the place ("Home > Contact") and never echo more than a short label of content.

**Review links** (decision 1): `https://<preview host>/s/<token>`, token `s1.<claims>.<HMAC>` with claims `lid`, `iat`, `exp` only (`packages/hosting/src/staging-token.ts`). It reuses the preview secret and its rotation, domain-separated by the `s1.` prefix, which is part of the signed input: a preview token can never verify as a staging token or the other way round (tested). 14 days at most, at most 10 active per project. The token is stateless and minted again from the row, so the dashboard can show the link again without storing it.

**Sites app:**

- `createVersionSiteSource`: live versions through `get_published_version`, kept in process by version id (immutable, 30 entries). Publishing or rolling back changes the id the host resolves to, never the cached content.
- `versionAssets`: the snapshot is untrusted; only URLs on one https origin (http on localhost/127.0.0.1 for development) are kept, and that origin is the only extra `img-src` in the CSP.
- Live pages: `Cache-Control: public, max-age=0, s-maxage=60` (decision 5). Everything else stays `no-store`.
- `/s/<token>` on the preview host only: verify first, then `get_staging_site`; banner "Staging version of … This is not the live website.", `noindex`, `no-store`, `no-referrer`, no lead form, internal links keep the token. Own pages for invalid, expired, withdrawn and unavailable, naming the sender. A database failure is a 503 (fails closed).
- Host cache key prefix `v1` → `v2` (the value can now carry the version id; old entries just expire).

**Dashboard:** a **Publish** part in the editor: current Live and Staging version (number, time, who), the project address with "The live address will work once the sites domain is set up", Staging/Live choice (Live explained as owner/admin-only for editors), the checks for the chosen target, an optional note, the publish button (disabled while anything must be fixed; pending edits are saved first), and review links (create, copy, open, turn off). Five server actions in `app/actions/publishing.ts`, each registered with the IDOR harness.

## 3. Findings and decisions

- **S7a-1 (delegated by the Owner 2026-11-15, adopted): broken links block Live.** The approved design named the demo-content and form rules; for broken links I chose blocking for Live and warning for Staging, because a visitor who taps "Call now" on a site with no phone number reaches nothing. Changing it to a warning is one line.
- **S7a-2 (delegated by the Owner 2026-11-15, adopted): the project status stays independent of publishing.** Publishing to Live does not change the project's workflow status (draft/in review/approved/live, FR-PRJ-02) and the status does not stop a publish; only paused and archived hide or block the site, as before. Tying them together would bypass the status transition rules and notifications. Kept this way; S8 (client approval) adds the workspace policy "require approval before Live" (FR-PUB-06), which is the right place for a rule that ties review status to going live.
- **Finding: the local asset origin is `http://127.0.0.1:59090`.** The first version of the snapshot reader accepted http only on `localhost`, and the CSP allowed https only, so local and CI images on a published page would have been blocked. Fixed: http on localhost/127.0.0.1 is accepted only on non-secure (local) responses; tested both ways.
- **Finding: the business name counts as demo content.** The integration test first changed only the phone and Live stayed blocked by the template's business name. That is decision 3 working as approved (name, phone, e-mail).

## 4. Security review

- **Visitor role:** app_public gains exactly two functions; `tests/isolation` proves it executes exactly seven, reads no relation, and the result shapes. Version ids reach `get_published_version` only from `resolve_host`, server side; staging link ids only after the signature check.
- **Token:** constant-time HMAC before parsing, closed claim set, canonical base64url, lifetime ≤ 14 days, `iat` not from the future, rotation, domain separation from preview tokens. A forged token causes no database query (tested).
- **Tenant isolation:** `staging_links` has a row factory in the isolation matrix (insert, update, delete across tenants refused); five new IDOR probes (`publishingStatus`, `preflight`, `publish`, `createStagingLink`, `revokeStagingLink`) and B's versions/links in the victim state.
- **Integrity:** versions immutable; pointer can only point at a version of its own project and kind (S1 trigger); idempotency key unique per project; publish serialised by the draft row lock.
- **Content:** the stored config is re-validated by the renderer on every request; snapshot URLs are filtered to one origin; no script on any tenant page; staging responses carry `no-referrer` so the token never leaves in a Referer.
- **Audit:** `site.published_staging`, `site.published_live` (kind, number, revision, warning and image counts, note yes/no), `staging_link.created`, `staging_link.revoked`. No content, no token.

## 5. Tests and evidence

| Suite                                                  | Result                                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` `db:verify` (local)                      | 42/42                                                                                                                                                                                                                             |
| `packages/db` catalog integration                      | 18/18 (definers, executors, app_public set, trigger functions)                                                                                                                                                                    |
| `packages/hosting` unit                                | 40/40 (staging token: round trip, expiry, 14-day cap, rotation, domain separation, closed claims, tampering; live cache encoding)                                                                                                 |
| `packages/auth` rbac                                   | 137/137 (`site.publish_staging` row)                                                                                                                                                                                              |
| `packages/workspaces` unit                             | 105/105 (preflight: 9 rule tests)                                                                                                                                                                                                 |
| `packages/workspaces` integration `publishing.test.ts` | 6/6: decision 3 levels; editor staging, replay, live refused; stale revision, blocked reasons, viewer refused; live via resolve_host + cache invalidation + numbers; review link lifecycle; IDOR                                  |
| `apps/sites` unit                                      | 72/72 (staging pages, forged token never hits the database, fail-closed 503, live cache policy, version read once, snapshot origin filter, local CSP origin)                                                                      |
| `tests/isolation`                                      | 360/360 (staging_links factory, 5 new IDOR probes, app_public surface)                                                                                                                                                            |
| `tests/e2e`                                            | 18/18 (new journey: staging with warnings, review link without an account, Live blocked by demo details, fixed, Live published, the cached placeholder host serves the version at once with `s-maxage=60`, link turned off = 410) |

## 6. CI-equivalent

Clean worktree `C:/Users/Lenevo/s7a-wt` at `1307aa2`, fresh database (`db:down` → `db:up` → bootstrap ×2 → migrate → configure).

| Step                                                                                    | Result                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install, format, sync-plan, generate, lint, typecheck, unit, traceability, build, audit | pass                                                                                                                                                                                                                                                                                                       |
| bootstrap ×2, migrate, configure, drift (none), `db:verify`                             | pass (42/42)                                                                                                                                                                                                                                                                                               |
| db integration ×2                                                                       | **first run failed**: the `packages/db` isolation suite seeds one row per tenant table and had none for `staging_links`. Seed row added (`1307aa2`); then 167/167 twice                                                                                                                                    |
| isolation, mutation                                                                     | pass (360/360)                                                                                                                                                                                                                                                                                             |
| auth integration ×3                                                                     | runs 1 and 3 pass; run 2 had one Google-2FA test time out after the machine stalled (47 min on a 60 s test). No auth code changed in S7a; rerun 213/213                                                                                                                                                    |
| workspaces, jobs, hosting integration                                                   | pass (jobs 8/8, hosting 46/46)                                                                                                                                                                                                                                                                             |
| e2e                                                                                     | 18/18                                                                                                                                                                                                                                                                                                      |
| a11y, lighthouse                                                                        | **first run failed**: the quality harness (`tests/quality/src/serve.ts`) answered hosts with `placeholder`, which no longer loads a site (only `live` does), so every page was "coming soon". Harness switched to `live` (`1307aa2`); then a11y 114/114, Lighthouse 100/100/100/100 on all three templates |
| visual, browsers                                                                        | fail on Windows as in every earlier slice (font rendering against Linux baselines: page height 13341 vs 13238 px; Firefox/WebKit 7/14). GitHub CI (Linux) is the reference                                                                                                                                 |
| perf                                                                                    | pass                                                                                                                                                                                                                                                                                                       |
| gitleaks                                                                                | no leaks (216 commits; run on the main checkout because a worktree's `.git` is a file)                                                                                                                                                                                                                     |

## 7. Cost

No new service and no new subscription. Everything runs on the existing free tiers (Supabase, Upstash, Vercel Hobby, see DG-34). The live cache policy needs no paid CDN feature.

## 8. Left for the domain (recorded in DG-33)

1. Live public sites on production: wildcard DNS `*.<sites-domain>`, the Vercel wildcard domain and TLS, and `sites_domain` in platform settings.
2. The staging host form `<project>-staging.<sites-domain>` on production (decision 1: built later on the same `get_staging_site` function; the signed link is the production form until then).
3. Real-host cache and SEO proof (CDN purge on publish and rollback, sitemap and robots on the real host).
4. Production end-to-end: publish to Live, open the live address.

Until then the dashboard says "The live address will work once the sites domain is set up", and review links work on the current preview host.

## 9. Open items

- ~~Owner approval of S7a~~ approved 2026-11-15 (S7a-1 and S7a-2 decided, see the note at the top).
- ~~Live migration~~ applied 2026-11-15 (section 10).
- Production check with the Chrome extension after the merge (Owner OK 2026-11-15): Staging publish and review link on the preview host.
- S7b: history, diff, rollback.

## 10. Live application (2026-11-15, Owner-approved)

Run from the developer machine against the Supabase `ap-south-1` project as `migrator` (not a superuser, no BYPASSRLS), **before** PR #90 is merged: the migration only adds objects and keeps `resolve_host`'s first three columns, so the code on production keeps working, and the merged sites code reads the new `site_version_id` column as soon as it is deployed. No secret was printed or stored.

| Step                                                     | Result                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only pre-check (read-only transaction, rolled back) | remote host, role `migrator`, not privileged; 13 migrations, none unfinished or rolled back, latest S6 (matches `main`); S7a not recorded; `app.staging_links` absent; the three new `site_versions` columns absent; `resolve_host` returned `(outcome, workspace_id, project_id)` |
| `prisma migrate deploy` (`DB_TARGET=env`)                | applied `20261115210000_p3_s7a_publishing`                                                                                                                                                                                                                                         |
| `prisma migrate status`                                  | database schema is up to date (14 migrations)                                                                                                                                                                                                                                      |
| Live database vs `schema.prisma`                         | no difference detected                                                                                                                                                                                                                                                             |
| `db:verify --target env`                                 | **42 passed, 0 failed** (new: two definers, app_public set, `staging_links` unreadable, unknown version and link answers)                                                                                                                                                          |
| `test:live`                                              | two runs: 6 passed, 1 skipped (unchanged)                                                                                                                                                                                                                                          |

**PR #90 CI, first run:** every job green except "Database roles, RLS and tenant isolation": the `packages/db` integration coverage gate measured 79.48 % branches (gate 80 %), because the new public-client functions had no test in that package. Added `test/integration/publishing-public.test.ts` (live outcome, `get_published_version` live/staging/unknown, `get_staging_site` ok/expired/revoked/unavailable/unknown through the real app_public client): 170/170, branches 85.89 % on a fresh local database. My local CI-equivalent missed it because its rerun of that step was without `--coverage`.
