# Owner Input and Real-World Evidence Checklist

## How to provide sensitive information

Never paste passwords, database URLs, API keys, private keys or access tokens into chat or committed files. Put secrets in the documented git-ignored local environment file, grant least-privilege account access, then provide only the non-secret confirmation requested below.

## Required now: Phase-1 gate

| Item          | What the Owner provides                                    | Safe handoff                                                                                                         | Evidence this enables                                                                   |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Supabase      | Scratch project in `ap-south-1` and Postgres major version | Put pooled `DATABASE_URL` and direct `DIRECT_URL` in `.env.local`; tell us project is ready and the Postgres version | DG-01: live pooled RLS negative-leak proof; prerequisite for all P1 product schema/code |
| Vercel        | Team access in `bom1`                                      | Run `vercel login` on the machine or place a token in `.env.local`; provide team slug                                | DG-02: preview deployment/environment proof                                             |
| Auth decision | Confirm Better Auth working assumption or choose Clerk     | Written decision; ADR-006 will be accepted/revised after proof                                                       | DG-05: P1 auth proof                                                                    |

## Needed soon, but not a Phase-1 blocker

| Area             | Owner input                                                      | Needed by                                              | Closure                                   |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Jobs             | Inngest account/project, or approved alternative                 | First durable job                                      | DG-06 retry/idempotency/DLQ proof         |
| Redis            | Upstash account/region decision                                  | Rate-limited auth or AI paths                          | Rate-limit/provider integration proof     |
| Storage          | Cloudflare R2 account/asset-domain decision                      | P3 assets                                              | DG-08 upload/lifecycle/security proof     |
| AI               | Anthropic API key and approved spending cap                      | P4                                                     | DG-07 live cost/quality/safety evaluation |
| Email/WhatsApp   | Email provider and sending domain; WhatsApp provider if desired  | P5                                                     | DG-10 delivery/retry/opt-out proof        |
| Product identity | Product name plus two registrable domains; registrar/DNS control | Before P7A begins, not required for P1–P6 preview work | ADR-002/005 production-host proof         |

## Needed for commercial phases

| Area              | Owner input                                                                                              | Needed by | Closure                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------- |
| Payments          | India-first/International provider decision, sandbox accounts and business/KYC eligibility               | P6        | DG-09 subscription/webhook/payout proof             |
| Commercial policy | Plan limits/pricing direction, revenue share, refund window, paid-template exportable-licence multiplier | P6        | Billing/marketplace policy configuration            |
| Domain operations | Registrar/DNS ownership and domain-provider account access                                               | P7A       | DG-11 hostname/DNS/SSL proof                        |
| Integrations      | GitHub App ownership and Vercel OAuth app approval                                                       | P7B       | Least-privilege export/deployment integration proof |

## Required before beta/public launch

| Area          | Owner input / external evidence                                                                    | Closure                         |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| Legal/privacy | Entity, counsel review of ToS/privacy/DPA/DPDP roles, retention/tax and marketplace licence policy | DG-12                           |
| Security      | Independent penetration-test engagement and incident contacts                                      | SEC-18/security launch gate     |
| Reliability   | Backup/restore ownership, incident/on-call owner and provider production plans                     | DR/availability launch evidence |

## Rule for completion

Documentation is complete only when every item is either (a) evidenced and linked in the gap register, (b) formally deferred outside the release scope through an ADR, or (c) not applicable. A supplied account or key alone is not evidence; the documented proof/test must still run. The no-cost preview policy is documented in `DEVELOPMENT_ENVIRONMENT_POLICY.md`; it never replaces the production-domain evidence gate.
