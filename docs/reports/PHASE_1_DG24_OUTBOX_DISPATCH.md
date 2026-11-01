# Phase 1 · DG-24: dispatch of very large suspensions

**Status:** Implemented and covered by automated tests; clean-worktree CI-equivalent run in section 5. Awaiting Owner approval of this report (decisions D1-D3), then PR.
**Date:** 2026-11-01 · **Branch:** `fix/dg24-bounded-outbox-dispatch` · **Origin:** finding S9-9 in `PHASE_1_REPORT.md`, gap register DG-24.

## 1. Requirements

| Addressed                   | How                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-WS-04, FR-ADM-02 (S8)    | A suspension must reach the sites cache for every project of the workspace, however many there are                                                                            |
| Cross-module contracts      | "persist state and an outbox/event record atomically where a job must follow": the outbox rows were already atomic; their after-commit dispatch is what is made safe at scale |
| ADR-007 rule 2 (idempotent) | Unchanged: the outbox row id is the event id (`outbox:<id>`), so a row emitted twice is de-duplicated                                                                         |
| **Not in this slice**       | Changing the event contract or the `app.admin_set_workspace_status` function (see D2); a Production Inngest sweep (DG-10)                                                     |

## 2. The problem (S9-9)

Suspending the 1,200-project perf workspace through the admin console committed the suspension and wrote 1,200 `sites.hosts.changed.v1` outbox rows, but all 1,200 stayed undispatched: about 700 `DbBusyError`s in the after-response task, some inline jobs dead-lettered. Two causes, one per transport:

- **Inngest (the deployed transport):** `dispatchBatch` sent the events one request at a time. 1,200 sequential HTTP requests do not fit in an after-response function's lifetime, and nothing was marked dispatched until the end.
- **Inline (local and tests):** every event queued its own deferred task, so 1,200 handlers ran concurrently against a tenant client with a bounded queue.

## 3. What was built

- `JobEmitter.siteHostsChangedMany(items)`: Inngest sends one batched request (parsed first, so one malformed payload fails the call before anything is sent); inline queues **one** task that runs the events one after another and dead-letters a failing event without stopping the rest.
- `outbox.dispatchBatch`: host-change rows go out in chunks of `DISPATCH_CHUNK` (100); each chunk is marked dispatched as soon as it is sent. A failing chunk counts an attempt and the error on its rows and the other chunks still go; the sweep retries it (least-tried first since S8-6). Other event types are unchanged (one by one). Rows are read in creation order.
- `settle` extracted from `dispatchBatch` (mark done / count failures), unchanged in behaviour.
- No schema, migration, event-name or payload change; the job function and its idempotency are untouched.

### 3.1 Decisions for review

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Chunk size 100 per request and per mark step: well inside Inngest's request limits, about 12 requests for 1,200 projects, and a request that ends early leaves at most one chunk undispatched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D2  | **Not done:** one event per workspace expanded by the job (the other idea in DG-24). It would change the S8 function, the event contract and need a live migration, for a gain batching already gives (12 requests instead of 1,200). Revisit if a single workspace ever reaches tens of thousands of projects                                                                                                                                                                                                                                                                                                                                                                                           |
| D3  | **Live proof, done 2026-11-01 (Owner delegated the decision).** The 1,200 pending rows of the suspended perf workspace were dispatched through the production path (`outbox.dispatch` with all 1,200 ids) against the live database with this code, from a temporary test (deleted afterwards, not committed). Result: chunks of at most 100, nothing pending afterwards (read back as `svc_definer`: 3,000 outbox rows for that workspace, 0 undispatched, max attempts 1). The cache and jobs were the local emulator and inline transport, so no live Upstash key or Inngest event was touched; the live writes were only the `dispatched_at`/`attempts` marks on that synthetic workspace's own rows |

## 4. Security and failure-path review

- No change to authorization, RLS or the tenant scope: dispatch still runs in `withJobTenant(workspaceId)` and only reads and marks rows of that workspace.
- Failure paths: a thrown send marks `attempts + 1` and a redacted, 500-character `last_error` on the chunk's rows (never the payload); a mark failure is logged and the rows stay for the sweep; a malformed payload fails only its row.
- Events carry ids only, as before (ADR-007).

## 5. Tests

- `packages/jobs/src/index.test.ts`: inline `siteHostsChangedMany` runs one task, one event at a time (peak concurrency 1), dead-letters a failing event and still runs the rest, empty input is a no-op, a malformed payload fails the call before queueing.
- `packages/jobs/test/inngest.test.ts` (signed executor): a batch of 20 events in one call, sent twice, is delivered exactly once each.
- `packages/workspaces/test/integration/outbox-dispatch.test.ts`: 1,500 outbox rows dispatch in 15 chunks of at most 100, every row is marked dispatched; a failing second chunk leaves exactly its 100 rows undispatched with `attempts = 1` and the error, and the other chunks went out.

**CI-equivalent run (2026-11-01, clean worktree `../dg24-wt` at `2a80e62`):** format, sync-plan, lint, typecheck, unit tests, traceability diff, build, `pnpm audit --high`, bootstrap (twice), migrate, configure, drift, `db:verify`: pass. `@platform/db` integration with coverage 101 (twice), isolation 189, mutation check, auth suite 191 x3, workspaces 126 (was 124), jobs 8 (was 7), hosting 21, E2E 6/6: pass. `test:perf` fails on this laptop as before (CPU-bound single Node process; the hosted-runner `perf` job in CI passes, see `PHASE_1_REPORT.md` 6.2); this slice does not touch the measured operations.

Live: the 1,200-row dispatch of D3. Not run: a fresh live suspension of a large workspace; the Production Inngest transport (DG-10).

## 6. Compatibility, migration and rollback

No migration, no schema or contract change; `JobEmitter` gained one method (all implementors in the repository updated). Rollback is a revert; rows are never lost either way because the sweep covers anything not dispatched.

## 7. Open items and decisions for the Owner

| Item                                                         | State                                 |
| ------------------------------------------------------------ | ------------------------------------- |
| Approve DG-24 (report)                                       | Owner (D1-D3)                         |
| Clear the 1,200 pending rows of the suspended perf workspace | **Done 2026-11-01** (D3)              |
| Gap register                                                 | DG-24 closes with the merge of the PR |
