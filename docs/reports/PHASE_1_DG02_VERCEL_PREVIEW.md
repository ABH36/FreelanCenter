# Phase 1 — DG-02 Vercel Preview Evidence

**Status:** Verified on 2026-10-17. Separate protected GitHub pull-request previews, scoped preview-environment separation and controlled rollback/redeploy evidence are complete.

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

## Controlled rollback/redeploy evidence — 2026-10-17

The Vercel CLI rollback mechanism changes a project's generic production alias rather than a preview URL. With explicit Owner authorization, it was exercised only against the empty, Vercel-Authentication-protected `sites` project alias; no custom domain, customer, credential or sensitive data was involved.

| Step                       | Evidence                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled redeploy        | `dpl_5d8M78Pm66LEayr1qcwTccg9PTjv` — READY; protected generic alias health returned `{"status":"ok","app":"sites","deploymentSurface":"local"}` |
| Rollback target            | `dpl_EWMi8oyhjDJLVEKd3WGAtKu8Zh5k` / `https://sites-qn43xfflo-abhishek-jains-projects-2974d5c7.vercel.app`                                      |
| Vercel result              | `Success! sites was rolled back` to the exact target deployment                                                                                 |
| Post-rollback verification | Generic protected alias health returned `{"status":"ok","app":"sites"}`; inspect showed aliases restored to the target deployment               |

This proves the project-level redeploy and rollback operation only. It does not replace the Phase 7A custom-domain rollback, cookie-isolation or DNS/SSL evidence.

**Verdict:** DG-02 is closed. The approved no-cost preview policy remains authoritative in [DEVELOPMENT_ENVIRONMENT_POLICY.md](../governance/DEVELOPMENT_ENVIRONMENT_POLICY.md); production domain proof is still deferred to DG-11 / Phase 7A.
