# ADR-013: Data residency and regions

**Status:** Accepted (D14 locked by the Owner) · **Date:** 2026-09-21 · **SRS:** SEC-21, D14

## Decision

Primary data and compute in **Mumbai (ap-south-1)** wherever the provider offers it.

| Component                                         | Region                                                                                    | Verified?        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| Postgres                                          | Supabase `ap-south-1` (Neon has **no** Mumbai region - hence ADR-003)                     | Yes, vendor docs |
| Vercel Functions (`apps/sites`, `apps/dashboard`) | `bom1` (Mumbai)                                                                           | Yes, vendor docs |
| Upstash Redis                                     | ap-south-1 listed among Upstash regions (search summary; confirm primary-region creation) | Partial          |
| Cloudflare R2                                     | No India location hint; delivery via CDN edge                                             | Not verified     |
| Inngest, Sentry, Resend/Postmark, Razorpay        | Vendor-controlled; **cross-border processors to record**                                  | No               |
| Anthropic API                                     | Processing outside India; prompts may contain client business data                        | Known            |

## Consequences

- The privacy inventory ([../privacy-inventory.md](../privacy-inventory.md)) lists every cross-border processor. DPDP does not by itself require in-country storage (counsel to confirm); the choice is for latency and customer trust.
- Function region must equal database region (Vercel's own guidance) or per-request latency multiplies.
