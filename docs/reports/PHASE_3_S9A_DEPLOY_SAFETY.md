# Phase 3, slice S9a: deploy safety, one clock and clearer approval wording

**Status:** approved by the Owner 2026-11-18 ("S9a approve hai okay"); merged as PR #106 (`f4da26e`); **production check passed 2026-11-18** (section 9). **Date:** 2026-11-18 · **Requirements:** FR-OBS-01 (alerting on a failed release step), NFR-OPS-01 (environments reproducible and verifiable), FR-PUB-06 (approval shown in the Publish panel), FR-BLD-01/06 (editor saves; no silent loss) · **Modules:** 05, 06, 16 · **Gap:** DG-39 (a), (b), (c) · **Plan approved by the Owner 2026-11-18** ("okay plan approve hai or tumhare recommendation bhi sahi hai"): split S9a → S9b → S9c, free reload notice instead of Vercel Skew Protection, 12-hour IST clock. **Migration:** none, so no live database step.

## 1. Why

The S8c production check (report `PHASE_3_S8C_REVIEW_POLISH.md` section 9) found three deployment follow-ups, recorded as DG-39:

- (a) Vercel built nothing for the merge `23c2b0d` while CI passed, and the first production check ran against the old build.
- (b) An editor tab left open across a deployment called server actions that the new build no longer had (`UnrecognizedActionError`, 12 times). The editor awaited the call without a `try/catch`, so a failed save left "Saving…" on screen and told nobody.
- (c) Mixed clock formats ("5:25 pm" and "17:25:45"), and an approval note that stayed after a Live publish without saying what Live holds.

## 2. What was built

