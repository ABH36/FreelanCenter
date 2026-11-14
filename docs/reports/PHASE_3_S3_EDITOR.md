# Phase 3, slice S3: the site editor

**Status:** built on `feat/p3-s3-editor`; **approved by the Owner 2026-11-15.** **Date:** 2026-11-15 · **Requirements:** FR-PRJ-01 (start from a template), FR-BLD-01 (schema-generated forms, inline validation), FR-BLD-02 (live preview with device widths), FR-BLD-06 (autosave, conflicts, undo/redo), FR-BLD-07 (single-editor lock), part of FR-BLD-08 (keyboard) · **Module:** 05 · **Design approved by the Owner 2026-11-15, preview option B.** No migration in this slice.

## 1. Why

S1 and S2 made the draft model and service. S3 is the first part a freelancer sees: open a project, pick a template, change the site, and watch the change in a live preview.

## 2. What was built

**Editor page** `apps/dashboard/app/(app)/w/[slug]/projects/[projectId]/editor` ("Edit site" on the project page):

- **Without a draft:** the template catalogue, with one "Start with ..." button per template (FR-PRJ-01, through `startDraftAction`).
- **With a draft:** the editor.
  - **Site parts:** the business details and every section of every page.
  - **Form:** generated from the block's JSON Schema. `editorFormSchemas()` in `@platform/schema` makes it from the same Zod schemas that validate every save, so the form and the validation cannot drift apart.
    - It covers text, choice lists, switches, numbers, nested groups and lists (add, remove, move up/down), plus plain rich text.
    - Rich text with bold, italic or links is shown read-only, with a "Replace with plain text" option.
    - Server field errors appear next to their field.
  - **Autosave:** one second after the last edit, on the revision the editor holds. A browser-made change id makes a retry safe. On a conflict the draft reloads and the person is told.
  - **Undo and redo:** buttons, plus Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) outside text fields, where the browser's own text undo applies.
  - **Lock:** taken when the editor opens and renewed every 30 s. While someone else holds it, a banner names them, everything is read-only, and owners and admins see "Take over editing" (audited by the service). The lock is given back when the editor closes; it also expires on its own.
  - **Preview widths:** phone, tablet and desktop.

**Live preview (Owner decision 2026-11-15, option B; Implementation Plan Q10 updated).**

- The dashboard renders the draft itself on `/editor-preview/<slug>/<projectId>`, using `@platform/blocks` in mode `draft`, the same renderer as the sites app.
- The draft is read through the member's session, the membership check and RLS. No visitor role gains access to drafts.
- The response policy:
  - `default-src 'none'`
  - hashed styles
  - `font-src 'self'`
  - `form-action 'none'`
  - `frame-ancestors 'self'`
  - no script source; the renderer emits no script at all
- It also sends `X-Frame-Options: SAMEORIGIN` and `noindex`.
- `next.config.ts` excludes only this path from the global `frame-ancestors 'none'` / `DENY`.
- The iframe is `sandbox="allow-same-origin"` only: no scripts, forms or popups. Same-origin is needed so that navigating between pages inside the preview keeps the session.
- Fonts are copied to `public/preview-fonts` by `scripts/copy-preview-fonts.mjs`, which uses the sites app's allow-list.

**Server actions** `apps/dashboard/app/actions/builder.ts` are thin wrappers over the S2 service. Each takes the user id from the session and treats every id as a selector:

- `startDraftAction`
- `reloadDraftAction`
- `saveDraftChangeAction`
- `undoDraftAction` and `redoDraftAction`
- `editLockAction`
- `takeOverEditLockAction`
- `releaseEditLockAction`

