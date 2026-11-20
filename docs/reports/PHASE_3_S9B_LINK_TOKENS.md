# Phase 3, slice S9b: link tokens out of the request path, and the S9a polish

**Status:** approved by the Owner 2026-11-19 ("okay i approve"); merged as PR #108 (`68090ad`); **production check passed 2026-11-20** (section 9). **Date:** 2026-11-19 · **Requirements:** FR-PUB-01 and FR-PUB-05 (review links and client review), FR-TPL-09 (preview links), SEC-11 (no secret tokens leaked through URLs), FR-OBS-01 (logs carry no secrets) · **Modules:** 06, 04, 15 · **Gaps:** DG-37 (h), DG-39 (d) · **Plan approved by the Owner 2026-11-19** ("yes i approve the plan and tumhare reocmmendation bhi sahi hai"): Option A, the paths `/review/<key>` and `/preview/<key>`, and the cookie holding the same signed token. **Migration:** none, so no live database step.

## 1. Why

Vercel's runtime log records the full request path. Review links (`/s/<token>`) and preview links (`/p/<token>`) carried their bearer token in every path: each page, each review panel view, each comment and approval. Anyone who can read the Vercel team's runtime logs could open the link while it is valid (DG-37 (h)). Our own logs carry ids only.

The S9a production check also found two small display inconsistencies and one unexplained click (DG-39 (d)), which the Owner agreed to take into this slice.

## 2. What was built