| #   | Change                          | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Production deploy check** (a) | `.github/workflows/production-deploy-check.yml` on every push to `main` (and by hand for any SHA) runs `scripts/ops/check-production-deploy.mjs`. It waits up to 20 minutes for Vercel's GitHub deployments "Production – dashboard" and "Production – sites" of that commit to reach `success`, then writes a table to the run summary. When one fails or never appears, the run fails (GitHub e-mails the person who merged) and says not to start a production check and to redeploy `main` at that commit with the Owner's OK. A deployment that succeeded and was later made `inactive` by the next merge still counts. |
| 2   | **Save never hangs** (b)        | The editor wraps every server action it awaits (save, structure change, undo/redo, reload, lock renewal, take-over) in `guardAction` (`apps/dashboard/lib/stale-build.ts`). A failure shows "Not saved" and keeps the change waiting, so the next edit saves it; a network failure also says so.                                                                                                                                                                                                                                                                                                                             |
| 3   | **Reload notice** (b)           | `StaleBuildGuard` in the root layout covers the page with "A new version of the dashboard is available. Reload to keep editing. Your last change may not have been saved: check it after the reload." and a Reload button. It appears when a caller announces a stale build, when such an error goes unhandled anywhere (other panels, forms), or through the new root error boundary `app/error.tsx` (which otherwise shows a plain "Something went wrong / Try again" page instead of the framework's bare page). The editor also stops editing.                                                                           |
| 4   | **Deployment id** (b)           | `next.config.ts` sets `deploymentId` from `VERCEL_DEPLOYMENT_ID` (a Vercel system variable at build and run time; unset elsewhere, so local and CI builds are unchanged). Next then reloads a stale tab on its next navigation instead of mixing builds. `apps/dashboard/turbo.json` declares the variable so Turbo's strict environment mode passes it to the build and hashes it.                                                                                                                                                                                                                                          |
| 5   | **One clock** (c)               | `@platform/ui/time`: `formatIst` ("18 Nov 2026, 5:25 pm IST"; with seconds "5:25:45 pm IST") and `formatIstDate` ("18 Nov 2026"), fixed to Asia/Kolkata. Used by the Publish and feedback panels (they used the browser's time zone), notifications, audit log and version history (seconds kept), settings, templates and the preview-link message (it used the server's UTC day), the deletion notice, invitations, the client review page (English and Hindi) and the invitation e-mail (it used GMT).                                                                                                                    |
| 6   | **Approval wording** (c)        | `publishing.status` returns `approval.liveApproved` (a client approved exactly the content on Live; same checksum rule as the gate; `null` with nothing live). The Publish panel shows "Approved by … · <time> · version N", adds "The draft has changed since, so this approval does not cover it." when it applies, and, once any approval exists, a "Live content" row: "Approved by the client (version N)" or "Version N went live without the client's approval".                                                                                                                                                      |

## 3. Decisions

From the approved plan:

1. **No paid Skew Protection.** The free path is detection plus a clear reload request. Old builds are not kept serving.
2. **The check alerts, it does not repair.** A redeploy changes production, so it stays a manual step with the Owner's OK.
3. **The check reads GitHub, not Vercel.** Vercel's GitHub integration records every deployment as a GitHub Deployment, so the workflow needs only the built-in token with `deployments: read`; no Vercel token is stored in GitHub.
4. **12-hour clock** ("5:25 pm IST"), the Owner's choice; seconds only where events can share a minute.
5. **"Went live without the client's approval" is stated only from data:** the checksum comparison, not inferred from version numbers.

## 4. Security review

- The workflow has `contents: read` and `deployments: read` only, pins `actions/checkout` and `actions/setup-node` to the same SHAs as `ci.yml` (SEC-13), takes the SHA from the event or a manual input that the script checks against `^[0-9a-f]{40}$`, and prints only public deployment URLs. It cannot deploy or change anything.
- `liveApproved` compares checksums of versions the member can already read inside the existing RLS transaction; nothing new is exposed.
- The reload notice and error page show no server details; server errors carry only Next's digest. A stale-build call reached no server code, so nothing was written.
- `deploymentId` is a public identifier (it appears in asset URLs and an `<html>` attribute); it carries no secret.
- Time formatting is presentation only.

## 5. Tests and evidence

| Suite                                                        | Result  |
| ------------------------------------------------------------ | ------- |
| `packages/ui` unit (6 new for `time.ts`)                     | 39/39   |
| `apps/dashboard` unit (4 new for `stale-build.ts`)           | 14/14   |
| `apps/sites` unit                                            | 93/93   |
| `packages/workspaces` unit                                   | 113/113 |
| `approval-gate.test.ts` (integration, 1 new S9a, 1 extended) | 18/18   |
| `scripts/ops/check-production-deploy.test.mjs` (node:test)   | 4/4     |
| Workspaces integration (full)                                | 243/243 |
| Isolation suite                                              | 402/402 |
| E2E (Playwright, 1 new: stale build in the editor)           | 23/23   |

**Deploy check against real GitHub data (2026-11-18):** `7a2cf04` → both "ok" (exit 0); `beca33b` (a PR-branch commit never deployed to Production) → both "missing", exit 1 with the next step. `23c2b0d` now reads "ok", because the manual deployments of section 9 of the S8c report also created GitHub deployments; on the day of the incident it would have read "missing".

**E2E stale-build test:** server action POSTs are answered as the new build answers an unknown action (`x-nextjs-action-not-found: 1`). After an edit, the notice appears, the status reads "Not saved" and the name field is disabled. After Reload, editing works and the draft still holds the saved name (the lost edit did not reach it).

## 6. CI-equivalent (local, 2026-11-18)

Branch `feat/p3-s9a-deploy-safety` on `7a2cf04`. `prettier --check` on every changed file, `sync-plan:check`, `lint` (18 tasks), `typecheck` (18), `test` (15) and `build` (dashboard and sites) all pass; `traceability` unchanged. The only build output besides success is the known Edge-runtime warning about `process.stdout` in `@platform/logger` (unchanged). Note: on this Windows machine, 14 older files (`README.md`, `packages/logger/tsconfig.json`, files under `spikes/`) are checked out with CRLF while the repository stores LF, so a whole-repo `format:check` warns about them locally; CI checks out LF and `main` is green. None of them is touched by this slice.

## 7. Cost

None. GitHub Actions: one short job per merge (about 3–10 minutes while Vercel builds), within the free minutes. Vercel Skew Protection (Pro plan) and a log drain were not used.

## 8. Open items

- The check runs after the merge, so it cannot block one; it can only warn before a production check. That is its purpose.
- `deploymentId` reached the production build (section 9). The reload notice in a tab left open across a deployment is covered by the E2E test; it is seen in production only at a later deployment (DG-39 (b)).
- S9b (DG-37 (h), review and preview tokens out of the URL path) and S9c (DG-37 (e), abuse baseline) follow as planned.

## 9. Production check (2026-11-18, Chrome extension, Owner-run)

**Merge and deployment.** PR #106 was merged as `f4da26e` with the Owner's OK. The new workflow's first run (`production-deploy-check`, run 44367053991) passed: its unit tests passed 4/4; sites reached `success` first and the dashboard about a minute later; "Both projects run this commit in Production." Health answered 200 on both. The dashboard HTML carries `data-dpl-id="dpl_BtHAqUP3NBfYEJNcgRt8uYzHiCCK"`, which `vercel inspect` shows is the Ready production deployment of `f4da26e`, so `deploymentId` reached the build.

**All testable steps passed.** Step 9 was not applicable. The only edit (one letter in the "S8c Check" name) was undone.

| Step | Checked                                                    | Result                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Publish panel of "S8b Check"                               | pass: "Approved by Ramesh Test · 18 Nov 2026, 5:25 pm IST · version 1. The draft has changed since, so this approval does not cover it." and "Live content: Version 3 went live without the client's approval"; the old "(for earlier content …)" is gone |
| 2    | Client feedback panel                                      | pass: 12-hour IST; no 24-hour times, no GMT                                                                                                                                                                                                               |
| 3    | Notifications                                              | pass: "18 Nov 2026, 5:25 pm IST", older notices too                                                                                                                                                                                                       |
| 4    | Audit log and version history                              | pass: "18 Nov 2026, 8:20:24 pm IST"; history "8:19:02 pm IST"                                                                                                                                                                                             |
| 5    | Workspace settings                                         | pass: "Created 23 Oct 2026, 11:10 pm IST" (IST once)                                                                                                                                                                                                      |
| 6    | Templates, preview links                                   | pass: "Made 13 Nov 2026 · turned off 13 Nov 2026"                                                                                                                                                                                                         |
| 7    | Client review page                                         | pass: "Version published on 18 Nov 2026, 8:20 pm IST."; "Approved by Ramesh Test on 18 Nov 2026, 5:25 pm IST." (read-only)                                                                                                                                |
| 8    | Saving and undo in the editor                              | pass: "All changes saved", then "Undone · all changes saved"; no "Not saved", no reload notice                                                                                                                                                            |
| 9    | Reload notice in an editor tab left open across the deploy | n/a: no tab was open before the deployment. Covered by the E2E test; to be seen in production at the next deployment                                                                                                                                      |
| 10   | Console, speed, layout                                     | pass: only the known extension "[EXCEPTION] Object" entries; nothing slower than about 5 seconds; no broken layout                                                                                                                                        |

**Observations (recorded in DG-39 (d)):**

1. Day format differs: the review-link expiry reads "Until 02 Dec 2026, 5:24 pm IST" (zero-padded day, from `formatIst`) while dates elsewhere read "18 Nov 2026" / "2 Dec 2026" (`formatIstDate`).
2. "IST" twice on the audit log: the column header still says "When (IST)" while every cell now ends in "IST".
3. On "S8b Check", the first click on "Publish" right after the editor loaded did nothing; the second opened the panel. It did not happen on "S8c Check". It is probably a click before the page was ready; to be reproduced before any fix.
