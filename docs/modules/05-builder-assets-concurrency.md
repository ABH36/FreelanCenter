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

## Assets

Uploads are authenticated and scoped to project. Sniff MIME, cap size, strip EXIF, scan where feasible, re-encode fixed AVIF/WebP variants, store alt text/provenance and serve through asset domain. Do not use the Next/Vercel image optimizer. Deleting/replacing assets cannot break immutable published versions; lifecycle/refcount design is required.

## Evidence / handoff

Test revision conflicts, undo boundaries, authorization, reorder validation, malicious file uploads, accessibility and iframe origin/CSP. Upstream: Modules 02/04. Downstream: publishing, AI and onboarding. Read ADR-009 and SRS §6.5.
