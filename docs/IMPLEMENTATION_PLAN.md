# Implementation Plan (the builder's detailed plan)

**Author:** Claude (Builder) · **Date:** 2026-09-21 · **Based on:** SRS v1.2.1 · **Status: reviewed at the Phase 0 gate - the Architect approved Q4, Q5, Q12 (P3A/P3B split), Q15 and Phase 1 Task 0; see `docs/reports/PHASE_0_AUDIT.md`. SRS v1.2.1 is frozen**

> **What this file is.** `SRS.md` is the approved plan and the single source of truth; `DEVELOPMENT_PLAN.md` is a byte-identical mirror of it (SRS section 0.3). **This** file is the builder's detailed implementation plan that the SRS requires as a Phase 0 deliverable (SRS Appendix A, step 1). It is new and **has not been audited**: review it at the Phase 0 gate together with the Phase 0 report. Earlier the approval message named `DEVELOPMENT_PLAN.md`; the Owner clarified the Architect meant `SRS.md`.

---

## 1. My understanding of the system (in my own words)

**What it is.** A multi-tenant SaaS where a _freelancer or agency_ (the paying customer) delivers websites to many small local businesses (_clients_). The freelancer picks a category template, shows it to the prospect, customises it by structured editing and prompt-based AI, collects the client's data through a magic-link wizard, previews on staging, gets the client's approval, and publishes to a platform subdomain or a custom domain. The client gets leads by email/WhatsApp. Freelancers without clients can build and sell templates. Agencies can white-label the portal.

**The load-bearing ideas**

1. **A site is data, not code.** One shared renderer turns a validated `SiteConfig` JSON into a page. There is no per-site build. Publishing = creating an **immutable `SiteVersion`** and moving a pointer; rollback = moving it back. (C4)
2. **Tenant isolation is a database property.** Every tenant table carries `workspace_id`; Postgres RLS (forced, fail-closed, no bypass roles) decides visibility; an automated suite proves it. Visitors reach data only through narrow `SECURITY DEFINER` functions. (5.3, Spike B)
3. **Two trust domains.** Dashboard and tenant sites are different apps on different registrable domains; no shared cookies. (ADR-002)
4. **The AI proposes, code disposes.** The model returns a typed patch from a closed set of operations; deterministic code validates on a copy; a human accepts. Invalid output never persists. Credits are a reserve→commit ledger. (8, Spike C offline)
5. **Templates are declarative in v1.** Creators compose platform blocks; no creator code runs. Export rights follow the licence (D13-A). (ADR-004)
6. **Everything external sits behind an interface** (`DomainProvider`, `PaymentProvider`, `EmailProvider`, `StorageProvider`, `WhatsAppProvider`) so the vendor choices, several still unverified, can change.

**What is _not_ being built in v1:** e-commerce, freelancer→client invoicing, custom-code templates, native apps, real-time co-editing, domain registration.

**Where I might be wrong (please challenge):** I read "Client" as a _third kind of principal_ that has no workspace membership (Q5); I read FR-WS-05 (workspace deletion) as a P8 deliverable with a P1 design hook (Q4); I read the P3 scope as too large for one audit (Q12).

---

## 2. Phase 0 outcome (done, reported separately)

Toolchain and both apps scaffolded and verified; 13 ADRs; spikes B (executed), C (offline half executed), E (measured + modelled), A and D (desk research only); threat model; data classification; privacy inventory; this plan; generated traceability matrix (170 requirements). Details and honest gaps: `docs/reports/PHASE_0_REPORT.md`.

## 3. Requirement traceability

`docs/traceability.md` is **generated from the SRS** (`pnpm traceability`) and fails if any FR/NFR/SEC id lacks a phase. 170 requirements: P0 5 · P1 28 · P2 20 · P3 20 · P4 15 · P5 17 · P6 21 · P7A 16 · P7B 10 · P8 13 · Backlog 4 · Removed 1.

## 4. Cross-cutting engineering plan

