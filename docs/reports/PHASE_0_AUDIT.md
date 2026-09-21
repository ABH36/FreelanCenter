# Phase 0 - Audit Outcome

**Recorded by:** Claude (Builder), from the audit text the Owner relayed · **Date:** 2026-09-21
**Audited artefact:** `docs/reports/PHASE_0_REPORT.md` against `SRS.md` v1.2.1. The report itself is left unchanged, because it is the artefact that was audited.

## 1. Verdicts

| Auditor                 | Verdict                      |
| ----------------------- | ---------------------------- |
| Architect (Gemini)      | **APPROVED WITH CONDITIONS** |
| Phase auditor (ChatGPT) | **APPROVED WITH CONDITIONS** |

**Status log:** SRS **v1.2.1 is frozen.** From now on the SRS changes only through an ADR approved by the Owner and confirmed by the Architect (SRS rule 0.2.4). The next document is `docs/reports/PHASE_1_REPORT.md`, audited against this SRS.

## 2. Architect rulings

| Item                                   | Ruling                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appendix B: all 15 SRS edits           | **Approved** (rows 1-2 RLS/definer hardening, 3 transaction pattern, 5 domain queue, 6 AI SDK v7, 7-15 housekeeping)                                                    |
| Q12 P3A/P3B split                      | **Approved.** P3A = Builder, assets, theme editor, live preview. P3B = versioning, staging, client review, publish, rollback, preflight                                 |
| Q4 workspace purge                     | **Approved:** `deleted_at` columns in P1, `retention.sweep` in P8                                                                                                       |
| Q5 Client vs RLS                       | **Approved** (transaction-local GUCs such as `app.actor_kind`), but it demands extreme rigour in the Phase 5 isolation suite                                            |
| Editor publish default                 | **Approved:** staging only. The Architect labelled it "Q6"; in `docs/IMPLEMENTATION_PLAN.md` this is **Q15** (Q6 is the sites read-path role). I have applied it as Q15 |
| Phase 1 Task 0(a): Spike B on Supabase | **Confirmed hard blocker.** No product schema or Prisma models until it passes                                                                                          |
| Deferrals G2, G3, G4, G7               | **Approved to defer**, because they need Owner accounts. They block: G2 -> P7A, G3 -> P6, G4 -> P4, G7 (logger) -> early P1                                             |

## 3. Findings and evidence gaps

| ID   | Ref        | Severity | Finding                                                                          | Required fix                                                      |
| ---- | ---------- | -------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| F-01 | G5         | **S2**   | Spike B ran on local PgBouncer, not on Supabase (its pooler behaves differently) | Run on live Supabase `ap-south-1` as Phase 1 Task 0               |
| F-02 | G6         | **S2**   | CI and preview never ran                                                         | Initial commit + CI at the start of Phase 1                       |
| F-03 | G4         | S3       | AI latency/cost unknown                                                          | Owner supplies the Anthropic key; run live Spike C before Phase 4 |
| F-04 | G7         | S3       | Health endpoints are not observability                                           | Structured, redacting logger early in Phase 1 (tasks 9/10)        |
| -    | SEC-18     | evidence | Threat model not yet reviewed by a second party                                  | Owner/Architect review `docs/threat-model.md` in Phase 1          |
| -    | NFR-OPS-01 | evidence | Reproducibility cannot be validated without CI on a remote                       | Closed by F-02                                                    |

**Architect scorecard** (only the Architect scored): Correctness 4, Security 5, Tenant isolation 5, Test quality 4, Performance 4, UX n/a, Maintainability 5, Documentation 5, Cost awareness 5.
_Builder note:_ the Tenant-isolation score rewards the design and the lint boundaries. Isolation itself is **de-risked, not implemented**; the Phase 1 isolation suite is the real evidence, and I will report it as such.

## 4. Auditor (ChatGPT) blockers

| #   | Blocker                                                                         | Needed before                 |
| --- | ------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Spike B re-run on live Supabase `ap-south-1` (no Prisma schema until it passes) | any Phase 1 product work      |
| 2   | GitHub repository, first commit pushed, GitHub Actions green                    | any Phase 1 product work      |
| 3   | Vercel team, preview deployments verified                                       | Phase 1 acceptance            |
| 4   | Anthropic API key                                                               | **Phase 4 only**, not Phase 1 |

## 5. Reconciling the two audits (my reading; please correct me)

The auditors differ slightly on timing: the Architect authorises starting Phase 1 under conditions (Task 0(a) first), the auditor says Phase 1 cannot begin until blockers 1-3 are resolved. **SRS 13.4: disagreements are resolved in favour of the stricter finding.** So I apply the stricter one:

