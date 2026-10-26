# 12 — Domains, Hosting and White-Label

**Status:** Platform subdomains: allocation P1 S6, host routing P1 S7 implemented (evidence `docs/reports/PHASE_1_S7_SITES_HOST_ROUTING.md`, live run pending DG-19); custom domains and white-label planned (P7A). **SRS:** FR-DOM-01..10, FR-WL-01..05.

## Outcome

Resolve a host to exactly one authorized live/staging/portal experience, connect customer domains safely and apply agency branding without weakening isolation.

## Domain state machine

```text
Queued → PendingDNS → Verifying → IssuingSSL → Active
                         ↘ Failed(reason) → retry/backoff or user remediation
```

Custom domain activation requires TXT ownership verification, multi-resolver DNS pre-check and throttled durable provider queue. Host mapping is cached with invalidation and negative-cache; removal deletes provider configuration to prevent dangling-DNS takeover. Vercel/Cloudflare choice follows ADR-005’s hard rule, not a mixed proxy architecture.

## Host routing (P1 S7)

Read `apps/sites/lib/serve.ts`, `packages/hosting/src/resolver.ts` and migration `20261026120000_p1_s7_host_routing`; this section records the decisions behind them.

```text
Host header -> normalizeHost (LDH, no port/trailing dot; invalid: 404, no I/O)
  -> Upstash GET sites:host:v1:<host> -> hit: decoded answer
  -> miss: app.resolve_host(host) as app_public -> SET with TTL 300 s (unknown: 60 s)
  -> placeholder 200 | maintenance 503 | not found 404 | database/config failure 503 (never cached)
```

- **Resolver.** `app.resolve_host` (SECURITY DEFINER, owned by svc_definer) is the visitor role's only function. Outcomes: `placeholder` (active domain, project not paused or archived, workspace active), `maintenance` (workspace suspended or scheduled for deletion, FR-WS-04; or project paused), `unknown` (anything else, including portal domains). It returns the owning workspace and project ids, which apps/sites keeps server-side (cache value, logs). P3 adds `live` with the published SiteVersion id.
- **Where it runs.** In a Node route handler (`app/[[...path]]/route.ts`) in the function region `bom1`, not in a Next 16 proxy: proxy code may be deployed outside the function region and must not rely on shared globals such as a pool (Next docs), which would repeat finding S6-10.
- **Cache (FR-DOM-07, SRS 5.3 item 7).** One key per host; positive and negative entries; values are validated on read. The cache is never a dependency: a cache error falls through to the database. Concurrent misses in one instance share one lookup.
- **Invalidation.** Project create, duplicate and every status change write a `sites.hosts.changed.v1` outbox row (`{workspaceId, projectId}`) in the command's transaction; the outbox emits it after commit and `sites.host_cache.invalidate.v1` reloads the project's host names through RLS (including soft-deleted domains) and deletes their keys. No idempotency key: every change must invalidate. A lost invalidation is bounded by the TTL. Suspension (S8) must emit the same event per project.
- **Pages and headers (SEC-03).** Four static documents without script or tenant data (a draft's name is not public); CSP `default-src 'none'` plus one hashed style, `frame-ancestors 'none'`; baseline headers (nosniff, Referrer-Policy, XFO DENY, Permissions-Policy, COOP, CORP) on every path from `next.config.ts`; `noindex`; `no-store` (a CDN copy could not be invalidated before P3's tagged caching).
- **Boundaries.** apps/sites imports `@platform/db/public` (pg only, no Prisma), `@platform/hosting` and `@platform/providers`; ESLint forbids the tenant client, services, jobs, auth and dashboard code there.
- **Known limits.** On `sites-two-nu.vercel.app` (DG-18) the platform subdomains are not publicly routable (Vercel does not route sub-subdomains of `*.vercel.app`); they are exercised with a `Host` header until DG-11. HSTS is left to Vercel on its domains and decided for custom domains in P7A.

## White-label contract

BrandProfile controls authorised presentation for portal/onboarding/review/email. Custom portal domain uses the same verified-domain pipeline. Custom sender requires SPF/DKIM/DMARC checks and send-test. Branding removal is a server-checked entitlement.

## Evidence

Run vendor integration proof, DNS propagation/retry/limit tests, takeover-removal test, host collision and cache invalidation tests, SSL failure visibility, redirect/HSTS rollout test and branded-portal authorization test. Upstream: publishing, entitlements, jobs; downstream: public renderer and client portal.
