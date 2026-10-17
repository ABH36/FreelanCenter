# Development and Preview Environment Policy

## Purpose

Allow development and internal validation to proceed without buying custom domains, while preserving the production requirement for two separate registrable domains. This policy does not change ADR-002, ADR-005 or the SRS launch requirements.

## Approved no-cost environments

| Environment          | Dashboard                               | Sites renderer                                  | Permitted data/use                                                                      |
| -------------------- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Local                | `http://localhost:3000`                 | `http://localhost:3001`                         | Synthetic/seed data only; developer testing                                             |
| Pull-request preview | Dashboard Vercel preview URL            | Sites Vercel preview URL                        | Internal reviewers and synthetic/demo data only                                         |
| Staging before P7A   | Separate Vercel project deployment URLs | Separate Vercel project deployment URLs         | Controlled internal testing; no production customers, payments or sensitive client data |
| Production/beta      | `app.<dashboard-domain>`                | `*.<sites-domain>` plus verified custom domains | Only after ADR-002/005 domain prerequisites and Phase-7A evidence                       |

Preview URLs are acceptable for deployment, integration and functional verification. They are **not** proof that production has two separate registrable domains: Vercel preview hosts share the `vercel.app` registrable domain. Production cookie/XSS isolation must still be re-tested after the two owned domains are configured.

## Mandatory implementation rules

1. Keep `apps/dashboard` and `apps/sites` as separate Vercel projects from the first preview deployment.
2. Configure public origins through environment variables; never hard-code a future brand/domain in source. Use explicit local/preview/staging/production origin values.
3. Dashboard session cookies must be host-only and use secure production settings. Never set a `Domain=.vercel.app` cookie attribute.
4. Preview-to-sites iframe/review interactions use short-lived signed tokens, not shared cookies.
5. Use synthetic fixtures, sandbox payment providers and test sender identities. Do not invite real customers or collect production visitor data on preview hosts.
6. Do not test wildcard tenant-host routing, custom-domain ownership, DNS, SSL, email sender authentication, production OAuth callbacks or white-label portal domains until P7A/P7B as applicable.
7. Any external preview URL exposed beyond the team must be access-protected and `noindex`.

## Preview-deployment evidence gate

The Phase-1 Vercel condition closes only when both apps have preview deployments and the following evidence is recorded: separate project IDs, PR preview URLs, environment-variable separation, deployment protection/access policy, health endpoint response and a rollback/redeploy demonstration. Custom-domain evidence is explicitly deferred to Phase 7A.

## Deferred domain plan

Domain purchase/configuration is intentionally deferred to **before P7A begins**, not to the last day of launch. The Owner must provide a product name, two registrable domains and registrar/DNS control before the domain spike and custom-host implementation. Before public beta, perform DNS propagation, TXT ownership verification, SSL issuance/failure handling, apex/`www` redirect, cookie isolation, sender-domain DNS and rollback tests.

## Required readings

SRS §4.1–4.3, ADR-002, ADR-005, Module 12 and Module 16. For custom domains, additionally read Spike A and the domain gap-register row DG-11.