- **Nothing in Phase 1 that touches the product starts** until blockers 1, 2 and 3 are closed. Blocker 1 (Spike B on Supabase) is itself the Architect's Task 0(a) and is the first thing I do once Supabase credentials exist.
- If the Supabase pooler **leaks tenant context**, I stop and notify the Architect (Architect condition 2). I do not work around it.
- Anthropic key: Phase 4 only, but Spike C live must be done before Phase 4 starts.

## 6. Conditions on the Builder (Architect)

1. Make the initial commit to the repository the Owner provides (closes G8) and establish CI (closes G6).
2. Run Phase 1 Task 0(a) (Spike B against Supabase) immediately; stop and notify if context leaks; no Prisma models until it passes.
3. Implement the redacting structured logger (FR-OBS-01) among the early Phase 1 tasks.

## 7. What the Owner must provide

| #   | Item                                                      | How to give it to me (no secrets in chat)                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Empty GitHub repository** (private; no README/licence)  | Tell me the URL. `gh` on this machine is already logged in as `ABH36`, so I can push. I will confirm before the first push                                                                                                                                                        |
| 1b  | **Commit identity**                                       | Git is configured as `ABH36 <aabhishekjain53@gmail.com>`. Confirm this is the author you want on every commit, or give me another. I will not guess                                                                                                                               |
| 1c  | `index.html` (empty file at the repo root)                | Your file, untouched. I will **leave it out** of the initial commit unless you say otherwise                                                                                                                                                                                      |
| 2   | **Supabase project in `ap-south-1` (South Asia, Mumbai)** | Preferably a **scratch project** for the spike (I create and drop roles/tables). Put `DIRECT_URL` (direct, port 5432) and `DATABASE_URL` (transaction pooler, port 6543) into a git-ignored `.env.local` yourself. Also tell me the Postgres major version shown in the dashboard |
| 3   | **Vercel team** (region `bom1`)                           | Run `vercel login` on this machine, or place a `VERCEL_TOKEN` in `.env.local`. Tell me the team slug                                                                                                                                                                              |
| 4   | Anthropic API key (Phase 4)                               | `ANTHROPIC_API_KEY` in `.env.local` when convenient                                                                                                                                                                                                                               |
| -   | Needed soon, not blockers for Task 0                      | Upstash Redis (Mumbai), the two domains (D1), an email provider or Mailpit                                                                                                                                                                                                        |

## 9. Progress on the conditions (updated 2026-09-21, after the push)

| Item                                                      | Status                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial commit (Architect condition 1, closes **G8**)     | **Done.** `b6e2de2`, author `ABH36 <aabhishekjain53@gmail.com>`, 128 files. `index.html` (empty, Owner's file) removed at the Owner's request and not committed                                                        |
| Repository                                                | `https://github.com/ABH36/FreelanCenter`. It was created **public**; I asked before pushing and, on the Owner's answer, set it to **private** first, then pushed `main`                                                |
| GitHub Actions (auditor blocker 2, closes half of **G6**) | **Green.** Run `35583615163` on `b6e2de2`: 3 jobs, every step success on Ubuntu runners (format, `sync-plan:check`, lint, typecheck, test, traceability drift check, build; gitleaks; `pnpm audit --audit-level high`) |
| Preview deployments (auditor blocker 3, other half of G6) | **Open.** Needs the Vercel team                                                                                                                                                                                        |
| Spike B on Supabase (blocker 1 / Task 0(a))               | **Open.** Needs the Supabase project. **No Prisma models until it passes**                                                                                                                                             |
| Structured redacting logger (Architect condition 3)       | Open (early Phase 1)                                                                                                                                                                                                   |
| Pin GitHub Actions to commit SHAs (SEC-13)                | Open (the repository exists now; do it early in Phase 1, task 10)                                                                                                                                                      |

**Found while pushing:** the generated `docs/traceability.md` embedded today's date, so CI's drift check (`git diff --exit-code`) would have failed on any other day. The generator now derives its label from the SRS version and two consecutive runs are byte-identical. The first real CI run passed with this fix.

A Dependabot run also started automatically because `.github/dependabot.yml` exists; it may open dependency-update pull requests in the private repository.

## 8. Dry run of the initial commit (before it was made)

`git add -n .` lists **128 files** (packages 34, spikes 27, docs 26, apps 16, `.github` 3, scripts 2, plus root config). No `.env*`, keys, `node_modules`, `.next`, generated Prisma client, temp files or the third-party sample photo would be included; the largest files are `pnpm-lock.yaml` (138 KB), `SRS.md` and its mirror (100 KB each). No remote is configured yet.
