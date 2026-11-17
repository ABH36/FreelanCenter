# Phase 3, slice S8a: client review (comments pinned to sections, approval, replies)

**Status:** built on `feat/p3-s8a-client-review`; awaiting CI-equivalent (section 6) and Owner approval. **Date:** 2026-11-16 · **Requirement:** FR-PUB-05 (Client Review Mode: pinned comments on blocks/sections, ReviewComment; the client comments and clicks Approve through the tokenised review link; the approval is recorded with who, when and which version) · **ADRs:** 002, 004, 005 · **Modules:** 06 (08 for the later portal) · **Plan approved by the Owner 2026-11-16** with all seven decisions as recommended (section 3). **Migration:** `20261116120000_p3_s8a_client_review`; the live database needs a separate Owner OK (DG-37 (a)).

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

Filled after the e2e and CI-equivalent runs.

## 6. CI-equivalent

Pending.

## 7. Cost

No new service or subscription. The rate limits use the existing Upstash database (two small counters per POST, well inside the free tier). No e-mail is sent in S8a.

## 8. Left for the domain

Unchanged (DG-33): review links stay on the preview host path `/s/<token>`; the `<project>-staging.<sites-domain>` host form waits for the domain. The whole S8a flow works on production today through the preview host.

## 9. Open items

- Owner approval of S8a.
- After the merge: live migration with a separate Owner OK (DG-37 (a)), then a production check with the Chrome extension (comment from a section link, approve, reply, mark done, client sees the reply; console errors in a clean profile).
- S8b (DG-37 (b)).
