# Phase 3, slice S2: draft service

**Status:** **approved by the Owner 2026-11-15**; merged (PR #79, fbc454d); live migration applied 2026-11-15 with the Owner's approval (section 8). **Date:** 2026-11-15 · **Requirements:** FR-PRJ-01 (project from a template), FR-BLD-06 (autosave with revision, optimistic concurrency, undo/redo), FR-BLD-07 (single-editor lock) · **Module:** 05 · **Design and decisions approved by the Owner 2026-11-14.**

## 1. Why

S1 made the builder tables and their database rules. S2 is the service the editor (S3), the section/page tools (S4), AI (P4) and onboarding (P5) call. It decides what a valid change is, how undo works and who may save.

## 2. What was built

**Migration `20261115090000_p3_s2_catalog_template_for_draft`: one function.** `app.catalog_template_for_draft(template_id)` is a SECURITY DEFINER function owned by `svc_definer` that only `app_user` may execute.

- It returns the latest published version of a catalogue template with its **version id**, schema version and config.
- Platform template versions have no workspace, so a tenant cannot read their ids through RLS. The visitor function `get_catalog_template` gives the version number only and is unchanged.

**Service `packages/workspaces/src/builder.ts`, wired into the dashboard runtime as `builderService` for S3.**

| Function                                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDraftFromTemplate`                             | Revision 1 from the template's latest published version. Records `template_id` and `template_version_id` on the project. Repeating it with the same template is idempotent. Another template while a draft exists is `DRAFT_EXISTS` (see section 5)                                                                                                                                          |
| `getDraft`                                            | Any member. Returns the config (migrated on read), revision, template, who holds the lock, `canUndo` and `canRedo`                                                                                                                                                                                                                                                                           |
| `applyChange`                                         | Validates a `PatchOperation[]` with `applyPatch`, so the whole SiteConfig must stay valid; field errors are returned otherwise. Needs the caller to hold the lock (`LOCK_REQUIRED`) and the expected revision (`DRAFT_CONFLICT`). A browser-made `changeId` makes a retry return the same result, and the same id with other content is `IDEMPOTENCY_MISMATCH`. Stores a server-made inverse |
| `undo` / `redo`                                       | One stack per project, at most 50 changes deep (`UNDO_LIMIT`). Undo walks back, redo walks forward, and a new change clears redo. Each one is a new change set naming the one it reverses; the reversed one becomes `undone`                                                                                                                                                                 |
| `proposeChange` / `acceptProposal` / `rejectProposal` | Source `ai` or `client`. The draft is untouched until a member holding the lock accepts. Acceptance works only at the proposal's base revision (`PROPOSAL_STALE`)                                                                                                                                                                                                                            |
| `acquireLock` / `takeOverLock` / `releaseLock`        | Take a free or expired lock, or renew your own (the 30 s heartbeat). Someone else's live lock is reported, not taken. Owners and admins may take a lock over, and that is audited with the previous holder. Releasing affects only your own lock                                                                                                                                             |

**The inverse.** Before a change, the service snapshots the parts the change touches: business, theme, a page's title/SEO, or a page's sections. Applying the snapshot restores exactly those parts, and the result is validated like any other change. Clients never send inverse operations.

**Errors.** New codes with safe messages: `DRAFT_CONFLICT`, `DRAFT_EXISTS`, `NO_DRAFT`, `LOCK_REQUIRED`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO`, `UNDO_LIMIT`, `PROPOSAL_STALE` and `CHANGE_TOO_LARGE`. The S1 database codes P5101–P5103 are mapped to them.

**Audit.** `draft.created`, `draft.changed`, `draft.undone`, `draft.redone`, `draft.change.proposed`, `draft.change.accepted`, `draft.change.rejected` and `draft.lock.taken_over`. They hold ids and counts only, never content. Lock acquire, renew and release are not audited, because the heartbeat would flood the log.

## 3. Findings

| ID   | Finding                                                                                                                                                       | Consequence                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-1 | The visitor function gives no template version id, and RLS hides platform version rows from tenants                                                           | A narrow app_user-only definer function (section 2), registered in the catalog test and `db:verify`                                         |
| S2-2 | Accepting a proposal at a later revision would need the database's `result_revision = base_revision + 1` rule to bend, or the proposal to be rebased silently | Proposals are accepted only at their base revision. P5 can add an explicit "re-propose on the current draft" if client edits often go stale |

## 4. Security review

- **Authorization:** every command checks the capability (`draft.edit`; reads `projects.view`) before any lookup, and every mutation runs in the tenant RLS transaction. Another workspace's project, an unknown template or someone else's proposal gives `NOT_FOUND`, as tested.
- **Untrusted input (AGENTS.md):**
  - Patches are parsed against the closed `PatchOperation` union (at most 50 operations), applied to a copy, and the whole config is re-validated.
  - The inverse is made by the server.
  - Proposals are applied only after a member accepts them.
- **Integrity:**
  - The lock and the revision are checked in the same transaction as the write.
  - The S1 triggers enforce revision +1 and forward-only change sets even if this service had a bug.
  - Idempotency comes from the change id.
- **Least privilege:** the new function is executable by `app_user` only and returns only published catalogue content.
- **Residual:** an inverse over 256 KB is refused with `CHANGE_TOO_LARGE`; this is only reachable with very large pages. Switching templates is deferred.

## 5. Decisions and deferrals

- Approved 2026-11-14 and implemented:
  - Saving needs the lock.
  - There is one undo stack per project.
  - Undo uses server-made snapshots.
  - Undo reaches 50 changes.
- **Deferred:** switching the template of a project that already has a draft. That is a whole-config change that must be undoable and that the 256 KB inverse limit does not fit. Until then it is refused with `DRAFT_EXISTS`.

## 6. Tests and evidence

| Check                                    | Result                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/integration/builder.test.ts` (new) | 11/11. Covers draft creation and idempotency, viewer and foreign-project refusals, lock reporting, takeover (audited) and release, conflict, retry idempotency, invalid patches, archived project, the full undo/redo cycle, the 50-change limit, and proposals including stale ones |
| `src/builder.unit.test.ts` (new)         | 11/11. For every operation type, the inverse restores the config exactly after a JSON round trip; the inverse of the inverse is the redo; only touched parts are captured                                                                                                            |
| Full CI-equivalent (`8b30a29`)           | 37 steps passed, including db, isolation, auth, workspaces, e2e, a11y, Lighthouse and perf. Only visual and browsers failed (Windows only, as before)                                                                                                                                |
| gitleaks (S2 commit)                     | no leaks                                                                                                                                                                                                                                                                             |

## 7. Migrations and contracts

- **Migration:** one forward-only function. Rollback is a new migration that drops it.
- **Live database:** this is a separate Owner-approved step after merge, following the S1 procedure (pre-check, deploy, status/drift, `db:verify --target env`).
- **Contracts:** unchanged. `CROSS_MODULE_CONTRACTS.md` already says that every edit uses optimistic concurrency and a ChangeSet, and S2 implements that.
- **Docs:** module 05 (draft service).

## 8. Live application (2026-11-15, Owner-approved)

Run from the developer machine against the Supabase `ap-south-1` project as `migrator` (not a superuser, no BYPASSRLS), after PR #79 was merged. No secret was printed or stored.

| Step                                                     | Result                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only pre-check (read-only transaction, rolled back) | remote host; 11 migrations, all finished, none rolled back, latest S1 (live matched `main`); the S2 migration was not recorded; `catalog_template_for_draft` did not exist; `app.templates`, `app.template_versions` and `svc_definer` existed                                                        |
| `prisma migrate deploy` (`DB_TARGET=env`)                | applied `20261115090000_p3_s2_catalog_template_for_draft`                                                                                                                                                                                                                                             |
| `prisma migrate status`                                  | database schema is up to date (12 migrations)                                                                                                                                                                                                                                                         |
| Live database vs `schema.prisma`                         | no difference detected                                                                                                                                                                                                                                                                                |
| `db:verify --target env`                                 | **38 passed, 0 failed**; SECURITY DEFINER functions are exactly the 30 expected, owned by `svc_definer` with a pinned search path                                                                                                                                                                     |
| `test:live`                                              | first run, right after the migration: 1 failed, 5 passed, 1 skipped. The failure output was not captured. The next two runs: 6 passed, 1 skipped (unchanged from before). Most likely cause, not proven: pooled connections whose cached statements were invalidated by the DDL. Recorded as observed |

Nothing else on the live database changed. The production code does not call the new function yet; S3 is the first slice that does.
