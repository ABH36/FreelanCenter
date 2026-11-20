# 05 — Builder, Assets and Editing Concurrency

**Status:** Planned (P3). **SRS:** FR-BLD-01..09; FR-TPL-02/04/06.

## Outcome

Let authorized agency users safely edit a SiteDraft through schema-generated forms and a sandboxed preview. The builder changes structured data, never arbitrary executable code.

## Flow

```text
Acquire project edit lock → load draft + revision → schema-generated edit
→ validate patch → optimistic save(revision) → preview iframe reload
→ audit ChangeSet; release/renew lock
```

Supports pages/sections add-remove-duplicate-hide-reorder, allowed variants, themes, undo/redo and responsive preview. Conflicting saves return a resolvable conflict, not last-write-wins. One-editor lock warns rather than silently corrupts; real-time co-editing is out of v1.

**Data model (P3 S1, migration `20261114180000_p3_s1_builder_data_model`).** These rules are enforced by the database itself:

- `site_drafts`: one draft per project. The `revision` moves by exactly one on every write, so the service saves with `WHERE revision = <expected>` and a stale save changes nothing.
- `change_sets`: source `manual`, `ai` or `client`. Status moves only forward: proposed → applied | rejected, applied → undone. An applied change keeps its inverse, and undo is a new change set. Change sets are never deleted.
- `project_edit_locks`: a 2-minute lock renewed by a heartbeat. The database sets the holder and the times. The holder renews it, any editor may take it after it expires, and an owner or admin may take it over at any time.

Owners, admins and editors write; viewers read. Writes need a writable workspace and an editable project (not archived, not deleted). Decisions approved 2026-11-14: undo depth 50, enforced by the service in S2; a draft is created when a template is chosen.

**Draft service (P3 S2, `packages/workspaces/src/builder.ts`; design approved 2026-11-14).**

- `createDraftFromTemplate` (FR-PRJ-01) starts revision 1 from the latest published catalogue version, read through `app.catalog_template_for_draft` (app_user only), and records it on the project. Repeating it with the same template is idempotent. Choosing another template while a draft exists is `DRAFT_EXISTS`: switching templates is a later slice.
- `applyChange` validates a `PatchOperation[]` with `applyPatch`, so the whole `SiteConfig` must stay valid. It requires the edit lock and the expected revision (`DRAFT_CONFLICT` otherwise). A browser-made `changeId` makes a retry idempotent.
- The change set stores a server-made inverse: a snapshot of the touched parts (business, theme, page title/SEO, page sections).
- Undo and redo work on one stack per project, at most 50 changes deep. Undo walks back through changes, redo walks forward, and a new change clears redo.
- Proposals (source `ai` or `client`) do not touch the draft until a member holding the lock accepts them, and only at their base revision (`PROPOSAL_STALE` otherwise).
- The lock is taken and renewed by `acquireLock`, called on every 30 s heartbeat. Owners and admins may use `takeOverLock`, which is audited with the previous holder. `releaseLock` releases it.
- Audit rows: `draft.created`, `draft.changed`, `draft.undone`, `draft.redone`, `draft.change.proposed`, `draft.change.accepted`, `draft.change.rejected` and `draft.lock.taken_over`. They hold ids and counts only.

**Editor UI (P3 S3, `apps/dashboard/app/(app)/w/[slug]/projects/[projectId]/editor`).**

- When the project has no draft yet, the page shows the template catalogue ("Start with ...").
- Otherwise it shows the editor:
  - **Site parts:** business details and every section of every page.
  - **Form:** generated from the block's JSON Schema, made by `editorFormSchemas()` from the same Zod schemas that validate saves. Server field errors appear next to the field.
  - **Autosave:** one second after the last edit, on the held revision. A conflict reloads the draft.
  - **Undo/redo:** buttons, and Ctrl+Z / Ctrl+Y outside text fields.
  - **Lock:** taken on open and renewed every 30 s. A banner names the holder; owners and admins see "Take over editing".
  - **Preview:** at phone, tablet or desktop width.
- **The preview** (Owner decision 2026-11-15, replacing Q10 for the editor) is rendered by the dashboard on `/editor-preview/<slug>/<projectId>`:
  - It uses the same renderer as the sites app, in mode `draft`.
  - It runs no script: the policy has no script source, styles are hashed, and `frame-ancestors 'self'`.
  - It is shown in an iframe with `sandbox="allow-same-origin"` only.
  - Every other dashboard path keeps `frame-ancestors 'none'`.
  - Fonts are served from `public/preview-fonts`, using the sites app's allow-list.
- **Rich text:** plain text is edited directly. Text with formatting is shown read-only, with a "Replace with plain text" option.

**Sections and pages (P3 S4, FR-BLD-03).**

