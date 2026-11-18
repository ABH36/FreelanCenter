# Phase 3, slice S8a: client review (comments pinned to sections, approval, replies)

**Status:** built on `feat/p3-s8a-client-review`; CI-equivalent and e2e green (sections 5-6); **approved by the Owner 2026-11-18**; merged in PR #98 (`fb73c5f`). **Date:** 2026-11-16 · **Requirement:** FR-PUB-05 (Client Review Mode: pinned comments on blocks/sections, ReviewComment; the client comments and clicks Approve through the tokenised review link; the approval is recorded with who, when and which version) · **ADRs:** 002, 004, 005 · **Modules:** 06 (08 for the later portal) · **Plan approved by the Owner 2026-11-16** with all seven decisions as recommended (section 3). **Migration:** `20261116120000_p3_s8a_client_review`; the live database needs a separate Owner OK (DG-37 (a)).

## 1. Why

S7a gave the freelancer a review link to the staging version, but the client could only look. Feedback came back over WhatsApp as "change the second photo", with no record of which version the client saw or whether they agreed it could go live. S8a lets the client comment on the exact section and approve the exact version through the same link, without an account, and gives the freelancer one place to answer and tick off each comment.

## 2. What was built

**Database** (migration `20261116120000_p3_s8a_client_review`):

