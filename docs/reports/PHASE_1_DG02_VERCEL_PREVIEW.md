# Phase 1 — DG-02 Vercel Preview Evidence

**Status:** In progress. CLI preview deployment, project separation and protected health checks are verified; the GitHub pull-request preview and explicit preview-environment separation remain open.

**Recorded:** 2026-10-16 · **Scope:** DG-02 only. This is not production-domain evidence and does not close DG-11.

## Verified evidence

| Check                              | Dashboard                                                                          | Sites                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Vercel project                     | `dashboard` / `prj_5CJSnJdEZiG4GQ58GRtEDhLorO2N`                                   | `sites` / `prj_qu1fi3Z9SlbgQrz6RnqAWWRklj4U`                   |
| Repository root directory          | `apps/dashboard`                                                                   | `apps/sites`                                                   |
| CLI preview deployment             | `dpl_6db8rmzhtgoiHw4z1mLGArbkZuhv` — READY                                         | `dpl_52PYSgKLPXpx2sjCdwiJQuJdm9Dj` — READY                     |
| Authenticated preview health check | `{"status":"ok","app":"dashboard"}`                                                | `{"status":"ok","app":"sites"}`                                |
| Preview access policy              | Vercel Authentication protection enabled                                           | Vercel Authentication protection enabled                       |
| Redeploy evidence                  | Initial preview build completed after correcting the monorepo project-root setting | Forced second deployment produced an independent READY preview |

Both projects are connected to `ABH36/FreelanCenter`. The verified builds installed the root `pnpm` workspace and each built only its own application through Turbo. The Vercel CLI generated temporary deployment-protection bypass tokens for the authenticated health checks; no token value was recorded in this repository.

## Non-production boundary

No custom domain, wildcard routing, real customer data, payment provider, production OAuth callback or public access policy was configured. The sites project's first-ever deployment received Vercel's generic project-production alias automatically; it remained Vercel-Authentication protected and is not evidence of a production launch. The subsequent verified `sites` deployment above is a normal preview (`target: null`).

## Remaining closure actions

1. Open a harmless GitHub pull request and confirm Vercel creates a preview for **both** separate projects. Record the two PR URLs and deployment IDs here. Do not merge solely for this proof.
2. Configure and verify distinct Preview-environment origin/config values once the app consumes them. Values must be scoped per Vercel project and may not use a shared `.vercel.app` cookie domain. Record only variable names and environment scopes—not values or secrets.
3. Demonstrate a safe rollback/redeploy using preview-only deployments (no production alias change), then append deployment IDs and result here.

Until those items are evidenced, DG-02 remains open. The approved no-cost preview policy remains authoritative in [DEVELOPMENT_ENVIRONMENT_POLICY.md](../governance/DEVELOPMENT_ENVIRONMENT_POLICY.md).
