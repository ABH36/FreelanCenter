# Phase 1 — DG-02 Vercel Preview Evidence

**Status:** In progress. Separate protected GitHub pull-request previews and scoped preview-environment separation are verified. Preview rollback evidence remains open.

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

## GitHub pull-request evidence — 2026-10-17

Pull request [#11](https://github.com/ABH36/FreelanCenter/pull/11) triggered both connected Vercel projects from the same commit, `b523e3b`:

| Check                            | Dashboard                                                                   | Sites                                                                 |
| -------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Git-triggered preview deployment | `dpl_418j5SJPNePKNKb5NpXHTTmf7Zst` — READY                                  | `dpl_9bJDKgGfTPZEeFJFpP8P7NzwCUMw` — READY                            |
| Preview URL                      | `https://dashboard-oy3l6sgi4-abhishek-jains-projects-2974d5c7.vercel.app`   | `https://sites-oukn4h1uh-abhishek-jains-projects-2974d5c7.vercel.app` |
| Protected health response        | `{"status":"ok","app":"dashboard","deploymentSurface":"dashboard-preview"}` | `{"status":"ok","app":"sites","deploymentSurface":"sites-preview"}`   |
| Preview config scope             | `PLATFORM_DEPLOYMENT_SURFACE`, Preview only, non-secret                     | `PLATFORM_DEPLOYMENT_SURFACE`, Preview only, non-secret               |

The two Preview-scoped environment values are intentionally distinct and are exposed only through the synthetic health response to prove project separation. No cookie domain, future product domain, credential, customer data or production-only value is used. PR #11's GitHub run passed format/lint/typecheck/test/build, dependency audit, gitleaks, and both Vercel checks.

## Non-production boundary

No custom domain, wildcard routing, real customer data, payment provider, production OAuth callback or public access policy was configured. The sites project's first-ever deployment received Vercel's generic project-production alias automatically; it remained Vercel-Authentication protected and is not evidence of a production launch. The subsequent verified `sites` deployment above is a normal preview (`target: null`).

## Remaining closure actions

1. Demonstrate a safe rollback/redeploy using preview-only deployments (no production alias change), then append deployment IDs and result here. The Vercel `rollback` command must not be run until its target/alias effect is confirmed because it can modify a project's production routing.

Until those items are evidenced, DG-02 remains open. The approved no-cost preview policy remains authoritative in [DEVELOPMENT_ENVIRONMENT_POLICY.md](../governance/DEVELOPMENT_ENVIRONMENT_POLICY.md).
