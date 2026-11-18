# Phase 3, slice S8c: review polish from the S8b production check

**Status:** built on `feat/p3-s8c-review-polish`; tests in section 5; **approved by the Owner 2026-11-18** ("yes i approve"). **Date:** 2026-11-18 · **Requirements:** FR-PRJ-02 (lifecycle `Draft → InReview → Approved → Live`, transitions validated and audited), FR-NOT-01 (notifications), FR-AUD-01 (audit viewer), FR-PUB-06 (approval shown in the Publish panel) · **Modules:** 06, 02, 09 · **Gap:** DG-37 (j) · **Plan approved by the Owner 2026-11-18** ("yes i approve the plan"). **Migration:** none, so no live database step.

## 1. Why

The S8b production check (report `PHASE_3_S8B_APPROVAL_GATE.md` section 10) passed all 17 steps. It also found small gaps that make the review flow harder to follow: the project stopped at "Approved" after going live, an approval kept looking valid after the content changed, the audit log did not say what changed, times were in GMT in some places, and the automatic move to "In review" told nobody.

## 2. What was built

| #   | Change                                     | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Live publish completes Approved → Live** | `publishing.publish` (Live only): when the project is Approved, the publisher is an owner or admin and the project has an active platform subdomain, the same transaction moves it to Live (compare-and-set), writes the audit row `project.status_changed` as that member with `{from: approved, to: live, reason: published_live}`, and notifies the project's creator (`project.status_changed`, category `project.status`), as a manual "Go live" does. Any other status is left alone. |
| 2   | **Stale approval made visible**            | `publishing.status` returns `approval.stagingCoversDraft` (the current staging version has exactly the checksum the draft would publish now; `null` with nothing on staging). The Publish panel adds "(for earlier content: the draft changed since)" to "Approved by …" when it does not. This works with the policy on or off.                                                                                                                                                            |
| 3   | **Audit log says what changed**            | Status rows show "Draft → In review", "In review → Approved", "Approved → Live" under the label (from the stored metadata). The policy row is now "Client approval before Live changed" with "Switched on" or "Switched off". Actors without a member name read "System", "Client (review link)", "Platform admin" or "Background job".                                                                                                                                                     |
| 4   | **India time everywhere**                  | New `apps/dashboard/lib/time.ts` (`ist`, `istMinute`). The notification list, invitation expiry, the deletion banner and the "Deletion scheduled" message show IST instead of GMT; the audit log uses the same helper.                                                                                                                                                                                                                                                                      |
| 5   | **Automatic In review is announced**       | `createStagingLink`: when the S8b trigger moved the project from Draft to In review, the owners and admins get `project.review_requested` (category `project.review`), as for a manual request. The person who made the link is left out. No extra notice when the client approves: the `review.client_approved` notice already says it.                                                                                                                                                    |

## 3. Decisions

From the approved plan:

1. **Approved → Live by the publisher, not the system.** Only owners and admins may make the move (`projects_guard`), so it runs as the publishing member and needs no database change. An editor who may publish through the workspace policy leaves the status as it is.
2. **Only from Approved.** A Live publish of a Draft or In review project (policy off) does not jump statuses, and a Paused project is resumed only by its own button.
3. **No double notice** on the client's approval (decision 5 of the plan).
4. **No migration:** every change uses existing tables, grants and policies.

## 4. Security review

- The status move runs inside the publish transaction under RLS as the member; `projects_guard` still checks the role and the active subdomain, and the update is compare-and-set (`WHERE status = 'approved'`), so a concurrent change wins cleanly.
- Notices go through the existing `notify` helper: ids only in payloads, recipients' own preferences, the actor never notifies themselves. The new review-requested notice lists only owners and admins of the same workspace (RLS-scoped query).
- `stagingCoversDraft` compares checksums the member can already read; nothing new is exposed.
- The audit detail is read from metadata the viewer (owners only) can already see. No content, names or e-mails are added to audit rows.
- Time formatting is presentation only.

## 5. Tests and evidence

