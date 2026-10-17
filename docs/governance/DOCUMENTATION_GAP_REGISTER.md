# Documentation and Evidence Gap Register

## Operating rule

This register distinguishes a missing document from a missing real-world proof. A document can define a control; only execution/tests/vendor evidence can prove it. No gap is silently assumed closed.

## Phase-1 release blockers

| ID    | Gap                                         | Why it matters                                                                                                                                                                         | Closure evidence                                                                                               | Owner / timing                                                     |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| DG-01 | Live Supabase `ap-south-1` pooler/RLS proof | **Closed 2026-10-16.** Core `pg` suite passed 3× pooled/1× direct; Prisma 7 adapter extension + interactive transaction passed live; final cleanup verified                            | Evidence: `docs/spikes/SPIKE_B_RLS_POOLING.md`; rerun after relevant Prisma/pooler/RLS changes                 | Product Prisma schema is permitted                                 |
| DG-02 | Vercel team and preview deployment proof    | **Closed 2026-10-17.** Separate protected GitHub PR previews, distinct Preview-scoped configuration, health checks and Owner-authorized protected generic-alias rollback/redeploy pass | Evidence: `docs/reports/PHASE_1_DG02_VERCEL_PREVIEW.md`; repeat after Vercel project/deployment-policy changes | P1 preview gate passed; DG-11 still blocks Phase 7A custom domains |
| DG-03 | Redacting structured logger                 | Health endpoint is not audit-quality observability                                                                                                                                     | Secrets/PII redaction tests and correlation IDs in app/job logs                                                | P1 early                                                           |
| DG-04 | CI action SHA pinning                       | Tags can change upstream and violate supply-chain baseline                                                                                                                             | All third-party GitHub actions pinned to immutable SHAs; update policy documented                              | P1 early                                                           |

## Vendor and decision gaps

| ID    | Decision/proof                     | Current state                                                           | Required closure                                                                                            | Blocks                                         |
| ----- | ---------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| DG-05 | Authentication (ADR-006)           | Proposed, unverified                                                    | Better Auth proof: email verify, OAuth, TOTP, rotation and RLS-compatible persistence; ADR accepted/revised | P1 auth                                        |
| DG-06 | Durable jobs (ADR-007)             | Proposed, unverified                                                    | Real retry/idempotency/DLQ proof with chosen provider                                                       | First job-dependent feature                    |
| DG-07 | AI live behavior (ADR-008)         | Offline SDK proof only                                                  | Live model latency/cost/schema/repair/injection eval evidence                                               | P4                                             |
| DG-08 | Storage/image path (ADR-009)       | Cost model only                                                         | Vendor integration, upload security and lifecycle proof                                                     | P3 assets                                      |
| DG-09 | Payment/payout provider (ADR-011)  | Decision pending                                                        | Sandbox subscription/webhook/payout/KYC/legal feasibility proof and approved ADR                            | P6                                             |
| DG-10 | Email/WhatsApp provider (ADR-012)  | Decision pending                                                        | Deliverability, webhook and opt-out/retry proof                                                             | P5 notifications                               |
| DG-11 | Domains (ADR-005)                  | Planning accepted, live Spike A absent; purchase intentionally deferred | Before P7A, acquire two owned registrable domains and run real hostname/DNS/SSL/limit/failure test          | P7A                                            |
| DG-12 | Legal/privacy/commercial decisions | Counsel/Owner input pending                                             | DPA/ToS/privacy/retention/tax/licence approval                                                              | beta/launch; specific billing/marketplace work |

## Implementation-detail gaps intentionally deferred

These must be designed in the module file immediately before implementation, not fabricated during Phase 0: final Prisma schema/migrations; endpoint/OpenAPI/tRPC contract; provider adapter payloads; environment/IaC config; alert thresholds/SLO ownership; test fixture/seed data; UI interaction specifications. Each is closed through code, tests and phase evidence under the corresponding module’s acceptance criteria.

## Documentation hygiene gaps

| ID    | Gap                                                                                                        | Action                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| DG-13 | README still says a GitHub repository is awaited, but the Phase-0 audit records it as created and CI green | Corrected in this documentation update; retain Supabase/Vercel blockers.                                                     |
| DG-14 | `docs/enterprise-enhancements/` can mislead agents with unsupported “existing” claims                      | Classified as non-authoritative in AGENTS.md and documentation index; retain pending Owner-approved archive/delete decision. |
| DG-15 | Phase reports were historical rather than operational reading guidance                                     | Documentation index now defines when reports are required.                                                                   |

## Closure protocol

To close a row, link the evidence (test output, provider sandbox record, CI run, ADR, screenshot or audit report), update this register and the target module’s status, then include it in the phase report. A text assertion or a successful local UI demo alone does not close a gap.
