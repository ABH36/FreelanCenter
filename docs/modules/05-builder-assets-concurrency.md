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

## Assets

Uploads are authenticated and scoped to project. Sniff MIME, cap size, strip EXIF, scan where feasible, re-encode fixed AVIF/WebP variants, store alt text/provenance and serve through asset domain. Do not use the Next/Vercel image optimizer. Deleting/replacing assets cannot break immutable published versions; lifecycle/refcount design is required.

## Evidence / handoff

Test revision conflicts, undo boundaries, authorization, reorder validation, malicious file uploads, accessibility and iframe origin/CSP. Upstream: Modules 02/04. Downstream: publishing, AI and onboarding. Read ADR-009 and SRS §6.5.