| Topic              | Plan                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Environments       | local (Docker Postgres+PgBouncer from Spike B, Mailpit, Redis), preview per PR (Vercel), staging, production. Region `bom1` + Supabase `ap-south-1`.                                                   |
| Migrations         | SQL-first for roles/RLS/functions, Prisma models for tables; forward-only; each RLS change ships with an isolation test; migration role `migrator` (INHERIT FALSE).                                    |
| Data access        | `packages/db` exposes only `withWorkspace(id, fn)` (request-scoped transaction), an admin/system path, and public functions. No raw client export. Lint bans importing the generated client elsewhere. |
| API style          | Next Server Actions + route handlers, Zod on every input, one `authorize(actor, action, resource)` gate. (I do **not** plan tRPC to avoid another moving part; see Q14.)                               |
| Testing            | Vitest (unit/integration against real Postgres), isolation suite (merge gate), Playwright E2E per phase acceptance scenario, Lighthouse CI (P2+), k6 (P4, P8), axe.                                    |
| CI gates           | format, lint, typecheck, unit, integration + isolation (Postgres service container), build; gitleaks + dependency audit.                                                                               |
| Feature flags      | table-driven, server-evaluated; unfinished features ship dark.                                                                                                                                         |
| Observability      | structured logger with redaction and correlation ids (P1), Sentry/OTel wiring when accounts exist.                                                                                                     |
| Definition of done | SRS 11.3.                                                                                                                                                                                              |

## 5. Phase plans

Format required by the SRS kickoff prompt (Appendix A, step 1, item 3): for every phase, **tasks, dependencies, data-model changes, APIs, test plan, risks, and how the acceptance criteria will be proven.**

**Estimates.** Sizes are the SRS's relative sizes (S/M/L/XL) plus a confidence level. I am deliberately **not** giving calendar dates: there is no velocity data yet, and the biggest uncertainties are outside the code (vendor lead times, template design capacity, accounts). This is a departure from the SRS wording "estimates" and is listed as a gap in the Phase 0 report.

### Phase 0 - Foundations, Decisions & Spikes (M) - **done, under audit**

See `docs/reports/PHASE_0_REPORT.md`. Not repeated here.

### Phase 1 - Multi-Tenant Core (L; confidence medium - depends on Task 0)

- **Tasks.** _Task 0 (blocking):_ (a) re-run the Spike B suite against Supabase `ap-south-1` via its pooler(s) (ADR-003); (b) thin proofs for Better Auth (sign-up, verify, login, TOTP) and Inngest (one function with retry); (c) decide the Client-vs-RLS design (Q5). Then: 1 `packages/db` (Prisma models, SQL for roles, `current_workspace()`, RLS, definer functions, `withWorkspace`, transaction options, seed, local compose). 2 Isolation suite with automatic table discovery. 3 Auth flows, rate limiting, invitations. 4 Workspace/Membership and the RBAC matrix module. 5 Projects CRUD, lifecycle state machine, audit log, basic notifications. 6 Sites app host resolution (Next 16 `proxy.ts`), Redis cache + negative cache, `resolve_host`. 7 Dashboard shell + audit viewer. 8 Admin console v0. 9 Structured logger with redaction (FR-OBS-01). 10 CI with a Postgres service, environments as code.
- **Dependencies.** Owner accounts: GitHub, Supabase (`ap-south-1`), Upstash (Mumbai), Vercel (`bom1`), the two domains (D1), email provider or Mailpit. Spike B design (done).
- **Data model.** `User`, auth tables (per library), `Workspace`, `Membership`, `Invitation`, `Project`, `ClientContact`, `Domain` (platform subdomain), `AuditLog`, `Notification`; roles `migrator`/`app_user`/`app_public`/`svc_definer`; `current_workspace()`; definer functions `resolve_host`, later `get_published_version`, `insert_lead`.
- **APIs.** Server Actions: sign up/in/out, verify email, reset password, enrol/verify TOTP, create workspace, invite/accept, create project, transition project. Route handlers: `/api/health`, auth callbacks. Internal: `withWorkspace(id, fn)`, `authorize(actor, action, resource)`. Sites: host → project resolution in `proxy.ts`.
- **Test plan.** Cross-tenant isolation suite (merge gate); permission-matrix table test; IDOR test per resource; auth abuse tests (lockout, enumeration); Postgres+PgBouncer service container in CI; E2E: sign up → workspace → project → subdomain → second tenant cannot see it through UI, API or `app_user` SQL.
- **Risks.** Supabase pooler differs from tested PgBouncer (R18); auth/job vendors unverified (R19); Prisma burst behaviour (Spike B B-3).
- **Acceptance proof.** SRS Phase 1 checkpoint; the isolation-suite output for every table; the anti-pattern test still detecting a session-level `SET`.

