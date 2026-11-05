# Phase 2, slice 4: SiteRenderer (SSR, SEO, CSP, sitemap, robots)

**Status:** built on `feat/p2-s4-renderer`, awaiting Owner approval. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 4 · **Module:** `docs/modules/04-template-engine-renderer.md` · **Depends on:** S1-S3 (PRs #43, #44, #45).

## 1. Requirements

| Requirement                                                                     | State after S4                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-TPL-03 (render any valid config server-side, no per-site compile, SEO-ready) | Implemented: `renderDocument(config, path, origin)` returns a complete HTML document; `serveHost` serves it for a live host. SEO: title, description, canonical, robots, Open Graph, Twitter card, favicon, `hreflang`-free single language, category JSON-LD, `sitemap.xml`, `robots.txt` |
| FR-TPL-06 (validate on read, safe fallback)                                     | `parseSiteConfig` runs on every render; a stored config that no longer validates becomes the 503 "unavailable" page, logged by field path only; block failures are isolated (S3)                                                                                                           |
| SEC-03 (strict CSP on tenant sites)                                             | Implemented for rendered pages: `default-src 'none'`, hash-allowed inline styles only, no script source, `form-action` closed unless a lead form exists, `frame-ancestors 'none'`. Verified in real Chromium (section 5)                                                                   |
| NFR-PERF-01/02 (LCP, cached TTFB)                                               | Groundwork only: no client JavaScript, 2.7 KB gzip of shared CSS, Latin font preload, LCP image preload, first section not animated. **Measured Lighthouse numbers are S7; edge caching is P3**                                                                                            |
| NFR-A11Y-01, NFR-BROW-01                                                        | Semantics are built in (S3, plus `lang`, one `h1`, skip link target); axe and browser matrix are S7                                                                                                                                                                                        |

Nothing is marked "verified".

## 2. What was built

- `packages/blocks`: `document.tsx` (`renderDocument`), `seo.ts` (`localBusinessJsonLd`, `buildSitemap`, `buildRobots`, escaping), `serialize.ts` (HTML serialiser), `css-bundle.ts` (generated copy of `blocks.css`, drift-tested, Prettier-ignored).
- `apps/sites`: `lib/site-source.ts` (the `SiteSource` interface and an empty default), `lib/site-response.ts` (CSP and headers), `lib/serve.ts` extended: a live host asks the source for a site and serves a page, `/sitemap.xml` or `/robots.txt`; with no site it keeps the P1 placeholder exactly as before.
- The page is HTML plus two inline stylesheets (shared static one, per-site theme and font faces). **No client JavaScript is emitted.** The only `<script>` is the JSON-LD data block, which is not executable.
- 404 for an unknown path on a valid site is a branded page with the site's chrome, `noindex`, and a link home (English and Hindi).
- `business.language` drives `<html lang>`, `og:locale`, JSON-LD `inLanguage` and the strings.

## 3. Findings

| ID   | Finding                                                                                                                                                                                                  | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S4-1 | Next.js refuses to build when a route handler's import chain reaches `react-dom/server` (the first build failed on exactly that)                                                                         | The blocks are already expanded to plain elements by the S3 isolation step, so a 130-line allow-listed serialiser replaces it. **Equality with `react-dom/server` is a test:** every block variant, the chrome, Hindi text and 3,000 fuzzed configs must serialise identically after normalising attribute order and quote entities. Bonus: no `react-dom` at runtime, and the serialiser throws on any tag, attribute, event handler, `style` or raw-HTML prop outside its list |
| S4-2 | CSS in a route handler cannot be read from a file without extra tracing configuration                                                                                                                    | `blocks.css` is bundled as a generated string (`css-bundle.ts`) and a test fails if the two differ (`UPDATE_CSS_BUNDLE=1` regenerates)                                                                                                                                                                                                                                                                                                                                           |
| S4-3 | React 19's automatic image-preload hoisting is lost without `react-dom/server`                                                                                                                           | `renderDocument` emits the responsive `preload` for the single `fetchpriority="high"` image itself (tested)                                                                                                                                                                                                                                                                                                                                                                      |
| S4-4 | **Open decision.** `integrations.analyticsId`, `metaPixelId` and `chatbot` are in the config but **not rendered**: they need third-party scripts, which this CSP forbids by design, and consent handling | Real sites ask for analytics. It needs: a consent banner (DPDP/GDPR), per-site CSP additions, privacy-inventory rows, and a decision between privacy-first first-party analytics and Google/Meta. Proposed as its own slice after P3; Owner to prioritise                                                                                                                                                                                                                        |
| S4-5 | Nothing publishes a site yet (SiteVersion is P3), so `emptySiteSource` is wired in production                                                                                                            | **No production behaviour change:** live hosts keep the placeholder. The render path is covered by tests with a fake source and by a real-browser run. P3 supplies `get_published_version`; S6 supplies template previews                                                                                                                                                                                                                                                        |
| S4-6 | Pages are `Cache-Control: no-store`                                                                                                                                                                      | Deliberate: versioned, tag-purged caching arrives with published versions (P3, NFR-PERF-02)                                                                                                                                                                                                                                                                                                                                                                                      |
| S4-7 | Block failures are logged with `logger.warn('sites.block.error')` (safe summary); there is no Sentry call because the logger only forwards errors                                                        | Acceptable for now; wire `captureMessage` for block errors with the P8 alerting work if the Owner wants them in Sentry                                                                                                                                                                                                                                                                                                                                                           |

## 4. Security, privacy and failure paths

- The head is built from escaped strings (`&`, `<`, `>`, `"`, `'`); JSON-LD is escaped so it cannot close its element (`<`, `>`, `&`, U+2028/9). Tests: hostile business names in title, Open Graph and JSON-LD; origin must be a plain `http(s)://host[:port]`.
- CSP built per response from the exact inline style text (SHA-256), asset origin only if it is a plain `https://host`; no `unsafe-inline`, no `unsafe-eval`, no script, connect or frame source; `upgrade-insecure-requests` outside localhost.
- Staging, review and non-public modes are `noindex` in the meta tag, in `X-Robots-Tag`, in `robots.txt` (`Disallow: /`) and absent from the sitemap, and carry no canonical or structured data.
- Failure pages never reveal tenant data: an invalid stored config logs paths such as `business.name`, never values; a failing source is 503.
- Maintenance and unknown hosts never call the source (tested). No database, secret or tenant data is added.

## 5. Tests and browser evidence

`@platform/blocks`: 69 tests (new: document, SEO, JSON-LD, sitemap, robots, 404, preload, serialiser equality and refusal, CSS bundle, fuzz now also compares both renderers). `@platform/sites`: 32 tests (new: 15 for the response contract, CSP hashes against the real inline styles, HEAD, hostile paths, non-indexable site, invalid config, failing source). Lint, typecheck and production build pass (the build is what exposed S4-1).

**Real browser (Chromium, mobile viewport, a served page with six sections, dark theme):** HTTP 200, **0 CSP violations, 0 console errors**, theme variables applied, only script element is `application/ld+json`, Lucide icons and floating buttons rendered.

## 6. CI-equivalent run

(filled in after the clean-worktree run)

## 7. Compatibility, migration, rollback

New code only; no new dependency except `@platform/blocks` in `apps/sites` (workspace). No database change, migration, API, event, environment variable or live action. Production behaviour is unchanged until a source returns content (S4-5). Rollback is a revert.

## 8. Open items

1. Approve S4.
2. S4-4: analytics, pixel and chatbot integrations are not rendered. Priority and approach (privacy-first first-party analytics versus Google/Meta with consent) need an Owner decision before they are scheduled.
3. S4-7: Sentry for block errors, optional.
