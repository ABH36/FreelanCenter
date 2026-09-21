# Spike A - custom hostnames and SSL (Vercel Domains API vs Cloudflare for SaaS)

**Status: NOT EXECUTED. Desk research only.** Running this spike needs a Vercel Pro team, an API token and a domain the builder controls; none was available. **Nothing below is a measurement.**

## What desk research found (sources read 2026-09-21)

| #   | Fact                                                                                                                                                                                                                             | Source                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | Pro/Enterprise projects have no plan cap on domains; soft anti-abuse limits of 100,000 (Pro) and 1,000,000 (Enterprise) domains per project, raisable on request                                                                 | [Vercel multi-tenant limits](https://vercel.com/docs/platforms/multi-tenant-platforms/limits) (via search summary)                                                                                                                                                                                                            |
| A-2 | Domain API calls are rate-limited to **100 domain additions per hour per team**                                                                                                                                                  | same                                                                                                                                                                                                                                                                                                                          |
| A-3 | Wildcard subdomains require using Vercel's nameservers; Vercel issues a certificate per subdomain on the fly                                                                                                                     | [Vercel domain management](https://vercel.com/docs/multi-tenant/domain-management)                                                                                                                                                                                                                                            |
| A-4 | Vercel recommends **against** a reverse proxy (including Cloudflare orange-cloud) in front of Vercel: it hides client IPs from the Firewall/bot protection, adds latency and cache confusion. Cloudflare as **DNS only** is fine | [Vercel KB: Cloudflare with Vercel](https://vercel.com/kb/guide/cloudflare-with-vercel)                                                                                                                                                                                                                                       |
| A-5 | Vercel Functions region `bom1` (Mumbai, ap-south-1) exists                                                                                                                                                                       | [Vercel regions](https://vercel.com/docs/regions) (read in full)                                                                                                                                                                                                                                                              |
| A-6 | GoDaddy restricts Domains API access by account size (reports of a 50-domain requirement); other endpoints have different thresholds                                                                                             | [Let's Encrypt community thread](https://community.letsencrypt.org/t/godaddy-no-longer-allows-api-access-to-clients-e-g-for-dns-based-cert-renewal-if-you-have-less-than-50-domains/219377), [GoDaddy help](https://www.godaddy.com/help/how-do-i-access-domain-related-apis-42424) (search summaries; terms change, confirm) |

## Consequences already visible

- **ADR-005 hard rule holds**: Vercel-hosted sites => Vercel Domains API, no Cloudflare proxy. Cloudflare stays DNS-only or serves only our asset domain (R2).
- **A-2 is a design input**: onboarding bursts (an agency importing 150 client domains) will hit 100 additions/hour. Domain adds must go through a rate-limited durable queue (Inngest concurrency/throttle), with user-visible "queued" state. Add to FR-DOM-05.
- Platform subdomain zone (`*.sites-domain`) must be delegated to Vercel nameservers (A-3). Decide DNS ownership before buying the domain (D1).
- Vercel's regional pricing applies to Fast Data Transfer etc. (see Spike E); the sites app should run in `bom1` next to the Mumbai database (D14).

## Runbook to actually execute (when credentials exist)

Inputs: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, a Vercel project for `apps/sites`, two test domains (one apex, one subdomain) and the platform wildcard zone.

| Step                                      | Measure                                                                                | Pass criteria                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1 Add wildcard `*.<sites-domain>`         | time until first HTTPS 200 on a random subdomain                                       | < 5 min, no manual step                                |
| 2 Add a custom apex + www through the API | time to `verified` and to first valid certificate; DNS records the API tells us to set | records match what our UI will show; time recorded     |
| 3 Deliberately wrong DNS                  | API status/error, whether retries hammer issuance, how long until it settles           | no repeated failing issuance from our side (FR-DOM-04) |
| 4 Remove domain via API                   | domain stops resolving to our project; no dangling config                              | FR-DOM-08                                              |
| 5 Add 120 domains in an hour              | exact rate-limit response and headers                                                  | queue design validated                                 |
| 6 Host header routing                     | `apps/sites` middleware resolves `Host` to a site with Redis cache                     | p95 < 20 ms warm                                       |
| 7 Domain Connect                          | does our template onboard with the target registrars; how long                         | lead time recorded                                     |

## Decision status

ADR-005 = **Accepted as Option A for planning**; the spike above must confirm before Phase 7A relies on it (it may run any time after an account exists; Phase 3 needs only platform subdomains).
