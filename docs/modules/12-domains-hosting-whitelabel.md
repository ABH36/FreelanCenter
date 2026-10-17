# 12 — Domains, Hosting and White-Label

**Status:** Planned (P7A; platform subdomains earlier). **SRS:** FR-DOM-01..10, FR-WL-01..05.

## Outcome

Resolve a host to exactly one authorized live/staging/portal experience, connect customer domains safely and apply agency branding without weakening isolation.

## Domain state machine

```text
Queued → PendingDNS → Verifying → IssuingSSL → Active
                         ↘ Failed(reason) → retry/backoff or user remediation
```

Custom domain activation requires TXT ownership verification, multi-resolver DNS pre-check and throttled durable provider queue. Host mapping is cached with invalidation and negative-cache; removal deletes provider configuration to prevent dangling-DNS takeover. Vercel/Cloudflare choice follows ADR-005’s hard rule, not a mixed proxy architecture.

## White-label contract

BrandProfile controls authorised presentation for portal/onboarding/review/email. Custom portal domain uses the same verified-domain pipeline. Custom sender requires SPF/DKIM/DMARC checks and send-test. Branding removal is a server-checked entitlement.

## Evidence

Run vendor integration proof, DNS propagation/retry/limit tests, takeover-removal test, host collision and cache invalidation tests, SSL failure visibility, redirect/HSTS rollout test and branded-portal authorization test. Upstream: publishing, entitlements, jobs; downstream: public renderer and client portal.
