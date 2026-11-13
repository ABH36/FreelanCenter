# Phase 3, slice S0: private technical go-live of the dashboard (Stage A)

**Status:** built and run live on `feat/p3-s0-golive`; awaiting the Owner's approval of the slice and of the gap-register updates (section 9). Nothing is marked closed until the Owner approves. **Date:** 2026-11-13 · **Plan:** `docs/governance/DASHBOARD_GO_LIVE_PLAN.md` (Stage A) · **Gaps:** DG-27 (Stage A), DG-28 (a), DG-16, DG-26, DG-17 · **Requirements exercised live:** FR-AUTH-01, FR-AUTH-03, FR-AUTH-04, SEC-09, FR-TPL-09, FR-AUD-01, NFR-PERF-04.

## 1. Why

Phase 2 closed with conditions because the production dashboard could not sign anyone in (DG-27). No live preview link could be made from it (DG-26), and nobody had measured its speed in region (DG-28). Stage A makes the production dashboard work for one person, the Owner, without buying a domain, so that Phase 3 starts from a deployed and measured dashboard.

## 2. What was done

| Step                                    | Who                     | Result                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production variables (plan §3.1)        | Owner, with a script    | `scripts/ops/set-dashboard-production-env.mjs --apply` added 7 variables (`DATABASE_URL`, `DATABASE_URL_AUTH`, `BETTER_AUTH_SECRET` generated in the script and sent only to Vercel, `BETTER_AUTH_URL`, `EMAIL_TRANSPORT=resend`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM` = the Resend shared sender). No value was printed or put in a chat |
| Redeploy and smoke test (plan §3.2.2)   | Claude, Owner-approved  | `/api/health` 200, `/sign-in` 200 (was 500), `/sign-up` 200 with the production Turnstile key, security headers present, no runtime error                                                                                                                                                                                                   |
| Inngest resync, archive `spike-g`       | Owner's browser agent   | `platform-dashboard` synced to `https://dashboard-liard-tau-14.vercel.app/api/inngest` (no bypass parameter), SDK 4.26.2, 7 functions. `spike-g` archived                                                                                                                                                                                   |
| Vercel automation bypass secret rotated | Owner's browser agent   | Rotated 2026-11-13 about 13:06 IST (it had been visible in the old Inngest sync URL). Nothing in the repository or CI uses it                                                                                                                                                                                                               |
| Resend check (read only)                | Owner's browser agent   | Account owner `aabhishekjain53@gmail.com`; no sending domain (DG-10 still open); the FreelanCenter key had never been used before this slice                                                                                                                                                                                                |
| Live account journey (plan §3.2.3)      | Owner, Claude checking  | Section 3                                                                                                                                                                                                                                                                                                                                   |
| In-region measurement (plan §3.2.4–5)   | Claude, Owner's session | Section 4                                                                                                                                                                                                                                                                                                                                   |

Code on the branch (all local CI-equivalent checks green, section 7):

| Commit    | Change                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ee6840d` | `scripts/ops/set-dashboard-production-env.mjs`: dry run by default; values reach Vercel only on stdin; existing variables are never overwritten             |
| `e525a4e` | `/api/health` (dashboard and sites) reports the Vercel environment when `PLATFORM_DEPLOYMENT_SURFACE` is unset (it said `local` in production)              |
| `665cdb1` | `scripts/ops/reset-user-2fa.mjs`: removes a TOTP factor that Production cannot decrypt (finding S0-1). One transaction, audited, dry run by default         |
| `adb93e3` | `apps/dashboard/lib/perf.ts` + `scripts/perf/dashboard-in-region.mjs`: server-side timing for measured requests only, and the in-region harness (section 4) |
| `125bdb2` | Overview page loads its two independent reads together (finding S0-3)                                                                                       |
| `cdd5566` | The harness warms the measured concurrency before measuring (finding S0-4)                                                                                  |

## 3. Live account journey (production, 2026-11-13)

| Check                                                    | Evidence                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-09 / DG-16:** live Turnstile solve, production key | The Owner's sign-up passed the captcha check and reached the password rule ("Password is too short" in the function log at 09:05:10 UTC). The captcha is checked before the endpoint, so the production secret verified a real widget token                                                                                  |
| **FR-AUTH-04:** no account enumeration                   | The address already had an account (created 2026-10-23 with Google during Phase 1 testing, verified, password added 2026-10-31). Sign-up showed the same "Check your inbox" screen as for a new address and sent nothing; "Resend verification" did the same. No new verification row was created (read-only database check) |
| **First real e-mail (Resend)**                           | Password reset requested from the sign-in page: one hashed verification row at 09:14:16 UTC, and "Reset your password - FreelanCenter" from `FreelanCenter <onboarding@resend.dev>` arrived in the Gmail **inbox** (not spam) at 14:44 IST. No `auth.mail.send_failed` log                                                   |
| **FR-AUTH-03:** TOTP on production                       | The old factor could not be read (finding S0-1). After the reset the Owner enrolled a new factor (stored `verified`, encrypted with the production secret) and signed in with a TOTP code; one live session created 09:44 UTC                                                                                                |
| Workspace and Templates                                  | The Owner's Phase 2 workspace **Pixelstack** (Owner role, 2 members, 2 projects) opened; Templates lists the 3 reference templates (version 2)                                                                                                                                                                               |
| **FR-TPL-09 / DG-26:** valid live preview link           | "Gym Bold" link created (valid to 20 Nov 2026) on `sites-two-nu.vercel.app/p/v1…`; it opened without sign-in with the "Preview of the Gym Bold template: demo content" banner. After **Turn off** the same URL showed "This preview link was withdrawn. Ask Pixelstack for a new link."                                      |
| **DG-17:** Inngest on production                         | Sync succeeded against the production alias (the sync is a signed exchange, so the production signing key matches). The Vercel Hobby log keeps only console output for 30 minutes, so the cron runs themselves leave no trace there: one look at the Inngest Runs page for `outbox.sweep.v1` is the open part (section 9)    |

## 4. NFR-PERF-04 in region (DG-28 a)

**Method.** The shape of the local harness (`packages/workspaces/test/perf`): 10 concurrent clients, 500 ms p95 budget. It runs against the production dashboard (Vercel function region `bom1`, Supabase `ap-south-1`) from the Owner's machine in India. Seven read-only pages: overview, projects list, search, filter, a project page, notifications and the audit log. Nothing in the live data changes. Two numbers per page:

- **server:** for each measured request, the span from the first to the last timed server call. The calls are the session lookup, workspace resolution and every service call; requests carrying `x-perf-request` log one `perf.server` line per call (`apps/dashboard/lib/perf.ts`). The budget applies to this number, as in the local harness, which times service calls without browser network.
- **client:** the full page time seen by the client, next to a `/api/health` round-trip baseline (that route does no database or session work).

**Deviations from the plan, and why.**

- A `Server-Timing` header is impossible on App Router pages: Next 16 sends the headers before rendering ends. The log line replaces it.
- A dedicated measurement account was not possible: the Resend shared sender delivers only to the Owner's address, so a second account cannot be verified. The Owner's own session was used instead. The Owner put the cookie into `.env.local` themselves, the script never prints it, and the line was deleted after the run. The Owner then signed out, which revokes it.

**Runs.**

| Run                        | Deployment, harness                                                              | Result                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (invalid, stopped)         | `dpl_4yrAnJnn…`, CLI deploy, functions in **iad1**                               | Service calls p50 5.4 s; not a product number (finding S0-2)                                                                                           |
| `s0-mwf6f56f`              | `dpl_4tUK…` (bom1, `adb93e3`), sequential warm-up, 700 requests                  | 0 errors; server p95 within budget except **overview 584 ms** (finding S0-3)                                                                           |
| `s0-mwf7dmda`              | `dpl_7dpa…` (bom1, `125bdb2`), sequential warm-up, 700 requests                  | 0 errors; overview 529 ms, audit 611 ms over; all-request p95 417 ms; 13 of the 19 spans over 500 ms fell in the first 6 s of the burst (finding S0-4) |
| **`s0-mwf7g16k` (result)** | `dpl_7dpa…` (bom1, `125bdb2`), concurrent warm-up, 20 rounds, **1,400 requests** | **0 errors, every page within budget (PASS)**                                                                                                          |

**Result (run `s0-mwf7g16k`, 200 samples per page, all 1,400 requests had their server lines).** `/api/health` round trip from the Owner's machine: p50 61 ms, p95 139 ms.

| Page            | Server p50 / p95 (ms) | Client p50 / p95 (ms) | Budget (server p95 ≤ 500) |
| --------------- | --------------------- | --------------------- | ------------------------- |
| Overview        | 128 / 254             | 191 / 339             | ok                        |
| Projects list   | 114 / 221             | 180 / 307             | ok                        |
| Projects search | 118 / 240             | 179 / 323             | ok                        |
| Projects filter | 113 / 213             | 173 / 299             | ok                        |
| Project page    | 121 / 208             | 187 / 286             | ok                        |
| Notifications   | 159 / 314             | 227 / 393             | ok                        |
| Audit log       | 245 / 440             | 317 / 538             | ok                        |

**Reading it.**

- The audit log is the slowest page and the closest to the budget: 440 ms server p95.
- The client p95 of 538 ms on the audit log is above 500 ms. That number includes the network from the Owner's machine, so it is not the budget figure, but a user sees it.
- **Instance cold starts are not part of the steady-state figure.** Run `s0-mwf7dmda` shows them: in the first seconds of a burst the slowest requests took about 0.6–1.1 s on the server, and the client-side overview p95 was about 2.3 s.
- Phase 8 observability (DG-28 b) should keep both numbers visible.

## 5. Findings

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                                        | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0-1 | **2FA unusable after the secret change.** Better Auth encrypts TOTP secrets and backup codes with `BETTER_AUTH_SECRET`. The Owner had enrolled on a Preview deployment, which has another secret but the same database. On production every TOTP and backup code failed with `invalid tag` and the user saw only "Something went wrong". Only the Owner's account had a factor | Owner-approved one-off fix: `reset-user-2fa.mjs` deleted the factor and cleared the flag in one transaction. It wrote audit row `01a1d441-02df-791a-954c-50f335f27f9c` (`auth.mfa.disabled`, reason `factor_unreadable_after_secret_change`, approved by the Owner). The Owner enrolled again. **Rule from now on:** production and Preview never share 2FA enrolments; changing `BETTER_AUTH_SECRET` requires re-enrolment of every factor. A user-facing recovery path for this case is a follow-up |
| S0-2 | **A CLI deploy ignored the project's region and runtime.** The deployment of `adb93e3` was uploaded with `vercel deploy --prod` from a `git archive` export. Its functions ran in `iad1` (Washington) on Node 26 instead of `bom1` on Node 24, so every database round trip crossed the world. The `X-Vercel-Id` header showed it (`bom1::iad1::…`)                            | Owner-approved rollback to `dpl_C2qw…` (bom1), then the branch was pushed and the git-built deployment promoted (`bom1`, Node 24). **Rule from now on:** production deploys come from git only, and every deploy is checked for the function region in `X-Vercel-Id` and in `vercel inspect`                                                                                                                                                                                                          |
| S0-3 | The overview page loaded the preview-link check only after the usage overview, although the two are independent. Server p95 584 ms                                                                                                                                                                                                                                             | `125bdb2` loads them together; overview server p95 254 ms in the result run                                                                                                                                                                                                                                                                                                                                                                                                                           |
| S0-4 | The first harness version warmed one instance with a single sequential pass. The 10-client burst then started new instances, and their cold starts were counted as page time                                                                                                                                                                                                   | `cdd5566` warms with the measured concurrency and uses 20 rounds. Cold-start numbers are reported separately (section 4)                                                                                                                                                                                                                                                                                                                                                                              |
| S0-5 | The planned "live sign-up with the Owner's e-mail" could not create a new account, because one already existed. Correct behaviour (FR-AUTH-04)                                                                                                                                                                                                                                 | The first real e-mail was proven with a password reset instead; a fresh sign-up and its verification e-mail remain to be shown once a second deliverable address exists (DG-10)                                                                                                                                                                                                                                                                                                                       |
| S0-6 | Vercel Hobby keeps runtime logs for 30 minutes and only console output (no request line for successful calls)                                                                                                                                                                                                                                                                  | Evidence for live runs has to be captured during the run (done here). Uptime and request metrics stay in DG-28 (b)                                                                                                                                                                                                                                                                                                                                                                                    |
| S0-7 | `scripts/**/*.mjs` is not linted in CI (`pnpm lint` runs per package), and the shared ESLint config has no Node globals for `.mjs` (`console`/`process` are `no-undef` when linted directly). Existing scripts have the same state                                                                                                                                             | Follow-up: lint root scripts with Node globals (needs the `globals` package, subject to the two-week rule)                                                                                                                                                                                                                                                                                                                                                                                            |
| S0-8 | Local only: `db:integration-again` failed in `outbox-sweep-order.test.ts`. The local Docker database holds 680 pending outbox rows left by earlier runs, more than the `outbox_pending(500, 0)` limit the test reads. GitHub CI starts from an empty database                                                                                                                  | Follow-up: make the test independent of other rows (filter by its own event name). No product change                                                                                                                                                                                                                                                                                                                                                                                                  |
| S0-9 | Revealing a plain Vercel variable needs the Owner's authenticator code, so the browser agent could not read `BETTER_AUTH_URL`, `EMAIL_TRANSPORT`, `EMAIL_FROM`                                                                                                                                                                                                                 | Not needed: the script sets them as constants, and the live e-mail shows the sender; sign-in works on the production origin                                                                                                                                                                                                                                                                                                                                                                           |

## 6. Security review

- **Secrets:**
  - No secret value was printed, logged, committed or put in a chat.
  - The variables were set by the Owner through a script that passes values on stdin.
  - The session cookie for the measurement was written by the Owner into an ignored file, never printed, and deleted after use.
  - The bypass secret that had been visible in Inngest was rotated.
- **Privacy:** the dashboard stays private. Only the Owner's address can receive mail from the shared sender, so nobody else can finish a sign-up or receive an invitation until DG-10.
- **New code paths:**
  - `perf.ts` logs only an operation name and times, and only for requests with a valid measurement id. Letters, digits and dashes, 8–64 characters, so the id cannot inject into a log line.
  - Requests without the header run unchanged, and synchronous service methods stay synchronous (unit-tested).
  - The header cannot reach data: every timed call still needs the signed-in session and RLS.
- **Database writes outside the application:** one, the 2FA reset. Owner-approved, a single transaction over a TLS-verified connection as `app_auth`, audited.
- **Residual:**
  - Production runs the unmerged branch `feat/p3-s0-golive` until the S0 PR merges.
  - After the rollback and promote, check that the merge's production deployment takes the domain automatically.

## 7. Tests and CI-equivalent

| Check                                            | Result                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full CI-equivalent on `adb93e3` (clean worktree) | 35 of 38 steps pass. The three failures are local only: `quality:visual` and `quality:browsers` (Windows font rendering and missing host libraries, the same on `main`; they pass on Linux CI) and `db:integration-again` (S0-8) |
| Dashboard unit tests                             | 8/8 (5 new for `perf.ts`: id validation, no logging without the header or outside a request, logged fields, failed calls, sync methods and `this`)                                                                               |
| e2e on `125bdb2`                                 | 11/11                                                                                                                                                                                                                            |
| Typecheck, lint, format on `125bdb2`             | clean                                                                                                                                                                                                                            |
| gitleaks on the S0 commits                       | 4 commits scanned before `125bdb2`, no leaks                                                                                                                                                                                     |
| Live                                             | Sections 3 and 4                                                                                                                                                                                                                 |

## 8. Live changes ledger

| Time (IST, 2026-11-13) | Change                                                                               | Approval                 | Rollback                          |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------ | --------------------------------- |
| before 12:47           | 7 production variables added                                                         | Owner, ran it themselves | `vercel env rm <name> production` |
| 12:47                  | Redeploy → `dpl_C2qw…`                                                               | Owner                    | `dpl_Ak3D…`                       |
| 13:04–13:06            | Inngest resync, `spike-g` archived, bypass secret rotated                            | Owner (browser agent)    | Resync to another URL; unarchive  |
| 15:05                  | 2FA factor of the Owner's account removed (audit `01a1d441-…`)                       | Owner                    | The Owner enrolled again          |
| 16:36                  | CLI deploy `dpl_4yrAnJnn…` (iad1, finding S0-2)                                      | Owner                    | Rolled back                       |
| 21:37                  | Rollback to `dpl_C2qw…`                                                              | Owner                    | —                                 |
| 21:43                  | Branch pushed by the Owner; git build promoted → `dpl_4tUK…` (bom1, `adb93e3`)       | Owner                    | `dpl_C2qw…`                       |
| 22:10                  | `125bdb2` pushed by the Owner; promoted → `dpl_7dpa…` (bom1), **current production** | Owner                    | `dpl_4tUK…`                       |

## 9. Open items and decisions for the Owner

1. **Approve the slice** and the gap-register updates. Proposed:
   - DG-27 Stage A closed (Stage B stays open with DG-10/DG-11).
   - DG-28 (a) closed with section 4.
   - DG-16 closed for the dashboard hostname.
   - DG-26 closed.
   - DG-17 closed after one look at the Inngest Runs page shows `outbox.sweep.v1` runs completing on the production URL.
2. **Open the S0 PR** after approval. Production then returns to deployments built from `main`.
3. Follow-ups, each as its own small PR:
   - Dependabot hygiene: close #67, a separate group for `better-auth` (its upgrades always re-run Spike F, ADR-006), and exclude `spikes/`.
   - S0-7 lint for root scripts.
   - S0-8 test robustness.
   - S0-1 user-facing recovery for an unreadable 2FA factor.
