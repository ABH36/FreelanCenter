# Phase 1 report: Multi-Tenant Core (slice 9, phase exit)

**Status:** Slices S1-S8 and DG-22 are merged on `main` (last: PR #37, `71f9c54`, post-merge CI green). S9 (this report) is built on `feat/p1-s9-phase-exit` (PR #38). **The Owner approved this report, the live migration and one live NFR-PERF-04 measurement on 2026-10-31.** The migration is applied live (section 7); the PR is not merged yet. This report is the input for the ChatGPT/Architect audit of Phase 1.
**Date:** 2026-10-31 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 1 slice plan, row S9 · **SRS:** section 12, Phase 1 acceptance and audit checklist.

## 1. Acceptance and requirements

SRS 12 Phase 1 acceptance: _a user signs up, verifies email, creates a workspace, creates a project and reaches its unique subdomain; a second user's workspace cannot see, list or modify the first's data through UI, API or direct DB access as `app_user`; isolation suite green on every table._

| Acceptance clause                                | Evidence                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up, verify, workspace, project, subdomain   | `tests/e2e/src/checkpoint.e2e.ts` (Playwright, Chromium, both apps, local stack): tests 1-2. The visitor page answers 200 on the allocated host and 404 on an unknown one                                                                                 |
| Second tenant denied through the UI              | E2E test 3: six pages of A's workspace answer 404 for B; B's list and search show nothing of A; A's project id under B's workspace is a 404                                                                                                               |
| ... through the API                              | E2E test 4: audit export of A's workspace is 404 for B; a server-action form of B with the hidden workspace id swapped for A's is refused, creates nothing and A's data is unchanged                                                                      |
| ... through direct database access as `app_user` | E2E test 5: with B's context, A's project is invisible (0 rows), an UPDATE changes 0 rows, A's workspace row is invisible, `app_user` has no DELETE on projects (SQLSTATE 42501); a control with A's context sees the project, so the zeros are isolation |
| Isolation suite green on every table             | `tests/isolation`: 189 tests, per-table matrix, row-factory registry; mutation check 11/11 killed                                                                                                                                                         |

**What the DB layer does and does not prove (found while writing test 5).** The database boundary is the workspace id in the transaction-local context; _membership_ is proven by the application before a `TenantScope` exists (`packages/db/src/client.ts`: "only after the actor's membership was verified server-side"). A raw SQL session that sets `app.workspace_id` to A's id sees A's rows even with B's user id. That is the designed split (SEC-01, FR-AUTH-08), and `app_user` credentials are server-only. The forged-id attack is therefore tested where it can actually occur: the server-action leg of test 4. This is recorded so the auditor does not assume a membership check inside RLS for tenant tables.

### 1.1 All 28 Phase 1 requirements

Status vocabulary follows `docs/governance/DOCUMENTATION_INDEX.md`: _implemented_ = code + automated tests; _verified_ = additionally approved by the Owner/Architect phase audit. **Nothing is marked verified until this report is audited**; `docs/traceability.md` is generated and still says "Planned" (its status column only knows Phase 0), which I did not hand-edit.

| Requirement                  | Slice (report)                       | Evidence                                                                                                    | State                                                                                                                                                     |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-AUTH-01, -02, -04, -07    | S4 (`PHASE_1_S4_DASHBOARD_AUTH`)     | Product auth suite, 191 tests, run 3x on one database; live Google round trip                               | Implemented                                                                                                                                               |
| FR-AUTH-03                   | S4, DG-22, S8                        | Enrolment + `requireMfa` guard; TOTP challenge after Google sign-in (DG-22, live pass); admin step-up (S8)  | Implemented (payout/white-label enforcement call sites are P6/P7A)                                                                                        |
| FR-AUTH-05, -06, -08         | S5 (`PHASE_1_S5_WORKSPACES_RBAC`)    | Invitation, role and membership suites; raw-SQL role checks as `app_user`; accept-once and last-owner races | Implemented                                                                                                                                               |
| FR-WS-01, -02                | S5                                   | Workspace service suite (create, reserved slugs, switcher, settings)                                        | Implemented                                                                                                                                               |
| FR-WS-03                     | S5, S6, S7                           | Namespace (S5), platform subdomain allocation (S6), host resolution (S7)                                    | Implemented                                                                                                                                               |
| FR-WS-04                     | S1, S7, S8                           | Write block in RLS (S1), maintenance page (S7), audited suspend/unsuspend (S8)                              | Implemented                                                                                                                                               |
| FR-PRJ-01 (P1 part), -02..05 | S6 (`PHASE_1_S6_PROJECTS_LIFECYCLE`) | Transition table (unit + DB trigger), concurrent-transition race, duplicate, client contact                 | Implemented (template part is P2)                                                                                                                         |
| FR-DOM-01                    | S6, S7                               | `app.allocate_platform_subdomain`; `app.resolve_host` + cache; E2E test 2                                   | Implemented                                                                                                                                               |
| FR-ADM-01 (basic), FR-ADM-02 | S8 (`PHASE_1_S8_ADMIN_CONSOLE`)      | Admin suite, non-admin denial, step-up, live run on the PR #35 Preview                                      | Implemented (full console P8)                                                                                                                             |
| FR-AUD-01                    | S1, S4, S6, S8                       | Append-only store, auth events, workspace viewer/export, platform rows; E2E test 6 reads the viewer         | Implemented                                                                                                                                               |
| FR-NOT-01                    | S5, S6                               | Invitation mail through the signed Inngest executor; in-app notifications with preferences                  | Implemented (real sending needs DG-10)                                                                                                                    |
| FR-OBS-01                    | DG-03, S9                            | Redacting structured logger with correlation ids; Sentry server-side with scrubbing (section 2.2)           | **Partial.** Metrics, OpenTelemetry tracing, uptime checks and alert runbooks are not built in P1; Sentry is code-complete but has no account yet (DG-23) |
| SEC-01, SEC-02, SEC-10       | S1, S2, S5                           | RLS forced, roles, isolation suite as a required check, IDOR harness                                        | Implemented                                                                                                                                               |
| SEC-03                       | S7                                   | Headers test on both apps; strict CSP on tenant host pages                                                  | Implemented (full per-surface CSP with the builder, P3)                                                                                                   |
| NFR-PERF-04                  | S6                                   | p95 harness `test:perf` (10 concurrent clients, 500 ms budget)                                              | **Met on a hosted runner (85 ms worst p95); laptop figures not representative; in-region deployed measurement outstanding (6.2)**                         |

Also exercised in P1 and listed in the plan: SEC-09 (Turnstile, test keys; production widget DG-16), SEC-11 (single-use tokens, no-referrer), SEC-17 (admin MFA and audit), SEC-21 (processor list, section 5).

## 2. What S9 built

### 2.1 Playwright E2E (`tests/e2e`, CI job `e2e`)

- Package `@platform/e2e` (Playwright 1.64.1, released 2026-10-14, exact pin). The config starts both apps in **development mode** because the capture inbox that holds the verification mail is a 404 in a production build; production builds are covered by `pnpm build` in the `verify` job.
- **Safety:** `assertLocalStack` refuses any `DATABASE_URL*` that is not 127.0.0.1/localhost; every connection string comes from `LOCAL_DATABASE_URLS`; the auth secret is a fixed synthetic value; Turnstile uses Cloudflare's published test keys. The suite cannot reach a live project.
- Two users onboard through the real sign-up form (Turnstile widget included), verify through the mailbox link and create their first workspace; the six serial tests are in section 1. Traces and screenshots are kept on failure and uploaded by CI.
- One dashboard markup change: `data-testid="project-address"` on the project address.
- The `e2e` job is **not a required check** yet (Owner decision: after it is green on the S9 PR).

### 2.2 Sentry (FR-OBS-01, SEC-05, SEC-21)

- `@sentry/nextjs` 11.8.0 (2026-10-15) in both apps via `instrumentation.ts` (Node runtime only). **Off unless `SENTRY_DSN_DASHBOARD` / `SENTRY_DSN_SITES` is set to an EU-region DSN** (`*.de.sentry.io`); an invalid or non-EU DSN logs `observability.sentry.disabled` and sends nothing. No browser SDK, no tracing, no replay, no tunnel route, no `withSentryConfig` (no source-map upload).
- `@platform/logger` gained `checkSentryDsn`, `SENTRY_DATA_COLLECTION`, `scrubSentryEvent` and `sentryOptions` (pure functions, 7 unit tests) and `apps/sites/lib/sentry.test.ts` drives the **real SDK** with a capturing transport: user id survives, e-mail, IP and tokens do not.
- **Not done:** no Sentry account exists, so no event has reached Sentry. Live proof is Owner-gated (DG-23).

### 2.3 Outbox sweep order (S8-6)

Migration `20261031120000_p1_s9_outbox_sweep_order` replaces `app.outbox_pending` (same signature, guards and grants) with `ORDER BY o.attempts, o.created_at`, so rows that keep failing no longer hold healthy rows back. New integration test `outbox-sweep-order.test.ts` (order, 20-attempt skip, minimum age, limit). **Applied live on 2026-10-31 with the Owner's approval** (section 7).

## 3. Findings during the slice

| ID   | Finding                                                                                                                                                                                                              | Consequence                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S9-1 | **Sentry 11 collects everything by default** (cookies, headers, bodies, query parameters, user info, DB data, local variables); `sendDefaultPii` no longer exists. A config copied from older docs would have leaked | `SENTRY_DATA_COLLECTION` switches each one off; test asserts every switch. Re-check on every Sentry upgrade |
| S9-2 | My own first scrubber redacted the trace `span_id` (16 digits match the card pattern), which would break trace linking. Found by running the real SDK                                                                | Trace context is exempt; unit test and SDK test                                                             |
| S9-3 | A cold development server reloads open pages while it compiles, so the sign-up button never enabled in the first E2E run                                                                                             | The suite warms the routes first. CI runs a cold server too: the `e2e` job's first run is the evidence      |
| S9-4 | Node's HTTP client does not resolve `*.localhost` on Windows                                                                                                                                                         | Requests go to 127.0.0.1 with the `Host` header, which is what the app routes on                            |
| S9-5 | The DB layer does not check membership for tenant tables (section 1)                                                                                                                                                 | Documented; tested at the server-action leg                                                                 |
| S9-6 | The first clean-worktree typecheck and build failed on an untyped parameter in my Sentry test (not seen in the working tree, where I had typechecked before adding the test). Fixed in `29a9d44`                     | Why the clean worktree exists                                                                               |
| S9-7 | The first CI-equivalent run was corrupted by two scripts writing to one log and one database; I discarded it and re-ran once                                                                                         | Results below are from the single clean run                                                                 |
| S9-8 | `next dev` writes `AGENTS.md` into each app; both are committed (the files ask for it) so the tree stays clean                                                                                                       | Say so if you prefer them ignored                                                                           |

## 4. Rate-limit review (SRS 12 audit checklist)

| Control                           | Where                                              | Limit                                                | Verdict                                                                                                    |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sign-in, sign-up                  | Better Auth `RATE_LIMIT_RULES`, DB storage, per IP | 5 / min each; sign-up also Turnstile                 | Pinned by `config.test`. Shared NAT can block honest users: accepted                                       |
| Password reset, verification      | same                                               | 3 / min (request, resend), 5 / min (reset), 10 / min | OK; request and resend also Turnstile                                                                      |
| TOTP                              | `/two-factor/*` 10 / min + account lockout         | 5 failures / 15 min                                  | OK (S8-1 closes the signed-in oracle)                                                                      |
| Admin step-up                     | database                                           | 5 failed or abandoned / 15 min per admin             | OK (8 parallel attempts yield exactly 5)                                                                   |
| Other auth endpoints              | Better Auth default                                | 100 / min per IP                                     | OK                                                                                                         |
| Invitations, workspaces, projects | service layer                                      | 50 / day, 5 / day, 100 / day per workspace or user   | OK against abuse; not a burst limiter                                                                      |
| `/api/inngest`                    | Vercel Firewall rule (DG-17)                       | 300 / 60 s per IP, signed requests                   | OK                                                                                                         |
| **RL-1 apps/sites**               | none in the app                                    | negative cache 60 s, strict host normalisation       | **Closed 2026-10-31:** Vercel Firewall rule, 600 requests / 60 s per IP (DG-23).                           |
| **RL-2 dashboard reads**          | none per user                                      | -                                                    | Accepted for P1: authenticated, page size ≤ 100; revisit with the first public API (P4+)                   |
| **RL-3 client IP**                | trusted header `x-vercel-forwarded-for` on Vercel  | -                                                    | Correct on Vercel; any new host must set `AUTH_CLIENT_IP_HEADER` (config refuses defaults it cannot trust) |

## 5. Security, privacy and threat-model review

- **Audit checklist items.** RLS policies and roles: `db:verify` and the catalog suite on every run. No session-level `SET`: transaction-local `set_config` only, lint-enforced, concurrency suite. Composite FKs: schema + isolation matrix. Permission matrix: S5 role x capability test. Auth flows: S4/DG-22/S8 reports. Audit coverage: E2E test 6 plus S4-S8 suites. Secret handling: gitleaks job, redacting logger, E2E local-only guard, Sentry scrubbing.
- **Privacy inventory** (`docs/privacy-inventory.md`): Supabase, Vercel, Cloudflare (Turnstile; R2 is P3), Upstash and Inngest are engaged and recorded with regions; Sentry row updated to EU, scrubbed, off until a DSN exists. Resend stays "capture only" (DG-10).
- **Threat model** (`docs/threat-model.md`, reviewed 2026-10-31): three rows added (error tracking, sites visitor path, E2E harness). Open risks carried forward: no pen test (SEC-18, P8), network-level DoS delegated to Vercel/Cloudflare (SEC-19), the `app_admin` credential residual (S8), Better Auth 1.7.12 behaviours re-checked on every upgrade (S8-1, S8-2/DG-22).
- **Failure paths:** Sentry never throws into a request (SDK-internal); a bad DSN disables it; E2E refuses non-local databases; the sweep change only reorders.

## 6. Tests

### 6.1 CI-equivalent run (2026-10-31)

Clean worktree `../s9-wt` at `45cc234`, then `29a9d44` for the one-line test fix (typecheck 16/16 and build 3/3 re-run on it). `pnpm install --frozen-lockfile`, database stack from `db:up`, same step order as `.github/workflows/ci.yml` plus `test:perf` and the new E2E.

| Step                                                                               | Result                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| format:check, sync-plan:check, lint, unit `pnpm test`                              | pass                                                                           |
| typecheck, build                                                                   | **failed first time (S9-6), pass on `29a9d44`**                                |
| traceability regenerate + diff, `pnpm audit --high`                                | pass                                                                           |
| bootstrap (twice), migrate (incl. the S9 migration), configure, drift, `db:verify` | pass; drift: no difference                                                     |
| `@platform/db` integration with coverage gate                                      | 101 tests; statements 94.26 %, lines 96.31 %; second run without coverage: 101 |
| Isolation suite / mutation check                                                   | 189 tests / 11 of 11 mutations killed, suite green after revert                |
| Product auth suite x3                                                              | 191 tests each                                                                 |
| Workspaces / jobs (signed Inngest executor) / hosting                              | 124 / 7 / 21 tests                                                             |
| **E2E**                                                                            | **6 passed (3.5 min)**                                                         |
| `test:perf`                                                                        | fail on the laptop (6.2); passes on a hosted runner, worst p95 85 ms           |

Not run: the `secrets` (gitleaks, Docker image) CI job, which runs on the PR; the E2E on a cold Linux CI runner; the live Supabase suite (no live change in S9).

### 6.2 NFR-PERF-04 (p95 <= 500 ms, 10 concurrent clients): met on a hosted runner, not on the developer laptop

**Local (Docker stack on this machine, 2-core/4-thread i5-7200U with other containers running).** `test:perf` fails. Same test on `main` (`71f9c54`), same worktree and session: `listProjects` p95 545, `createProject` 814; on S9: 640 and 1127 (two runs, 827 and 640 for `listProjects`). Run-to-run variance is larger than the difference, and S9 changes none of the ten measured operations. DG-22 recorded the same failure on `main`.

**Live (Owner-approved, 2026-10-31, one run).** The same harness (`PERF_TARGET=env`, an opt-in switch added to `packages/workspaces/test/harness.ts`; default stays local) against the Supabase `ap-south-1` transaction pooler as `app_user`/`app_auth`, run from the developer laptop, 1000 seeded projects, 10 clients x 20 rounds, jobs inline, host cache on the local emulator. A plain `select 1` round trip from the laptop to the pooler: p50 22 ms, p95 27 ms.

| Operation                | p50 ms | p95 ms | Within 500 |
| ------------------------ | ------ | ------ | ---------- |
| listProjects             | 355    | 549    | no         |
| listProjects (search)    | 360    | 463    | yes        |
| listProjects (filter)    | 349    | 440    | yes        |
| listProjects (next page) | 356    | 442    | yes        |
| getProject               | 373    | 456    | yes        |
| transitionProject        | 529    | 675    | no         |
| createProject            | 657    | 827    | no         |
| unreadCount              | 540    | 665    | no         |
| listNotifications        | 398    | 525    | no         |
| listAuditLog             | 342    | 429    | yes        |

**Diagnosis (S10, 2026-10-31).** With one client the same operations take p50 26-59 ms and p95 47-125 ms on the laptop. With 10 clients the p50 rises about tenfold, i.e. the operations run effectively one after another: one Node process on a 2-core 2.5 GHz laptop (sharing the CPU with Postgres, PgBouncer and other containers) is CPU-saturated, which is what the harness measures. It is not a tail problem and not network (22 ms round trip).

**Hosted runner (PR #40, new informational CI job `perf`, GitHub `ubuntu-latest`, local Docker database, no network, same harness: 1000 projects, 10 clients x 20 rounds).** The test passes:

| Operation                | p50 ms | p95 ms |
| ------------------------ | ------ | ------ |
| listProjects             | 31     | 47     |
| listProjects (search)    | 33     | 49     |
| listProjects (filter)    | 31     | 42     |
| listProjects (next page) | 29     | 34     |
| getProject               | 28     | 44     |
| transitionProject        | 50     | 74     |
| createProject            | 68     | 85     |
| unreadCount              | 49     | 66     |
| listNotifications        | 30     | 42     |
| listAuditLog             | 30     | 40     |

**Conclusion.** The service layer meets NFR-PERF-04 with a wide margin (worst p95 85 ms against 500 ms) on ordinary hardware; the laptop and laptop-to-Mumbai figures above were measuring the laptop. I considered folding the scope check into the data transaction (about a third fewer statements) and **did not do it**: with this margin there is no measured benefit, and it would change the `TenantScope` proof that SEC-01 rests on. It stays an option if a deployed measurement ever shows a miss. The CI job now gives a reproducible number on every PR. **Still outstanding for full evidence:** a measurement inside the deployed region (Vercel `bom1` function to the Supabase pooler); the expected cost is these CPU figures plus a few in-region round trips per operation, but that is an expectation, not a measurement. It moves to Phase 2 with the first real dashboard traffic (Vercel Observability on the dashboard project).

**Synthetic data left on the live database** (append-only/no DELETE for `app_user`, so it stays until `retention.sweep`, P8): one workspace named "Suite Workspace" with a `suite-...` slug, 3 users `ws-...@example.test`, about 1,200 projects with platform subdomains under the live `sites_domain`, their outbox rows and audit rows. The sites production alias is still pinned to the 16 Oct deployment (DG-20), so none of these hosts is served. The workspace can be suspended from the admin console if you want it offline.

## 7. Compatibility, migration and rollback

One forward-only migration (function replace, no table change; `schema.prisma` unchanged, `db:drift` clean). **Applied live 2026-10-31 (Owner-approved):** read-only pre-check as `migrator` (remote host, no BYPASSRLS, S1-S8 applied, S9 absent, function still in the S6 order, owned by `svc_definer`); `prisma migrate deploy` applied `20261031120000_p1_s9_outbox_sweep_order`; migrate status up to date; live database vs `schema.prisma`: no difference; `db:verify --target env` 28/28; `test:live` 6 passed, 1 skipped. No API, event or job change. New optional variables: `SENTRY_DSN_DASHBOARD`, `SENTRY_DSN_SITES` (already named in `.env.example`). Rollback: a new migration restoring `ORDER BY o.created_at`. Application rollback is a revert; Sentry is inert without its variables.

## 8. Open items and decisions for the Owner

| Item                                | Needed from / state                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approve S9 (this report)            | **Approved and merged 2026-10-31** (PR #38, `d769cf0`)                                                                                                                         |
| Live migration `20261031120000_...` | **Done 2026-10-31, Owner-approved** (section 7)                                                                                                                                |
| `e2e` as a required check           | **Done 2026-10-31** (added to the `main` protection: db-integration, verify, e2e)                                                                                              |
| NFR-PERF-04                         | Met on a hosted runner (6.2). Open: one in-region measurement from a deployed `bom1` function, with the first real dashboard traffic (P2)                                      |
| Sentry (DG-23)                      | Owner creates the EU project and sets the two DSN variables in Vercel; then a live event proof                                                                                 |
| Sites rate limit (RL-1, DG-23)      | **Done 2026-10-31:** Vercel Firewall rule "Rate limit sites per IP" (600 requests / 60 s per IP) published on the sites project                                                |
| DG-20 / DG-21                       | **Done 2026-10-31 (Owner-approved):** production variables set, both projects redeployed, sites production alias promoted (health 200, unknown host 404); see the gap register |
| DG-10 / DG-16                       | Unchanged: real e-mail domain; production Turnstile widget                                                                                                                     |
| FR-OBS-01 remainder                 | Metrics, OpenTelemetry, uptime checks, alert runbooks are not in P1; confirm they move to P2/P3 or P8                                                                          |
| Phase 1 audit                       | ChatGPT/Architect audit of this report; Phase 1 is "approved with conditions" only after it                                                                                    |