| Suite                                            | Result                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approval-gate.test.ts` (integration, 4 new S8c) | 17/17                                                                                                                                                                          |
| workspaces integration (full)                    | 241/242 on the full run; the one miss was `builder.test.ts` "undo reaches the last 50 changes" timing out at 60 s under load (code not touched by S8c); that file alone: 11/11 |
| workspaces unit                                  | 113/113                                                                                                                                                                        |
| dashboard unit (new `time.test.ts`)              | 10/10                                                                                                                                                                          |
| e2e checkpoint                                   | 22/22 (rerun; the first run stopped at sign-up, where `next dev` kept reloading the page, the known laptop flakiness)                                                          |

New integration tests: a Live publish by an owner moves Approved → Live, audited as the owner, creator notified once (a second Live publish notifies nobody); a Live publish of a Draft project leaves it Draft; the automatic In review notifies owners and admins except the link's maker (and nobody for a second link); `stagingCoversDraft` is null, true, then false after an edit. Two S8b tests were adjusted: the policy-off panel now includes `stagingCoversDraft: null`, and the preference test counts only the approval e-mails (the link now also sends review-requested e-mails). The e2e journey checks the new audit label and "Switched on".

## 6. CI-equivalent (local, 2026-11-18)

Format (changed files), lint, typecheck (18/18), unit (workspaces 113, dashboard 10), build (dashboard and sites; only the existing Edge-runtime warnings of the logger), isolation 402/402, the workspaces integration suite and e2e as above. No database change, so `db:verify` and the db suite are unchanged from S8b.

## 7. Cost

No new service or subscription.

## 8. Open items

- ~~Owner approval~~: approved 2026-11-18. ~~Merge~~: PR #104, `23c2b0d` (no live migration).
- ~~Production check~~: passed 2026-11-18 (section 9).
- ~~Gap register DG-37 (j)~~: marked built after PR #103 merged (`6a0bdc7`) and `main` was merged into this branch.
- DG-39: deployment follow-ups found by the production check (section 9).
- DG-37 (h) (tokens in Vercel's request log) stays with S9.

## 9. Production check (2026-11-18, Chrome extension, Owner-run)

**Deployment incident first.** The first run found the old behaviour on every read-only step, and the extension stopped before publishing anything. Vercel had built no deployment for the merge commit `23c2b0d`: no GitHub deployment and no commit status, for both projects. The last production deployment was the previous merge (`6a0bdc7`). The GitHub-to-Vercel push event was evidently lost; CI on `main` had run and passed. With the Owner's OK ("haa option se deploy kr do"), production deployments of `main` at `23c2b0d` were created through the Vercel API from the Git source (the same build as a normal push; no local files uploaded, no token printed): dashboard `dpl_4XxSPd1rC1JMN9n99J9eD5YJJ68h`, sites `dpl_23sfigWEoSyhXfFumaCF18KkJEpm`. Both were Ready, the production domains pointed to them, and health answered 200. From now on, each merge is confirmed on the production deployment list before a production check is sent (DG-39 (a)).

**Second run: all steps passed** (step 6 not applicable: no open invitations). "S8b Check" went from Approved to Live; "S8c Check" was created and left in place.

| Step | Checked                                                                                                 | Result                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1    | Audit: "Draft → In review", "In review → Approved" by System; policy "Switched on/off"; IST             | pass                                                                                                                |
| 2    | Notifications in IST, no GMT                                                                            | pass (older notices too)                                                                                            |
| 3    | Stale approval marked "(for earlier content: the draft changed since)"; no "Before Live" row            | pass                                                                                                                |
| 4    | Live publish of the Approved project: version 3 Live, status Live, audit "Approved → Live" by the Owner | pass                                                                                                                |
| 5    | New project, staging, review link: status In review by itself; no notice to the link's maker            | pass (the second owner of the workspace should get it; not visible to the checker, covered by the integration test) |
| 6    | Invitation expiry in IST                                                                                | n/a                                                                                                                 |

Console: the two known extension "[EXCEPTION] Object" entries on every page load. One application error, explained below. Nothing slower than about 5 seconds; no broken layout.

**Observations (recorded in DG-39):**

1. An editor tab left open across the deployment logged 12 × `UnrecognizedActionError: Server Action … was not found on the server`. The old page's save calls reached the new build, whose server action ids changed. No data was lost here, but someone editing during a deployment may not be told that a save failed. Detecting it and asking for a reload is DG-39 (b).
2. After the Live publish, the approval row still says "(for earlier content …)". This is accurate (version 3 was never approved), but people may expect it to clear. Wording only.
3. Mixed clock formats: Publish and review pages use "5:25 pm", the audit log and notifications "17:25:45".
