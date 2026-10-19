# 14 — Local SEO and Public-Site Quality

**Status:** Planned across P2/P4/P7A. **SRS:** FR-SEO-01..05, FR-TPL-03/10, FR-PUB-04, FR-AI-07.

## Outcome

Ensure every live local-business site is crawlable, fast, accessible and accurately represented while preventing staging/preview indexing.

## Contract and flow

Renderer emits SSR title/meta/canonical/OpenGraph/Twitter data from validated `SiteConfig`. It generates category-appropriate LocalBusiness JSON-LD from canonical business fields, plus host-specific `sitemap.xml` and `robots.txt`. A version is preflighted before live publish; rule failures block and quality warnings are visible. AI SEO is a proposed patch, not silent mutation.

```text
Draft/version → schema + SEO/accessibility/performance preflight
→ block or warn → live host resolves version → SSR metadata/sitemap/robots
→ sampled Core Web Vitals → regression alert
```

## Guardrails/evidence

Staging and pitch previews are always `noindex`; canonical host cannot be user-injected; structured-data strings are escaped/validated. Test metadata per page, sitemap host isolation, JSON-LD validity, mobile Lighthouse and axe scores, cache behavior, robots in every non-live mode and CWV sampling privacy. Keyword tracking/competitor tools are post-v1 propositions, not required launch scope.