## 3. Findings

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                               | Consequence                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3-1 | The renderer accepts at most three base-path segments (built for `/p/<token>`). The first preview path, `/w/<slug>/projects/<id>/preview`, has five, so the e2e test showed "This draft cannot be shown"                                                                                                                                                              | The preview moved to `/editor-preview/<slug>/<projectId>`. The renderer is unchanged                                                                                                                                                   |
| S3-2 | **A latent bug since P1.** Route handlers checked `error instanceof WorkspaceError`. Next.js can bundle `@platform/workspaces` twice (once for a route handler, once for the shared runtime), and then `instanceof` fails: a NOT_FOUND became a **500** instead of a 404. The audit export and template demo routes had the same check, but no test reached that path | New `isWorkspaceError()` in `@platform/workspaces` matches the class, or the same name with a known code, and has a unit test. It is used in all three route handlers, `runAction` and the editor actions                              |
| S3-3 | The dev server warned "Only plain objects can be passed to Client Components" 26 times on the first run. The schemas and the parsed config were checked and are plain                                                                                                                                                                                                 | Props now cross the server/client boundary as plain JSON. The editor needs only the lock's holder and whether it is the caller. The next runs had 0 warnings                                                                           |
| S3-4 | The dashboard axe test timed out after the editor page was added: axe opens a new page for every iframe, which is slow on a development server                                                                                                                                                                                                                        | The test timeout went up and the preview iframe is excluded from axe on the editor page. Its content is template content, which `tests/quality` checks for every template and block. The editor's own UI passes axe with no violations |

## 4. Security review

- **Tenant isolation:** the editor page, the preview route and all 8 actions are registered with the IDOR harness. When A's owner probes with B's ids, the result is NOT_FOUND, and B's draft and lock are unchanged (75/75).
  - In the e2e test, B gets **404** for A's editor, for A's preview, and for A's project id through B's own slug.
- **Clickjacking:** only the preview path may be framed, and only by the dashboard (tested on both headers). The editor page itself keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Script surface:**
  - The preview has no script source, and the HTML contains no `<script>` (tested).
  - The iframe sandbox allows no scripts, forms or top navigation.
  - The policy fetches nothing from outside the dashboard: fonts and images are `'self'` or `data:`.
- **Untrusted input:**
  - Forms only shape the input.
  - Every save is a `PatchOperation[]` validated by `applyPatch` against the whole SiteConfig on the server.
  - The lock and the revision are checked in the same transaction.
- **Residual risk:**
  - `allow-same-origin` means the preview document runs with the dashboard's origin. This is acceptable because the document has no script, the policy allows none, and its content is rendered with escaping by the shared renderer.
  - If scripts are ever allowed in templates (they are excluded by AGENTS.md), this must be revisited.

## 5. Tests and evidence

| Check                            | Result                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e2e (Playwright, local stack)    | **14/14**. A starts the site from "Gym Bold", edits the business name, sees "All changes saved" and the new name in the preview, then Undo restores it. Header checks on the editor and the preview. B gets 404. The editor page is in the axe list with no violations. 0 "plain objects" warnings |
| IDOR harness (`actions.test.ts`) | 75/75, including the 8 editor actions, the editor page and the preview route                                                                                                                                                                                                                       |
| `@platform/schema`               | `editorFormSchemas` has an object schema for the business and every block type                                                                                                                                                                                                                     |
| `@platform/workspaces` unit      | `isWorkspaceError`: class, copied class, unknown code, plain error, plain object                                                                                                                                                                                                                   |
| Full CI-equivalent               | section 7                                                                                                                                                                                                                                                                                          |

## 6. Contracts and docs

- No migration. No contract changes.
- Implementation Plan Q10 records the Owner's decision.
- Module 05 describes the editor and the preview.

## 7. CI-equivalent

Full run on the branch rebased onto `main` (`0100811`), in a clean worktree: **36 steps passed**. This includes install, format, lint, typecheck, unit tests, build, audit, the database suites, isolation and the mutation suite, auth, workspaces, jobs, hosting, e2e, a11y and Lighthouse.

Three steps failed, all local only:

- **Visual and browsers:** Windows only, as on every run.
- **`perf`:** a different operation goes over budget on each run (`getProject` this time). This machine was running seven unrelated containers, and the same test also fails on `main` here, as recorded in the P3 auth hardening report. GitHub CI is the reference.

gitleaks found no leaks in the S3 commits.