| #   | Change                                       | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Token exchange on the first request**      | `apps/sites/lib/link-session.ts`. `GET /s/<token>[/<page>]` and `GET /p/<token>[/<page>]`: once the token's signature and expiry verify (before any database work), the answer is `303` to `/review/<link id>[/<page>]` or `/preview/<key>[/<page>]` (query kept) with `Set-Cookie: __Secure-link=<the same token>; Path=/review/<link id>; Max-Age=<until expiry>; HttpOnly; Secure; SameSite=Lax`. `no-store`, `no-referrer`, `noindex`. The key of a preview link without an id is a SHA-256 digest of the token. |
| 2   | **Clean paths read the cookie**              | `staging.ts` and `preview.ts`: on `/review/<key>` and `/preview/<key>` the token comes from the cookie and is verified exactly as before (HMAC, expiry, revocation, the link's database state). The path key must be that token's key, so a cookie opens only its own link. Internal links, the review panel, its forms and the post-redirect-get all use the clean path.                                                                                                                                            |
| 3   | **No cookie: "Open the link you were sent"** | New pages `staging_reopen` and `preview_reopen` (401, `no-store`): a clean address copied from the address bar, or a browser that blocks cookies, is told to open the original link again.                                                                                                                                                                                                                                                                                                                           |
| 4   | **Compatibility**                            | Links already sent keep working (they are entries). A review page opened before S9b posts to `/s/<token>/_review/...`; those posts are still accepted, and their redirect goes through the exchange.                                                                                                                                                                                                                                                                                                                 |
| 5   | **Headers**                                  | `next.config.ts` (sites) adds `Referrer-Policy: no-referrer` for `/s/`, `/review/` and `/preview/` as well as `/p/`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | **Polish (DG-39 (d))**                       | `@platform/ui/time`: the day is no longer zero-padded ("2 Dec 2026, 9:05 am IST", like "2 Dec 2026" elsewhere). Audit log column header "When" (each cell already says IST). **First click in the editor:** the menu buttons (Business details, Theme, Images, Publish, Client feedback, pages, sections) and the form fields stay disabled, shown as waiting, until React has hydrated the page (`useSyncExternalStore` server/client snapshot), so an early click is no longer silently lost.                      |

## 3. Decisions

1. **Option A** (approved in the S9 plan): free, no script on the client's page, works without JavaScript. Not chosen: a token in the URL fragment read by a script (needs JavaScript and a fallback), a log drain (Vercel Pro, and it copies the log rather than cleaning it).
2. **The cookie holds the same signed token** (approved 2026-11-19), so nothing new is trusted and verification is unchanged. A separate session token would add state and code without hiding anything more.
3. **Paths `/review/<key>` and `/preview/<key>`** (approved), readable for the client. The key names the link but opens nothing alone.
4. **The first-click case was fixed only after it was reproduced** (section 5), as the plan required. Disabling until hydration was chosen over capturing early clicks with a script: no extra code on the page, and the waiting state is visible.

## 4. Security review

- **What leaves the log:** every request after the entry carries only the link key in its path. The entry request still has the token (accepted residual). Cookies are not part of the runtime log's path.
- **Cookie:** `HttpOnly` (no page script can read it, and the pages run none); `Secure` on https (local http uses a plain `link` cookie, and a secure host never reads that name); `SameSite=Lax`, so a cross-site POST does not carry it; the review POST keeps its own same-origin check, tested with the cookie present; `Path` limited to the one link, so the browser never sends it to another link or another path of the preview host; `Max-Age` never beyond the token's expiry.
- **Revocation and expiry** still apply on every request: a link turned off after the exchange is refused on the clean path (tested), and an expired token in a cookie gets the expired page.
- **Redirect:** the `Location` is built from a fixed prefix and the verified key; a page path such as `//evil.example` stays under `/review/<key>` (tested). Forged and expired tokens are never exchanged and never set a cookie (tested).
- **Enumeration:** a key alone (link id or digest) answers 401 without any database lookup.
- **No new data stored**, no new secret, no migration.

## 5. Tests and evidence

| Suite                                                                      | Result  |
| -------------------------------------------------------------------------- | ------- |
| `apps/sites` unit (16 new: link-session 4, staging 5, review 3, preview 4) | 109/109 |
| `packages/ui` unit (1 new: day not zero-padded)                            | 40/40   |
| Workspaces integration                                                     | 243/243 |
| Isolation suite                                                            | 402/402 |
| E2E (Playwright; review and preview journeys follow the exchange; 1 new)   | 24/24   |

**E2E changes:** the preview journey now checks that the address leaves `/p/<token>` at once for `/preview/<id>`, that in-site links stay on the clean path, and that the prospect's browser holds exactly one cookie (`link`, HttpOnly, SameSite=Lax, path of that preview). The review journey follows the exchange (`/review/<id>`) and still sees the link withdrawn (410) after "Turn off".

**First click on "Publish" (DG-39 (d)):** a new e2e test opens the editor and clicks "Publish" as soon as the button exists (`waitUntil: 'commit'`) with the CPU slowed six times (Chrome DevTools Protocol). Run alone after a warm-up it passed (also three times in a row), but in the full journey it **failed**: the screenshot shows the button clicked and "Business details" still open. A click before React hydrates the page is lost (React replays early clicks only inside Suspense boundaries). After the fix (menu and fields disabled until hydrated, so Playwright's click waits for them as a person sees them greyed out) the full journey passes (section 6).

## 6. CI-equivalent (local, 2026-11-19)

Branch `feat/p3-s9b-link-tokens` on `fbf928e`. `prettier --check` on every changed file, `sync-plan:check`, `lint` (18 tasks), `typecheck` (18), `test` (15) and `build` (dashboard and sites) pass; `traceability` unchanged. E2E: 24/24 in 10.2 minutes on a quiet machine (2026-11-19). Earlier E2E runs were not counted: one ran while the laptop slept (7.3 hours, timeouts), two while another project's test run and containers loaded the machine (the sites app answered 503), and one hit the known sign-up warm-up flake of the development server; the review journey failed once on its old "no cookie" assertion, which now expects exactly the link cookie.

## 7. Cost

None.

## 8. Open items

- The entry request of each visit still records the token in the Vercel runtime log (accepted with the plan). Only Vercel team members can read it, the Hobby plan keeps it about an hour, and links are revocable and expire.
- DG-39 (b): checked around this slice's merge (section 9); closed with the Owner's decision.
- New DG-40 (page titles keep the template's demo name): a small slice before S9c (Owner, 2026-11-20). S9c (DG-37 (e), abuse baseline) follows.

## 9. Production check (2026-11-20, Chrome extension, Owner-run)

**Merge and deployment.** PR #108 was merged as `68090ad` with the Owner's OK. The production deploy check (run 44677167815) passed for both projects. The server HTML moved from `dpl_2vVE67N47Yg8WKdzpyw3eLXtXPyF` to `dpl_CiuLHdAsKLA41VA4bkYQ1bddds7j`, and health answered 200 on both apps.

**DG-37 (h), evidence from Vercel's request records** (`vercel logs requests`, the three hours around the check): the token paths appeared only as entries, each answered 303 (`/s/` once, `/p/` twice). Every other request used a clean path: `/preview/<key>` 200 three times; `/review/<id>` 200 twice and 401 six times without the cookie; `/review/<id>/_review` 200 once and 401 twice without the cookie. No 503 was recorded.

**DG-39 (b), a tab left open across the deployment.** Before the merge, an editor tab was opened on the old build. The Owner set Chrome to keep the dashboard active (Memory Saver), and the tab was not reloaded in between. Next 16.3+ on Vercel serves content-addressed "immutable" chunks without `?dpl=`, so the builds were compared by chunk file names: 3 of the tab's 12 files were not in the new build, so the tab was still on the old build.

| Step | Checked                                               | Result                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1–3 | New deployment id; old tab still on the old build     | pass                                                                                                                                                                                                                                         |
| A4   | 40 s idle in the old tab (lock renewals)              | no notice; "All changes saved"                                                                                                                                                                                                               |
| A5   | An edit in the old tab                                | pass: "All changes saved" (request 200, audit "Draft changed"), then Undo ("Draft undone"); nothing lost                                                                                                                                     |
| A6   | A header link in the old tab                          | pass: full reload (`performance.timeOrigin` changed), new build's files loaded                                                                                                                                                               |
| 7    | "Publish" right after the editor loads                | pass: disabled at 0 and 423 ms, enabled at 754 ms, one click at 756 ms opened the panel                                                                                                                                                      |
| 8    | Review link: expiry text, clean address, review panel | pass: "Until 2 Dec 2026, 5:24 pm IST"; `/s/s1.…` redirected to `/review/01a1ee82…` and `/review/01a1ee82…/_review`                                                                                                                           |
| 9    | Clean address without the cookie                      | pass by the request records (401, above). The browser check could not run: the review page's CSP blocks script fetches, and the cross-site attempt was blocked in the browser, which the checker reported as 503; the server recorded no 503 |
| 10   | "View demo" preview                                   | pass: `/preview/tTlTAs…`, Pricing `#pricing`; Taxi Quick `/preview/tIqAt0…` → `/rates`                                                                                                                                                       |
| 11   | Audit log header                                      | pass: "When"; rows end in "IST"                                                                                                                                                                                                              |
| 12   | Console, speed, layout                                | pass: only the known extension entries                                                                                                                                                                                                       |

**Reading of A4–A6:** the old build's server actions still matched the new server, because their ids come from a build key that Vercel's build cache keeps, so no stale-build error occurred and the save went through. That is the safe outcome; the reload notice appears only when the ids change, as the E2E test shows. The first navigation moved the tab to the new build (`deploymentId`). **The Owner decided on 2026-11-20 to close DG-39 (b)** on this evidence.

**Observations:**

1. The Publish panel's "Open" and "Copy link" still use the `/s/<token>` address. This is by design: that link is the entry, which the client needs, and it redirects at once.
2. **New gap DG-40:** the staging (and live) page's browser title is the template's demo text ("Iron Pulse Fitness | Gym and personal training") although the business is "S8b Check Gym". Page `seo.title` comes from the template, does not follow the business name, and the editor has no field for it. The Owner chose a small slice before S9c (2026-11-20).