### Phase 2 - Template Engine & Renderer (XL; confidence medium - design quality is external)

- **Tasks.** 1 `packages/schema` (SiteConfig, Template, block prop schemas, JSON Schema export, migration framework; strict Zod 4; size/count bounds). 2 `packages/blocks` (blocks, variants, motion presets, registry with editor metadata, error boundaries). 3 Theme-variable system on `packages/ui` tokens; Devanagari-capable font allow-list with subsetting (Q19). 4 `SiteRenderer` in `apps/sites` (SSR, meta, canonical, OG, category JSON-LD, sitemap, robots). 5 Three reference templates with onboarding manifests, plus seed. 6 Preview/Pitch mode (signed expiring link, demo data, noindex). 7 Fuzz/property tests, visual regression, Lighthouse CI budgets.
- **Dependencies.** Phase 1 (DB, sites app routing). Owner design review; capacity to design 10+ templates by launch (Q17).
- **Data model.** `Template`, `TemplateVersion` (built-ins owned by a platform workspace); `SiteConfig` document v1.0.
- **APIs.** Sites: `/`, `/[...path]`, `/sitemap.xml`, `/robots.txt`, `/preview/[templateId]?token=`. Internal: `parseSiteConfig`, `migrateConfig`, block registry API (`getBlock(type, variant)`).
- **Test plan.** Property tests (any valid config renders; invalid never crashes); XSS corpus; schema-migration tests; visual regression; Lighthouse CI (Perf >= 90, A11y >= 95, SEO >= 95, BP >= 95 on mobile); axe.
- **Risks.** Block set is the quality ceiling of declarative templates (ADR-004); Devanagari font weight vs performance budget.
- **Acceptance proof.** A config loaded from the DB renders a styled, accessible page with no per-site build; three templates meet NFR-PERF-03; a new block is added without touching the renderer core.

### Phase 3 - Builder, Versioning, Staging & Publish (XL) - proposed split **P3A / P3B** (Q12; confidence medium-low)

- **Tasks.** _P3A Builder & assets:_ schema-driven forms from block metadata; live preview iframe (draft mode via signed token, Q10); theme editor; section management; autosave with optimistic concurrency; undo/redo; edit lock; R2 uploads (signed, sniffed, re-encoded, variants per ADR-009); asset library. _P3B Versions & review:_ `SiteDraft`/`SiteVersion`/`SiteDeployment`; publish to staging/live; history, diff, rollback; immutability by trigger + no UPDATE grants (Q7); preflight engine v1; staging protection; Review Mode (comments, approve); abuse report link + admin queue + Safe-Browsing hook; **edge WAF/rate-limit baseline (SEC-19)**.
- **Dependencies.** Phase 2 renderer and schema. Owner: Cloudflare zone + R2 bucket (asset domain).
- **Data model.** `SiteDraft`, `SiteVersion` (immutable), `SiteDeployment` (pointer history), `Asset`, `ReviewComment`, `AbuseReport`.
- **APIs.** Server Actions: `saveDraft(revision)`, `publish(env)`, `rollback(versionId)`, `listVersions`, `diffVersions`, `addComment`, `approveVersion`. Route handlers: signed upload URL, preview/staging token mint + exchange. Job: asset processing.
- **Test plan.** Concurrency (two editors); immutability (UPDATE/DELETE on `SiteVersion` fails); cache-invalidation after publish and rollback; malicious-upload corpus; preview isolation (framing/CSP); preflight rule coverage; usability run (time-to-first-publish <= 15 min).
- **Risks.** Scope size; preview iframe vs no-shared-cookies (Q10); image pipeline CPU cost (AVIF).
- **Acceptance proof.** SRS P3 checkpoint: template → customise → staging → client comment/approve → live → rollback, previous versions still immutable.

### Phase 4 - AI Automation (XL; confidence low until Spike C live is done)

