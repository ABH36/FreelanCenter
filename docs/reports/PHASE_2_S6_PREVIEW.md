# Phase 2, slice 6: preview and pitch links

**Status:** built on `feat/p2-s6-preview`, approved by the Owner 2026-11-05. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 6 · **Module:** `docs/modules/04-template-engine-renderer.md` · **Depends on:** S1-S5b (PRs #43-#50; the catalogue is live since S5b).

S6 is split: **S6a (this report)** is the link itself: the signed token, the preview route in the sites app, everything the renderer needs to browse a template inside a link, and an operator command to mint links. **S6b** is the dashboard page where a freelancer picks a template, types the prospect's business name and copies the link (a capability, audit event, server action and page); it is a separate slice because it touches RBAC, the service layer and the isolation harness.

## 1. Requirements

| Requirement                                                                                                                                                         | State after S6a                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-09: public, login-free, shareable preview of a template with demo data, optionally personalised with the prospect's business name, `noindex`, expiring links | Implemented and **verified in a real browser against a real server and the real catalogue**. Creating a link works today through `pnpm --filter @platform/db db:preview-link`; the dashboard page is S6b. **Off in every deployment until the Owner sets two environment values (DG-26)** |
| ADR-004 / module 04: "preview links are public but expiring and `noindex`; no tenant secret is embedded"                                                            | Met: the content is platform demo data from the read-only catalogue; the link carries only a template id, optional name and times                                                                                                                                                         |
| SEC-03 (strict CSP, no shared cookies)                                                                                                                              | The preview is a cookieless, script-free page with the hash-based CSP of S4; it runs on its own host                                                                                                                                                                                      |

Nothing is marked "verified".

## 2. How a link works

`https://<PREVIEW_HOST>/p/<token>[/<page>]`, for example `https://preview.sites.example.com/p/v1.<claims>.<signature>/rates`.

- **Token** (`packages/hosting/src/preview-token.ts`): `v1.<base64url claims>.<base64url HMAC-SHA256>`. Claims: template id, optional template version, optional prospect name (plain text, 1 to 60 characters), issued-at, expiry. Default lifetime 7 days, at most 30. Nothing is stored: the sites app verifies with the shared secret alone.
- **Verification order:** length bound, signature (constant-time, current and previous secret), closed claim set, expiry. A bad signature, a malformed token or a forged claim is a uniform `404 This preview link is not valid`; only a **validly signed** token that has run out is `410 This preview link has expired`. A refused link never touches the database.
- **Content:** the published template from `app.get_catalog_template` as `app_public` (read-only; unknown, draft, archived and private look identical), cached in-process for 60 s. It is re-validated by the renderer on every request like any stored config.
- **Personalisation:** the prospect's name replaces the demo business name in the header, footer, logo alt text and page titles. It is escaped everywhere it appears.
- **Browsing:** the renderer now supports a `basePath`, so every in-site link (brand, menu, buttons, rich text, footer, the 404 page) stays inside `/p/<token>`: the prospect can click through all pages of the template and share any page.
- **What the visitor sees:** the template at full fidelity, a thin banner above the header (`Preview of the "Taxi Quick" template: demo content, not a live website.`, English or Hindi), fake contact details, placeholder images.
- **Safety headers:** `noindex` in the page, `X-Robots-Tag` and `robots.txt` (`Disallow: /`), `no-store`, `Referrer-Policy: no-referrer` (also enforced for `/p/*` in `next.config`, because the global baseline would otherwise win), links open with `noopener noreferrer`, hash-based CSP with `form-action 'none'`.
- **Where it runs:** only on `PREVIEW_HOST`. `preview` is a reserved workspace slug and platform-subdomain label (P1), so no tenant can own that host and no tenant page path can collide with `/p/...`. If `PREVIEW_HOST` or `PREVIEW_TOKEN_SECRET` is missing or too short, previews are simply off and that host is an ordinary unknown host.
- **Revocation:** links expire; to kill every link at once, rotate the secret (`PREVIEW_TOKEN_SECRET_PREVIOUS` keeps old links alive during a rollout if wanted). Per-link revocation would need a database table and is not built; say so if the sales workflow needs it.

## 3. Findings

| ID   | Finding                                                                                                                                                                            | Consequence                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6-1 | Rendered templates use root-relative links (`/rates`); inside `/p/<token>` they would leave the link on the first click                                                            | `basePath` added to the renderer context; every internal link builder honours it; tested (links, menu "current page", 404 page, rich text) and clicked through in a real browser                         |
| S6-2 | The global `Referrer-Policy: strict-origin-when-cross-origin` in `next.config` overrode the route's `no-referrer` (seen in the real response header)                               | An extra `/p/:path*` header rule after the baseline; the header test pins it. Cross-origin Referer would only have carried the origin, but a path token should never leave                               |
| S6-3 | Looking at the page in a browser: the "Skip to main content" link peeked into view above the header once the banner existed (it was hidden by `top: -4rem` relative to the header) | Hidden with the visually-hidden technique instead (independent of what sits above the header); focus still reveals it                                                                                    |
| S6-4 | The prospect name was not reaching the tab title: templates carry their own SEO title                                                                                              | The demo business name is swapped for the prospect's name in SEO titles, descriptions and the logo alt; tested                                                                                           |
| S6-5 | `.env.example` already named `PREVIEW_TOKEN_SECRET` for "preview/staging tokens [P3]"                                                                                              | Placeholder updated. **P3's staging and draft-preview tokens (Q10) must use their own secret or a purpose-bound derived key**, so a preview link can never be accepted as a staging token or the reverse |
| S6-6 | **Open for the Owner:** previews are off until two values are set in the sites Vercel project                                                                                      | See DG-26 and section 8                                                                                                                                                                                  |

## 4. Security, privacy and failure paths

- **Forgery and tampering:** constant-time HMAC over the exact bytes served; any edit to the payload or signature is refused before parsing; claim set is closed (unknown key refuses the token); `exp - iat` over 30 days, `exp` before `iat` and an `iat` more than 5 minutes ahead are refused; secrets under 32 characters are refused at both ends; the token is length-bounded before any work. Tests: 27 for the token alone.
- **Enumeration and abuse:** refused tokens cost no database access (tested: the catalogue is not called); valid ones cost one cached read per template per minute; a catalogue failure is a 503 that is **not** cached as "template missing".
- **Content injection:** the prospect name is validated at minting and again at verification (no markup, no control or bidi characters), then escaped by the renderer; the rest is the S4 pipeline.
- **Privacy:** the page and the token contain no personal data of the freelancer or a tenant; the prospect's business name is typed by the freelancer and appears in the URL token (base64, not encrypted: do not put anything private in it).
- **Isolation:** no tenant table is read; the route uses only the S5b catalogue functions as `app_public`.

## 5. Tests and evidence

`@platform/hosting`: 27 unit tests (token). `@platform/blocks`: 74 (base path, banner, 404 inside a base path, malformed base paths refused, skip-link CSS). `@platform/sites`: 49 (preview: 17 tests incl. forged and expired links, previous-secret rollout, unknown template, personalisation, HEAD, version pinning and cache, host scoping, feature off, catalogue failure; header rules). `@platform/db` integration: 7 in the seed file (adds `getCatalogTemplate` through `app_public` against the seeded catalogue). Lint and typecheck clean for every touched package.

**Real browser, real server:** `next dev` with the local Docker database, a freshly generated in-memory secret, a link made by `db:preview-link`, Chromium: HTTP 200, `noindex, nofollow`, `Referrer-Policy: no-referrer`, tab title and header show the prospect name ("Sharma Taxi"), banner present, real fonts loaded, **0 CSP violations, 0 console errors**, clicking the menu link "Rates" lands on `/p/<token>/rates` showing "Our rates", a one-character-edited link is a 404.

## 6. CI-equivalent run

Clean worktree at `76e79b2`, `pnpm install --frozen-lockfile`, steps in the order of `.github/workflows/ci.yml` for the `verify`, `audit` and `db-integration` jobs, against a freshly built local Docker stack. Every step passed on the first run.

| Step                                                                                                | Result                                                                              |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| format:check, sync-plan:check, lint, typecheck, traceability diff, build (3/3), `pnpm audit --high` | pass                                                                                |
| `pnpm test`                                                                                         | pass, 15/15 tasks (hosting 27, blocks 74, sites 49, templates 28, schema 44, ui 22) |
| bootstrap (twice), migrate, configure, drift, `db:verify`                                           | pass; drift: no difference; verify 31 of 31                                         |
| `@platform/db` integration with coverage gate, then again                                           | pass, 123 tests each; statements 94.13 %, lines 97.03 %                             |
| Isolation suite / mutation check                                                                    | 216 tests / 13 of 13 mutations killed                                               |
| Product auth / workspaces / jobs / hosting integration                                              | pass: 191 / 126 / 8 / 33 tests                                                      |
| `db:seed-templates` (dry run and local)                                                             | pass                                                                                |

**Not run:** the `secrets` job (gitleaks, Docker image), the Playwright `e2e` and `perf` jobs (S6a changes no dashboard code; CI runs them on the PR), the live Supabase suite (no live change in S6).

## 7. Compatibility, migration, rollback

New code, one new optional input to the renderer (`basePath`, `banner`; unchanged output without them), one new method on the public DB client, new environment variables (all optional, off by default). **No database change, no migration, no live action, no new dependency.** Production behaviour is unchanged until the Owner sets `PREVIEW_HOST` and `PREVIEW_TOKEN_SECRET`. Rollback is a revert.

## 8. Owner decisions (2026-11-05)

1. **S6a approved.**
2. **DG-26 (turning previews on in a deployment) is still open:** it needs `PREVIEW_HOST` and a strong `PREVIEW_TOKEN_SECRET` in the sites Vercel project. I will ask for the Owner's approval of that Vercel step separately; the secret is generated locally and piped, never printed.
3. Per-link revocation is not built; open question for the sales workflow.
4. Next: S6b (dashboard "share a preview" page), then S7 (phase exit).