- **Patch operations:** `addPage` adds a navigation link unless `addToNavigation: false`. `removePage` also removes the navigation links to the page and refuses the home page. `movePage` reorders the pages.
- **Undo:** restores the page list and the navigation together.
- **New sections:** start with the placeholder content from `sampleSection`. S7 preflight warns about `SAMPLE_TEXTS` left on a page.
- **Editor:**
  - The section toolbar can move, hide or show, duplicate, delete (with an in-page confirmation) and change the layout.
  - Each page has an "Add section" button.
  - The page settings can rename, move and delete a page.
  - P3 S9d (DG-40): the page settings also hold the page's search title (70) and description (200), shown in the browser tab and in search results; left empty, the site uses the business name (home) or "page | business". When any page still names the template's sample business, a button replaces it with the business name on every page in one undoable change (`replaceDemoSeo`, `@platform/schema/seo-demo`). `getDraft` returns `demoBusinessName` (the catalogue template's business name).
  - "Add page" adds a page whose address is made from its name and kept unique.
  - These controls are buttons, not drag and drop, so they work from the keyboard.
  - Changing a section's block type is not offered; you add a new section instead.
- **After a deployment (P3 S9a, DG-39 (b)):** a page loaded before a deployment can call server actions the new build no longer has (`UnrecognizedActionError`). A save, undo, structure change or lock renewal that fails this way, or for any other network reason, never leaves "Saving…" behind: the status reads "Not saved" and the change stays waiting. For a changed build, editing stops and the dashboard-wide reload notice covers the page (`components/stale-build-guard.tsx`, root layout; also from unhandled rejections and the root error boundary `app/error.tsx`). On Vercel the build sets `deploymentId` from `VERCEL_DEPLOYMENT_ID`, so a stale tab reloads on its next navigation. Vercel Skew Protection (paid) is not used (Owner, 2026-11-18).
- **Before hydration (P3 S9b, DG-39 (d)):** the editor menu and fields are disabled until React has hydrated the page, because a click on the server-rendered HTML before that is lost.

**Theme editor (P3 S5, FR-BLD-04).** The editor has a "Theme" part with these controls:

- **Colours:** a picker and a hex field for each colour, plus palette buttons (`THEME_PALETTES`, every palette passes AA).
- **Fonts:** heading and body fonts from the allow-list. On a Hindi site, fonts without Hindi letters are marked.
- **Text size, spacing and radius.**
- **Buttons:** style, shape and hover.
- **Motion preset:** reduced motion is always honoured.

The browser shows contrast warnings from `contrastChecks` (`@platform/ui/color`) but does not block saving; S7 preflight runs the same checks through `contrastIssues`. Changes go through `updateTheme`, autosave and can be undone. No new theme tokens until a template needs one.

## Assets

Uploads are authenticated and scoped to project. Sniff MIME, cap size, strip EXIF, scan where feasible, re-encode fixed AVIF/WebP variants, store alt text/provenance and serve through asset domain. Do not use the Next/Vercel image optimizer. Deleting/replacing assets cannot break immutable published versions; lifecycle/refcount design is required.

**Built in P3 S6** (design approved 2026-11-15; report `docs/reports/PHASE_3_S6_ASSET_LIBRARY.md`):

- **Table `app.assets`** (migration `20261115180000_p3_s6_assets`): one row per uploaded image, `pending → ready | rejected` once. The trigger owns actors and times, keeps what was uploaded (name, type, size, storage token) unchanged, makes hiding one-way and enforces **200 images per project** under a per-project advisory lock (`P5104`). RLS like drafts: members read; owners, admins and editors write in a writable workspace on an editable project. No DELETE grant.
- **Upload flow** (`packages/workspaces/src/assets.ts`): `requestUpload` checks the declared type (JPEG, PNG, WebP; HEIC and SVG refused) and size (10 MB), records a pending row with a random 128-bit storage token and returns a 10-minute signed PUT (type and exact length signed) for the **private upload bucket**. The browser sends the file there directly. `finishUpload` reads it back with a byte cap, sniffs the magic bytes, decodes it under a 40-megapixel limit, turns it upright, re-encodes WebP q78 at the fixed widths 400/800/1200/1600 (never upscaled; the slot above the original width holds the original width), writes them to the **public bucket** with `immutable` caching, deletes the original and marks the row. Retrying returns the same outcome. Viewers cannot trigger processing.
- **Keys:** `uploads/ws/<workspace>/<asset>/<token>` (private) and `ws/<workspace>/<asset>/<token>/<width>.webp` (public). File names are display text only.
- **Storage adapter** `@platform/providers` `createS3Storage` (SigV4 via aws4fetch, path-style, R2 in production; Adobe S3Mock in `packages/db/docker` for development and CI). Env: `ASSET_S3_ENDPOINT`, `ASSET_S3_REGION` (`auto`), `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_UPLOAD_BUCKET`, `ASSET_PUBLIC_BUCKET`, `ASSET_PUBLIC_URL`. None set: uploads are off; some set: the upload fails loudly.
- **Editor:** an "Images" part (upload, default alt text, delete), and every image field in the forms (`assetRef`: logo, hero, about, gallery items, ...) shows the chosen image with its own required alt text and "Choose image". Picking an image is a normal draft change (lock, revision, undo).
- **Rendering:** the editor preview resolves the draft's asset ids to variant URLs (`renderAssets`, hidden images included) and allows the asset origin in `img-src`. Publishing (S7) must carry the same resolution into the immutable version.
- **Crop (part 2):** 1:1, 4:3 or 16:9, placed by two 0..100 offsets (the editor's preview uses CSS `object-position` with the same rule as `cropRect`). Originals are not kept, so a crop is cut from the largest variant and saved as a **new** image (audited with its source); the source and the pages that use it do not change.
- **Deleting is hiding:** variants stay, so drafts and published versions never break. Removing unused files and the upload bucket's 1-day lifecycle rule are retention work (P8 and the R2 setup).

## Evidence / handoff

Test revision conflicts, undo boundaries, authorization, reorder validation, malicious file uploads, accessibility and iframe origin/CSP. Upstream: Modules 02/04. Downstream: publishing, AI and onboarding. Read ADR-009 and SRS §6.5.