- **Tasks.** 1 `packages/ai` from the Spike C harness (real block registry, registry-derived op schemas, model registry table). 2 Credit ledger (reserve/commit/refund, idempotency, nightly reconcile). 3 Upstash token buckets, workspace concurrency, global queue/backoff/circuit breaker, weighted fair queue. 4 UI: prompt panel, diff preview, accept/reject, undo. 5 Niche copy generation (EN/HI/Hinglish). 6 Autopilot SEO on `site.published`, logo colour extraction (deterministic first), AI preflight audit. 7 Admin AI cost/margin dashboard; eval harness with golden sets in CI.
- **Dependencies.** Phase 3 (SiteDraft/ChangeSet apply path). Owner: Anthropic API key and current pricing; Sentry/OTel accounts.
- **Data model.** `AiCreditLedger`, `AiJob`, model-registry table, plan credit grants, `ChangeSet` (source = ai).
- **APIs.** Server Actions: `proposePatch`, `acceptChangeSet`, `undoChangeSet`, `getUsage`. Jobs: `site.published` fan-out, `asset.uploaded`. Internal: `runPromptToPatch` with injected model.
- **Test plan.** Offline suite (already 24 tests in Spike C); live eval suite with golden prompts per category (>= 30/category by launch; EN/HI/Hinglish/adversarial); ledger race/idempotency tests; 50-user load test; prompt-injection tests.
- **Risks.** Real-model validity/cost unknown (R3/R4); Anthropic limits (R5); credit weighting (Q22).
- **Acceptance proof.** SRS P4 checkpoint with **measured** valid-after-repair >= 99%, no ledger overspend under load, correct 429s, failed generations refunded.

### Phase 5 - Client Operations (XL; confidence low - vendor lead times)

- **Tasks.** Magic-link onboarding wizard from manifests (EN/HI); ChangeSet proposal/accept; client portal (design per Q5); public lead API with Turnstile, honeypot and limits; inbox/CRM-light; email and WhatsApp/SMS adapters; click tracking; analytics v1; AI triage + draft replies; pgvector chatbot with caps.
- **Dependencies.** Phase 4 (ledger, model router). Owner: WhatsApp Business verification/templates, India SMS DLT registration (ADR-012), Turnstile, Inngest.
- **Data model.** `OnboardingRequest`, `ChangeSet` (source = client), `Lead`, `LeadEvent`, `EmbeddingChunk`, notification preferences.
- **APIs.** `/onboard/[token]`, `POST /api/public/leads`, `POST /api/public/chat`, portal routes; `WhatsAppProvider`/`EmailProvider` adapters; definer function `insert_lead`.
- **Test plan.** Token security (entropy, hashing, expiry, revocation); upload pipeline; public-endpoint abuse tests; notification retry/dead-letter; isolation suite extended to new tables; chatbot grounding and injection tests with a real model.
- **Risks.** WhatsApp/DLT approvals; spam/abuse; chatbot cost.
- **Acceptance proof.** SRS P5 checkpoint: onboarding on a phone → ChangeSet → preview; lead → owner notified < 30 s; chatbot answers only from site data.

### Phase 6 - Marketplace & Billing (XL; confidence low - payments unverified)

- **Tasks.** Entitlements engine; Razorpay subscriptions and Route per ADR-011 (after Spike D items 1-3); marketplace browse/detail/preview; licences (free/paid/exportable, D13-A); creator onboarding + Template Studio; vetting pipeline; review queue; versions + opt-in upgrade; revenue-share ledger with 14-day hold; usage metering.
- **Dependencies.** Phases 2-4. Owner: Razorpay account and Route activation, legal entity/GST, ratification of ADR-011 and the exportable-licence price multiple (Q16).
- **Data model.** `Plan`, `Entitlement`, `Subscription`, `Order`, `CreatorAccount`, `TemplateLicense`, `WebhookEvent`, ratings, payout ledger.
- **APIs.** Marketplace routes; checkout; `POST /api/webhooks/razorpay` (signature + timestamp + idempotency); template submission; admin review queue; `PaymentProvider` interface.
- **Test plan.** Webhook replay/idempotency; ledger reconciliation with provider test mode incl. refunds; licence-bypass tests; vetting fixtures (malicious, plagiarised); entitlement enforcement server-side.
- **Risks.** Payment/payout complexity (R9); marketplace cold start (R6); malicious templates (R7).
- **Acceptance proof.** SRS P6 checkpoint: creator submits → vetting → approval → purchase → project created → earnings shown; downgrade rules exercised.

### Phase 7A - Custom Domains & White-Label (L; confidence low until Spike A is executed)