| Object                                                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review_comments`                                       | SRS ReviewComment. Version, review link, pin (page and section of that version, a page, or none = the whole site), author kind (`client` / `member`), the client's name, optional e-mail and keyed IP hash, body (1-2000 characters), `parent_id` for a member's reply, resolution (who, when). The guard sets authors and times, gives a reply its parent's project, version, link and pin, allows only resolving/reopening a client comment, and refuses delete and truncate |
| `review_approvals`                                      | One approval per link and version: name, optional e-mail, IP hash, time. Immutable (decision 6)                                                                                                                                                                                                                                                                                                                                                                                |
| RLS                                                     | Members read both. Owners, admins and editors insert replies (`author_kind = member` only, project not archived) and resolve. No application role can write a client comment or an approval directly                                                                                                                                                                                                                                                                           |
| `add_review_comment` (app_public)                       | Checks the link again (revoked, expired, paused/archived project, suspended workspace), that the version is the one the link shows now (`stale` otherwise), the bounds (`invalid`), that the page/section exists in that version (`no_section`), and the cap of 300 client comments per version under an advisory lock (`limit`)                                                                                                                                               |
| `approve_review_version` (app_public)                   | Same link and version checks; `ok` writes the approval and an audit row `review.version_approved` (actor type `client`, ids and the version number only); a second approval through the same link is `already`                                                                                                                                                                                                                                                                 |
| `get_review_thread`, `get_review_approval` (app_public) | What a link may show: its own comments and replies on that version, without e-mail, IP hash or member identity; nothing for a link that may not show now                                                                                                                                                                                                                                                                                                                       |
| `review_link_target`                                    | Helper the four functions share; executable by no role                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Sites app** (`apps/sites/lib/review.ts`, `staging.ts`, `serve.ts`, the route's new `POST`):

- On a staging link, every shown section ends with "Comment on this section (Services)" and the banner links to "Comments and approval". The renderer adds these only when asked (`review` option); live sites and previews are unchanged.
- **Review panel** `/s/<token>/_review`: who shared it and when the version was published, a result message, the approve form (name, optional e-mail, "I approve this version of the website"), the comment form (where: whole website, a page, or any shown section, preselected from the link the client came from; comment; name; optional e-mail), and the link's comments with the freelancer's replies and a "Done" mark. English or Hindi by the site's language.
- **No script anywhere**: plain HTML forms. `POST /s/<token>/_review/comment|approve` answers `303` back to the panel with `?done=<result>` (post/redirect/get). The panel's CSP is `default-src 'none'`, a hashed style, `img-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`; the site pages keep `form-action 'none'`.
- **Abuse:** a POST must come from the review page itself (`Origin` equal to the preview origin, or `Sec-Fetch-Site: same-origin` when no Origin is sent), otherwise 403; form bodies only, at most 16 KB; a honeypot field (a bot that fills it is told "sent" and nothing is stored); Upstash fixed-window limits of 30 posts per link per hour and 10 per IP per minute (per process locally; a store failure lets the request through and logs it, the database cap still holds); the IP is kept only as an HMAC with the preview secret, domain-separated (`review-ip:v1:`). Every other POST on any host is 405, as before.
- `KeyValueStore.incr` (SET NX EX then INCR, so a counter always expires) in `@platform/providers`.

**Dashboard:**

- `review.feedback` (any member): the project's client comments newest first, with version number, pin, name, e-mail, resolution and replies, plus the approvals; `review.reply` and `review.setResolved` (owners, admins, editors; audit `review.comment_replied`, `review.comment_resolved`, `review.comment_reopened` with ids only). Three server actions, registered with the IDOR harness (new selector `reviewCommentId`).
- Editor: **Client feedback** in the menu with the number of open comments; the panel lists approvals and comments (Open / All), each with "Show in editor" (opens the pinned section when the draft still has it, otherwise says it was removed), "Mark done" / "Open again" and a reply box ("they see it on the review page").
- Publish panel: "Client approval: Approved by … / Not approved yet" for the version on Staging; the review-link text says the client can comment and approve there.
- Version history: an "Approved by …" badge on approved staging versions. Audit log: readable labels for the four review events and "Client (review link)" as the actor of an approval.

## 3. Decisions

Plan approved by the Owner 2026-11-16 ("haan"), all as recommended:

1. **Client identity:** name required, e-mail optional, no OTP. A login portal is P5 (FR-ONB-07).
2. **Project status:** a review link moves Draft → InReview and an approval moves InReview → Approved (system actor, audited). **Built in S8b** (decision 7).
3. **Policy match:** "require client approval before Live" means the draft's checksum equals an approved staging version's checksum; any edit after the approval needs a new approval. **S8b.**
4. **Replies are shown to the client** on the review page. Built.
5. **Notifications:** approval at once; comments grouped per link per 15 minutes. **S8b.**
6. **An approval cannot be withdrawn**: the record is immutable; the client comments instead. A new staging version needs its own approval. Built.
7. **Split:** S8a (this report) and S8b (policy gate, status transitions, notifications, settings toggle).

Design choices inside the plan:

- **Comments only on the version the link shows now.** A comment arriving after a new staging publish answers `stale` ("the website was updated while you were looking"), so a pin always refers to content the client could see. Old comments stay listed with their version number.
- **Pins by section id**, which stays stable across versions and edits. The dashboard names a pin in the draft's current words and says when the page or section was removed.
- **No script, even for a smoother form.** The review page is on the same host as every preview and staging link; keeping it script-free keeps the strict CSP every tenant page has.
- **Rate limits fail open** when Upstash is unreachable: refusing every client because the cache is down is worse, and the database cap bounds the damage (DG-37 (e), reviewed with S9).

## 4. Security review

- **Trust boundary:** the browser-visible token is verified (HMAC, expiry) before any database call; the database functions verify the link state again before every read and write; the link id, workspace and project never come from the form. A hidden field carries only the version id, which must equal the link's current staging version.
- **Tenant isolation:** app_public holds no table privilege (asserted for every product relation); the new tables are in the isolation matrix and IDOR harness (seeded through the visitor functions after the workspace commits; the matrix's cross-tenant and actor-only inserts are refused with 42501). A link of workspace A cannot comment on or read B's version (`stale`, empty thread; tested).
- **CSRF:** a cross-site form is refused (403) before anything is read; there is no cookie or session on the preview host, and the action needs the secret link anyway.
- **XSS:** every value on the panel is HTML-escaped; comment text is shown as text with `white-space: pre-wrap` (no links, no markup); the dashboard renders it through React. Tests post `<script>` and markup in names and bodies.
- **Abuse:** body and field limits in the database and the handler, honeypot, two rate limits, 300 comments per version.
- **Personal data:** client name, optional e-mail and an IP HMAC (privacy inventory and data classification updated). The e-mail and IP hash are never returned to the review page. Audit rows and logs carry ids, numbers and result words only (asserted: no comment text in audit metadata).
- **Integrity:** approvals and client comments cannot be changed or deleted by any member; replies cannot be edited; resolution is stamped by the database.

## 5. Tests and evidence

| Suite                                                                      | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Result                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/db` `review-public.test.ts` (with catalog, helpers, `db:verify`) | Comments on a version: plain, pinned, e-mail lowercased, unknown section `no_section`, bounds `invalid`, after a new staging version `stale`, every link state, another workspace's link. A member reply copies its parent's pin; editors resolve and reopen, with the stamp set by the database. Refused: a reply to a reply (P5103), a viewer (42501), a client comment written as app_user, any edit or delete. Approval `ok`, then `already`, with an immutable record and an audit row. The 300-comment cap holds under a concurrent burst                                     | DB integration 53/53; `db:verify` 47/47            |
| `packages/workspaces` `review.test.ts`                                     | Feedback newest first with version, pin, e-mail and replies; NOT_FOUND for another workspace and for an unknown project; reply and resolve audited with ids only (no comment text); viewer FORBIDDEN; empty reply INVALID_INPUT; another workspace NOT_FOUND                                                                                                                                                                                                                                                                                                                        | 5/5                                                |
| Isolation matrix and IDOR harness                                          | `review_comments` and `review_approvals` seeded through the visitor functions; cross-tenant reads and writes refused; `app_public` has no table privilege and exactly the expected function list; the three new server actions probed with another workspace's ids                                                                                                                                                                                                                                                                                                                  | 395/395 and 122/122                                |
| `apps/sites` `review.test.ts`                                              | Panel HTML and CSP; pin options; escaping of `<script>` and markup; same-origin check (Origin, Sec-Fetch-Site); 16 KB limit; honeypot; both rate limits; `confirm` on approve; mapping of every database result to a message; 405 for other POSTs                                                                                                                                                                                                                                                                                                                                   | 38/38                                              |
| `packages/blocks`, `packages/providers`, `packages/hosting`                | Section and banner review links only in review mode; `KeyValueStore.incr` (SET NX EX then INCR) in memory and Upstash                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 78, 23 and 40 passing                              |
| e2e (`tests/e2e`, Chromium, after the rebase onto Next 16.4.5, 2026-11-18) | New journey "A gets a comment and an approval through the review link, replies, and the client sees the reply". The client opens the link in a fresh context, comments from a section link and approves. The test checks that there are no CSP violations, no cookies and no `<script>`, that the panel passes axe, and that a forged cross-origin POST gets 403. On the member side: open count, panel, reply, mark done, "Show in editor". The client then sees the reply and the Done mark. The approval also shows in the Publish panel, the history badge and the audit labels | 21/21 (S8a journey 40.2s), the whole suite 8.0 min |

