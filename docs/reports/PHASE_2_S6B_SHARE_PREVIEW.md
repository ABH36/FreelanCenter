# Phase 2, slice 6b: share a preview from the dashboard

**Status:** built on `feat/p2-s6b-share-preview`, awaiting Owner approval. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 6 (second half) · **Modules:** 04 (templates), 01 (RBAC) · **Depends on:** S6a (PR #51), S5b (live catalogue).

S6a made the link; S6b is where a freelancer actually makes one: a **Templates** page in the dashboard that lists the catalogue and, for each template, a small form (prospect's business name, how long the link should work) that returns a copyable link.

## 1. Requirements

| Requirement                                                                                                                      | State after S6b                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-09: a freelancer can share a login-free preview with a prospect, personalised with the prospect's business name, expiring | Implemented end to end and **proven in a real browser** (section 5): dashboard form, signed link, prospect opens it in a clean browser, stays inside the link, nothing shared with the dashboard session |
| SEC-10 (server-side authorization, IDOR tests for every action and page loader)                                                  | New capability `templates.preview`; the action and the page loader are registered with the IDOR harness and probed                                                                                       |
| FR-AUD-01 (sensitive actions audited)                                                                                            | Every link made writes `template.preview_link.created` (template, days, personalised yes/no); every refusal is audited as `denied`                                                                       |
| FR-AUTH-05 (RBAC matrix)                                                                                                         | `templates.preview`: owners, admins and editors; viewers and clients may not. The role x capability matrix test has the new row (150 tests)                                                              |

Nothing is marked "verified".

## 2. What was built

- **RBAC** (`packages/auth`): capability `templates.preview` for owner, admin, editor.
- **Service** (`packages/workspaces/src/templates.ts`, `createTemplateService`): `catalog` (any member may browse the published templates, through the read-only catalogue function under RLS) and `createPreviewLink` (membership, capability, writable workspace, input validation, template must be in the catalogue, abuse limit of 100 links per person per day, signed token, audit row in the same transaction). `previewSettingsFromEnv` reads `PREVIEW_HOST` and `PREVIEW_TOKEN_SECRET`; without them the page says previews are not set up and no link can be made.
- **Dashboard**: `Templates` item in the workspace navigation; page `/w/<slug>/templates` (cards with name, category, description; the form for roles that may share; clear messages for viewers and suspended workspaces); server action `createPreviewLinkAction` returning the link, its expiry and a note ("anyone with this link can open the preview until it expires; it shows demo content only"). The link box reuses the invitation link component with its own label and note.
- **Renderer fix found by the browser test:** a root anchor inside a preview (`/#pricing`) is now written `<base>#pricing` instead of `<base>/#pricing`, which the host redirected (one wasted request per menu click).
- **CI/E2E:** the E2E servers are given a synthetic preview host and secret, the E2E job seeds the built-in templates, and two journeys were added.

## 3. Findings

| ID    | Finding                                                                                                                                                                                                                                                                   | Consequence                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6b-1 | The real-browser journey showed a menu click on `/#pricing` ended up at `<base>#pricing` after a redirect (Next removes the trailing slash)                                                                                                                               | Fixed at the source (`withBase`); unit tests and the E2E assertion updated                                                                                 |
| S6b-2 | A suspended workspace must not mint public links                                                                                                                                                                                                                          | The command requires a writable workspace; the page explains instead of showing the form; covered by the existing `NOT_WRITABLE` path of the scoped runner |
| S6b-3 | **Open (Owner action, DG-26 updated):** the **dashboard** needs the same two values as the sites app (`PREVIEW_HOST`, `PREVIEW_TOKEN_SECRET`), otherwise its Templates page shows "Preview links are not set up" and the sites app cannot verify what the dashboard signs | One secret, set in both Vercel projects, by the Owner-approved CLI step; never printed                                                                     |
| S6b-4 | The prospect's business name travels inside the link (base64 JSON, signed, not encrypted)                                                                                                                                                                                 | Said in the form's note and in the S6a report; the audit log stores only "personalised: yes/no"                                                            |

## 4. Security and failure paths

- **Authorization:** a viewer is refused and the refusal is audited; a stranger or a user of another workspace gets `NOT_FOUND` exactly like an unknown workspace (IDOR probe, both outcomes compared by the harness); a malformed, unknown, private or unpublished template id is the same `NOT_FOUND`.
- **Input:** validity is one of 1, 3, 7, 14, 30 days; the prospect name is plain text of 1 to 60 characters (no markup, control or bidirectional characters), validated again by the token minting and the verifier; errors come back as field messages.
- **Secrets and privacy:** the signing secret exists only on the server; the audit row and logs never contain the link, the token or the prospect name (tested by reading the audit log back); the link is shown only to the person who made it.
- **Abuse:** 100 links per person per day (`TEMPLATE_LIMITS`), tested at a lowered limit.
- **Failure:** not configured is a typed error with a plain message; a database error is translated like every other command.

## 5. Tests and browser evidence

| Suite                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@platform/auth`                                                                         | 150 tests (matrix row for `templates.preview`)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@platform/workspaces` integration, new file                                             | 11 tests: browsing by every role, stranger refused, link made by owner/admin/editor and verified with the sites verifier (claims and 7-day expiry), viewer refused and audited, audit holds no link or name, no name, validation messages, unknown/private templates, IDOR, daily limit, not configured, localhost form                                                                                                                                                           |
| Isolation `actions.test.ts`                                                              | 49 tests: the new action and page loader are probed for cross-workspace ids                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@platform/blocks` / `@platform/sites`                                                   | 74 / 49 tests (root-anchor form)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Playwright journey (real Chromium, real dashboard and sites servers, local database)** | 8 of 8 pass (6 existing + 2 new): owner opens Templates, enters "Sharma Fitness", creates a link; **a fresh browser context with no cookies** opens it: 200, `noindex`, banner "Preview of the "Gym Bold" template", header shows "Sharma Fitness", a menu click stays inside `/p/<token>`, 0 CSP violations, no cookies set, a one-character-edited link is 404; the owner's audit log shows `template.preview_link.created` and contains neither the prospect name nor the link |

## 6. CI-equivalent run

(filled in after the clean-worktree run)

## 7. Compatibility, migration, rollback

New capability, service, action, page and tests; one renderer output change (root anchor form inside a base path only). **No database change, no migration, no live action, no new dependency.** The page works only when `PREVIEW_HOST` and `PREVIEW_TOKEN_SECRET` are set in the dashboard environment (otherwise it explains). Rollback is a revert.

## 8. Open items

1. Approve S6b.
2. **DG-26 (Owner action):** set `PREVIEW_HOST` and `PREVIEW_TOKEN_SECRET` in **both** Vercel projects (sites and dashboard), Production and Preview. I will generate the secret locally and pipe it into the Vercel CLI; it is never shown in chat or a log. Waiting for your explicit go for that Vercel step and for the exact preview host name (`preview.<sites domain>`).
3. Next: S7 (Phase 2 exit): Lighthouse CI budgets and axe on the three templates, visual regression, the in-region NFR-PERF-04 measurement, Phase 2 report and traceability.