- **Tasks.** `DomainProvider` (Vercel Domains API per ADR-005) with a throttled domain-add queue; TXT ownership verification; DNS pre-check; certificate status machine; apex/www policy; Domain Connect; `BrandProfile`; portal domain; branded emails and sending domain; credential vault with rotation.
- **Dependencies.** Spike A executed; Vercel Pro team and test domains; Phase 5 portal.
- **Data model.** `Domain` (custom/portal), `BrandProfile`, `Integration` (SMTP) with encrypted credentials + `key_version`.
- **APIs.** `addDomain`, `verifyDomain`, `removeDomain`; `DomainProvider` methods; DNS-check and certificate-poll jobs; host → branding resolution.
- **Test plan.** Wrong-DNS test (no repeated issuance); ownership-takeover test; dangling-DNS cleanup; cache invalidation; credential rotation test; white-label leak audit.
- **Risks.** Vendor lock-in (R12); issuance/rate limits (R2).
- **Acceptance proof.** SRS P7 checkpoint (domain part): real domain verified, SSL active, serving a white-labelled site and portal.

### Phase 7B - Integrations & Export (L; confidence medium)

- **Tasks.** GitHub App and Vercel integration (least-privilege); export pipeline (Next.js project + static HTML); asynchronous smoke-build before download; licence manifest; push to GitHub; deploy to Vercel; content export (FR-EXP-06).
- **Dependencies.** Phase 6 licences; GitHub App and Vercel integration registered by the Owner.
- **Data model.** `Integration` (github/vercel), `ExportJob`.
- **APIs.** `requestExport`, `downloadExport`, `pushToGitHub`, `deployToVercel`; GitHub/Vercel webhooks (signed).
- **Test plan.** Export builds and matches the original visually; licence gating (paid non-exportable refused on every path); no cross-tenant data or secrets in artefacts; token-scope review.
- **Risks.** IP leakage (R16); export drift from the renderer.
- **Acceptance proof.** SRS P7 checkpoint (export part): eligible project exports, builds and deploys identically; non-exportable project refused everywhere while content export still works.

### Phase 8 - Hardening & Launch (L; confidence medium)

- **Tasks.** Full admin console; consent-based impersonation; load/soak/noisy-neighbour tests; DR restore drill; external pen test + remediation; compliance pack (DPA chain, `retention.sweep` verified end to end); runbooks; status page; private beta.
- **Dependencies.** All prior phases; Owner: penetration tester, counsel.
- **Data model.** `FeatureFlag`, impersonation session, retention metadata.
- **APIs.** Admin routes; feature-flag evaluation; `retention.sweep` job.
- **Test plan.** k6 load tests against NFR-SCALE-01; restore drill; chaos on jobs/providers; DAST baseline; dependency/SBOM report.
- **Risks.** Findings from the pen test; beta feedback (R10 scope creep).
- **Acceptance proof.** All NFR targets evidenced; zero open S1/S2; beta cohort completes the journey unaided.

## 6. Ambiguities, contradictions and proposed resolutions