## 6. CI-equivalent

Run 2026-11-17 in a clean detached worktree at `62ade56` against a freshly recreated local database. All 28 steps passed:

| Step                                                | Result                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install, format, sync-plan, generate                | pass (Prettier clean; `DEVELOPMENT_PLAN.md` byte-identical to `SRS.md`)                                                                                                            |
| lint, typecheck, unit (whole monorepo)              | 18/18, 18/18 and 15/15 tasks                                                                                                                                                       |
| traceability, build                                 | pass; 3/3 build tasks                                                                                                                                                              |
| audit (gate `high`)                                 | pass: no high or critical on 2026-11-17. 3 moderate (`next` GHSA-mfr8-8qww-v76h, since fixed by PR #96; `glob` and `minimatch` in build and dev tools only); recorded in DG-37 (f) |
| db down/up, bootstrap twice, migrate, configure     | pass; the S8a migration applies on a fresh database                                                                                                                                |
| drift                                               | "No difference detected"                                                                                                                                                           |
| `db:verify`                                         | 47 passed, 0 failed                                                                                                                                                                |
| DB integration with `--coverage`, then a second run | pass both times; coverage 95.08% lines, 85.95% branches, 92.13% functions                                                                                                          |
| isolation matrix                                    | pass (report written)                                                                                                                                                              |
| mutation                                            | 13/13 mutations killed; suite green after revert                                                                                                                                   |
| auth integration, twice                             | 213/213 both runs                                                                                                                                                                  |
| workspaces, jobs and hosting integration            | pass                                                                                                                                                                               |
| seed templates                                      | pass                                                                                                                                                                               |

e2e and the quality suite run with the dev servers. Under Next 16.4.3 the e2e webServer exited, because the Next CLI asked for a security upgrade (the GHSA above). Next 16.4.5 was merged in PR #96 on 2026-11-18. That PR also adds the Owner-approved audit exception for `picomatch` GHSA-fc5q-39xc-vjpf (DG-38), whose high advisory has no patched release yet. S8a was then rebased onto `main` (`41fd70d`), and e2e passed 21/21 (section 5). The quality suite (axe, visual, Lighthouse) runs in CI on the PR.

## 7. Cost

No new service or subscription. The rate limits use the existing Upstash database (two small counters per POST, well inside the free tier). No e-mail is sent in S8a.

## 8. Left for the domain

Unchanged (DG-33): review links stay on the preview host path `/s/<token>`; the `<project>-staging.<sites-domain>` host form waits for the domain. The whole S8a flow works on production today through the preview host.

## 9. Open items

- ~~Owner approval of S8a~~: approved 2026-11-18, merged in PR #98.
- ~~Live migration~~: applied 2026-11-18 with the Owner's OK (section 10). ~~Production check~~: passed 2026-11-18 after the PR #100 fix (section 11). It covered with the Chrome extension (comment from a section link, approve, reply, mark done, client sees the reply; console errors in a clean profile).
- S8b (DG-37 (b)), with the friendly refusal page (DG-37 (g)). Token in the platform logs: DG-37 (h).

## 10. Live application (2026-11-18, Owner-approved)

The Owner approved the live migration in writing on 2026-11-18, after the PR #98 merge. It was run from the developer machine against the Supabase `ap-south-1` project as `migrator`, which is not a superuser and has no BYPASSRLS. Production deployed `fb73c5f` at 05:03 UTC and the migration finished a few minutes later. During that gap, the history page, the feedback panel and the review page could fail on production, because their tables and functions did not exist yet. The migration only adds objects, so nothing that was already running was affected. No secret was printed or stored.

| Step                                                     | Result                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only pre-check (read-only transaction, rolled back) | remote host, role `migrator`, not superuser, no BYPASSRLS; 14 migrations, none unfinished or rolled back, latest S7a; S8a not recorded; neither new table present |
| `prisma migrate deploy` (`DB_TARGET=env`)                | applied `20261116120000_p3_s8a_client_review`                                                                                                                     |
| `prisma migrate status`                                  | database schema is up to date (15 migrations)                                                                                                                     |
| Live database vs `schema.prisma`                         | no difference detected                                                                                                                                            |
| `db:verify --target env`                                 | **47 passed, 0 failed** (new: both review tables unreadable for app_public, four visitor functions, unknown-link answers)                                         |
| `test:live`                                              | two runs: 6 passed, 1 skipped (unchanged)                                                                                                                         |

Lesson for the next migration: apply an additive migration **before** the merge, as S7a did, so that production never runs code whose database objects do not exist yet.

## 11. Production check (2026-11-18, Owner's Chrome extension)

Test project "S8a Check" (Gym Bold, staging version 1, one review link until 2 Dec).

**First run, after PR #98 (`fb73c5f`):**

- Steps 1–3c passed: project, staging publish, review link, banner, the "Comment on this section" link on all 10 sections, and the panel with the section preselected.
- Step 3d **failed**. "Send comment" returned **403 Forbidden** twice.
- Cause: the panel sends `Referrer-Policy: no-referrer`, and under that policy Chrome sends `Origin: null` with its own same-origin form POST. The S8a same-origin check refused `null`.
- Local e2e did not catch this, probably because the development server also adds the site-wide `strict-origin-when-cross-origin` header. This cause has not been verified.
- **Fixed in PR #100 (`915670c`):** an Origin of `null`, or no Origin at all, is accepted only together with `Sec-Fetch-Site: same-origin`. A cross-site or sandboxed `null` origin is still refused. Unit tests cover both cases.

**Re-run of steps 3d–7 after the fix: all passed.**

| Step | Result                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3d–e | Comment pinned to Hero, and a "whole website" comment: "Thank you, your comment was sent", list shows 2                                              |
| 3f   | Approve: "your approval was recorded", form replaced by "Approved by Ramesh Test on …"; a resubmitted form says "already approved through this link" |
| 3g   | No CSP violations                                                                                                                                    |
| 4a–b | "Client feedback" badge 2; approval and both comments with version 1 and their pins                                                                  |
| 4c   | "Show in editor" opened the Hero section                                                                                                             |
| 4d–e | Reply sent; "Mark done" → badge 1, "1 open of 2"; Open/All filter; "Done · Abhishek Jain" with "Open again"                                          |
| 4f–g | Publish: "Client approval: Approved by Ramesh Test · …"; history badge "Approved by Ramesh Test"                                                     |
| 4h   | Audit: `review.comment_replied`, `review.comment_resolved` (member), `review.version_approved` by "Client (review link)" on "Site version 1"         |
| 5    | The client sees the reply, from the workspace name, and the Done mark                                                                                |
| 6    | A cross-site `fetch` POST from the dashboard was blocked and stored nothing (see below)                                                              |

Notes, checked afterwards:

- **Step 6 showed 503 in the extension's network view.** The server answered **403**:
  - The Vercel runtime log has `sites.review.cross_origin` for both attempts.
  - Repeating the same cross-site POST with curl (browser-like headers, no data stored) gives `403 Forbidden`.
  - The status a browser shows for a request blocked by CORS is not reliable.
- **Cookies:** curl shows no `Set-Cookie` on the staging page, the panel or the result page. The extension cannot open DevTools > Application.
- **Console:** two `[EXCEPTION] Object` entries on every page load, on the dashboard as well. One points to `chrome-extension://…/content.js`, so they come from a browser extension. These are the same as in the S7b check.
- **Explained, not changed:**
  - The client sees a reply from the workspace name, not the member's name. This is intended: the review page never shows member identities.
  - The dashboard lists comments newest first (a to-do list), while the review page lists them oldest first (a conversation).
  - A client comment has no audit row. It is itself an immutable record with time, link and version. Approvals, replies and resolutions are audited.

Follow-ups recorded in DG-37 (g) and (h).