| #   | Issue                                                                                           | Proposed resolution                                                                                                                                                                                                                  | Where decided           |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Q1  | SRS 5.3 policy expression errors on pooled connections                                          | Fixed in SRS v1.2 (NULLIF)                                                                                                                                                                                                           | Done                    |
| Q2  | "Neon or Supabase" contradicts D14 (Neon has no Mumbai)                                         | Supabase (ADR-003)                                                                                                                                                                                                                   | Done                    |
| Q3  | `generateObject` deprecated in AI SDK v7                                                        | `generateText` + `Output.object`, `instructions`                                                                                                                                                                                     | Done                    |
| Q4  | FR-WS-05 sits under a P1 heading but needs retention/purge machinery                            | P1 adds `deleted_at`/`scheduled_purge_at` columns and audit hooks; feature delivered in P8 (traceability shows P8)                                                                                                                   | Owner/Architect confirm |
| Q5  | A **Client** has no workspace membership, so workspace-keyed RLS does not fit                   | Onboarding writes go through `SECURITY DEFINER` functions that create _proposed_ ChangeSets only. Portal reads use extra transaction-local GUCs (`app.actor_kind`, `app.project_id`) with policies on Lead/SiteVersion/ReviewComment | P1 Task 0(c), built P5  |
| Q6  | Which DB role serves the sites app read path                                                    | `app_public` + `get_published_version(site_id)` definer function returning the immutable JSON, cached by version id                                                                                                                  | P1                      |
| Q7  | How is `SiteVersion` immutability enforced                                                      | trigger raising on UPDATE/DELETE + no UPDATE grant; only `SiteDeployment` pointer moves                                                                                                                                              | P3B                     |
| Q8  | `AuditLog` append-only vs erasure rights                                                        | never deleted; PII columns anonymised by a definer function; `REVOKE UPDATE, DELETE` from `app_user`                                                                                                                                 | P1                      |
| Q9  | Global namespace for platform subdomains (FR-WS-03)                                             | `Domain.hostname` unique; `<project-slug>` if free else `<slug>-<4 random>`; reserved-word list; workspace slug is dashboard-only                                                                                                    | P1                      |
| Q10 | Draft-preview iframe and staging access with **no shared cookies**                              | dashboard mints a 5-minute signed token; sites app exchanges it for a cookie scoped to that host only; `frame-ancestors` allows the dashboard origin in draft mode only                                                              | P3A                     |
| Q11 | Vercel allows 100 domain additions/hour/team                                                    | throttled durable queue, visible `Queued` state (added to SRS)                                                                                                                                                                       | P7A                     |
| Q12 | P3 is too large for one audit                                                                   | formally split P3A/P3B like P7 (Architect to confirm)                                                                                                                                                                                | Now                     |
| Q13 | Better Auth and Inngest are unverified                                                          | thin proofs in Phase 1 Task 0; fall back per ADR                                                                                                                                                                                     | P1                      |
| Q14 | SRS mentions "tRPC/Server Actions"                                                              | Server Actions + route handlers only                                                                                                                                                                                                 | P1                      |
| Q15 | Editor "policy" for publishing live (SRS 7)                                                     | workspace setting; **default: Editor may publish to staging only**                                                                                                                                                                   | P3B                     |
| Q16 | Exportable-licence price multiple (D13)                                                         | Owner decides in P6                                                                                                                                                                                                                  | P6                      |
| Q17 | FR-TPL-10 needs >= 10 designed templates                                                        | design capacity is an external dependency; Claude builds them as data, Owner reviews quality                                                                                                                                         | P2 onward               |
| Q18 | NFR-SCALE-02 (25,000 sites) vs total unit economics                                             | extend the image cost model to full per-site model (hosting + AI + email + storage)                                                                                                                                                  | P4 (NFR-COST-01)        |
| Q19 | Devanagari fonts vs performance budget                                                          | Devanagari-capable allow-list, subsetting, `font-display` policy, measured in Lighthouse CI                                                                                                                                          | P2                      |
| Q20 | Phase 0 items "CI green" and "preview deployments" cannot be demonstrated without GitHub/Vercel | workflow files written and the same commands run locally; real CI/preview at the first push                                                                                                                                          | Owner supplies repo     |
| Q21 | Observability baseline listed in P0                                                             | only health endpoints in P0; logger/redaction in P1 (FR-OBS-01 mapped P1); Sentry/OTel when accounts exist                                                                                                                           | Reported as deviation   |
| Q22 | AI credit weights                                                                               | derive from live pricing after Spike C live run                                                                                                                                                                                      | P4                      |

## 7. External dependencies (accounts and lead times)

| Needed by                 | Item                                                                                                                                  | Owner action      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Now (parallel, long lead) | WhatsApp Business verification; India SMS DLT registration; Razorpay account + Route activation; legal entity/GST                     | start immediately |
| P1                        | GitHub repo; Supabase project (`ap-south-1`); Upstash (Mumbai); Vercel team (`bom1`); the two domains (D1); email provider or Mailpit | provide           |
| P3                        | Cloudflare zone for asset domain + R2 bucket                                                                                          | provide           |
| P4                        | Anthropic API key + `pricing.local.json`; Sentry/OTel accounts                                                                        | provide           |
| P7A/B                     | test domains; GitHub App and Vercel integration registration                                                                          | provide           |
| P8                        | penetration tester; counsel                                                                                                           | engage            |

## 8. What I need from the auditors at this gate

1. Confirm or reject the P3A/P3B split (Q12).
2. Confirm Q4, Q5, Q15 resolutions.
3. Confirm Phase 1 Task 0 is a hard blocker before any product schema.
4. Rule on the Phase 0 deviations listed in the report (observability baseline, CI/preview not executed, spikes A/D not executed, C live half outstanding).
