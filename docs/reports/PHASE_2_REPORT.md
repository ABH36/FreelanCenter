# Phase 2 report: Template Engine and Renderer (phase exit, slice 7)

**Status:** built on `feat/p2-s7-phase-exit`, approved by the Owner 2026-11-06; design review and the Phase 2 audit follow. Nothing is marked "verified" until the audit. **Date:** 2026-11-06 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 · **Module:** 04 (templates and renderer) · **Slices:** S1 #43, S2 #44, S3 #45, S4 #47, S5a #48, S5b #49 (live), S6a #51, S6b #52, S7 (this report).

## 1. What Phase 2 delivers

A visitor can open a site that is rendered from a validated SiteConfig, with no per-site build and no tenant JavaScript. A freelancer can pick one of three built-in templates, make a signed, expiring, login-free preview link in the dashboard and send it to a prospect.

| Slice | Delivered                                                                                                                                                | Report                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| S1    | SiteConfig v1.0: strict Zod schemas, closed block catalogue, patch, migration, generated JSON Schema                                                     | `PHASE_2_S1_SCHEMA.md`             |
| S2    | Theme compiler (CSS variables), font policy (self-hosted, weights 400/700), motion presets, WCAG contrast maths                                          | `PHASE_2_S2_THEME_FONTS_MOTION.md` |
| S3    | 12 section blocks (24 variants) plus header, footer, floating actions; English and Hindi strings; static CSS; allow-listed HTML serializer               | `PHASE_2_S3_BLOCKS.md`             |
| S4    | `renderDocument`, block isolation, hash-based CSP, sitemap, robots, live host rendering through an injectable `SiteSource`                               | `PHASE_2_S4_RENDERER.md`           |
| S5a   | Three templates as data: gym-bold, taxi-quick, wedding-royal                                                                                             | `PHASE_2_S5A_TEMPLATES.md`         |
| S5b   | `templates` and `template_versions` tables (live), immutable versions, definer functions, seed                                                           | `PHASE_2_S5B_TEMPLATE_TABLES.md`   |
| S6a   | HMAC preview tokens and the `/p/<token>` route on the preview host                                                                                       | `PHASE_2_S6_PREVIEW.md`            |
| S6b   | Templates page, capability `templates.preview`, audited server action                                                                                    | `PHASE_2_S6B_SHARE_PREVIEW.md`     |
| S7    | axe, visual regression and Lighthouse budgets on the three templates; one real accessibility defect fixed; this report; traceability; FR-OBS-01 decision | this file                          |

## 2. Requirements

| Requirement                                              | State                                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-01..08 (declarative templates, blocks, theme)     | Implemented in S1-S5; covered by schema, property, renderer and template tests                                                                                                                      |
| FR-TPL-09 (login-free expiring preview)                  | Implemented and exercised in a real browser (S6b). The dashboard side cannot be used live until DG-27                                                                                               |
| FR-TPL-10, FR-TPL-11                                     | See module 04 and the S5 reports; no change in S7                                                                                                                                                   |
| NFR-PERF-01 (mobile performance), NFR-A11Y, SEC-03 (CSP) | Measured here (section 3); the CSP is unchanged and still has no `'unsafe-inline'` and no script source                                                                                             |
| **NFR-PERF-04 (dashboard p95, in region)**               | **Not measured. Blocked by DG-27** (dashboard production is not configured). The informational CI `perf` job gives a hosted-runner number only; the in-region number needs the production dashboard |
| FR-OBS-01 remainder                                      | Decision proposed in section 7                                                                                                                                                                      |

## 3. Quality evidence (the Phase 2 exit gate)

Harness: `tests/quality` runs the **real** `serveHost` from `apps/sites` over HTTP, with one site per built-in template at `<slug>.quality.localhost`, public mode (so canonical, JSON-LD and sitemap are in the measured page), fonts from the sites app's own folder. Nothing is mocked in the render path; only the database lookup is a stub.

### 3.1 Accessibility (axe-core 4.13, WCAG 2.1 A and AA)

Three templates x mobile (Pixel 7) and desktop (1280 px): **6 of 6 pass with zero violations** after the fix in finding S7-1. Before the fix gym-bold failed `color-contrast` on both viewports.

### 3.2 Lighthouse mobile (13.5.0, median of 3 runs, simulated slow 4G, 4x CPU slowdown)

Budget: performance >= 90, accessibility >= 95, SEO >= 95, best practices >= 95. Measured on the author's Windows laptop, so performance varies run to run; the CI job gives the number to trust.

| Template      | Performance | Accessibility | SEO | Best practices | LCP     | CLS   | TBT    |
| ------------- | ----------- | ------------- | --- | -------------- | ------- | ----- | ------ |
| gym-bold      | 94          | 100           | 100 | 100            | 1357 ms | 0.012 | 277 ms |
| taxi-quick    | 99          | 100           | 100 | 100            | 1273 ms | 0     | 127 ms |
| wedding-royal | 99          | 96            | 100 | 100            | 1357 ms | 0     | 102 ms |

Honest notes: gym-bold's performance score ranged 88 to 94 over four full runs (total blocking time 277 to 487 ms, on pages with no JavaScript, so it is main-thread style and layout cost under the 4x slowdown). It is the template closest to the line. wedding-royal accessibility is 96, above the budget but not 100; the audit that costs the points was not investigated further.

### 3.3 Visual regression

Full-page screenshots of the three templates, mobile and desktop (6 baselines in `tests/quality/src/__screenshots__`), generated in the Linux Playwright image `v1.64.1-noble` (`bash tests/quality/scripts/visual-baselines.sh update`) and re-checked in the same image (`check`: 6 of 6 pass). Tolerance 0.2 % of pixels. Any intentional design change must regenerate and review the baselines in the PR.

## 4. Findings

| ID   | Finding                                                                                                                                                                                                                        | Consequence                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S7-1 | Text links used the brand primary. On gym-bold (red `#E11D2E` on near-black `#0B0B0F`) the contact links measured 4.13:1, below the 4.5:1 AA minimum. The S2 contrast check covered text, buttons and surfaces but not links   | New derived token `--color-link` (`linkColor` in `@platform/ui`): the primary when it reads on both background and surface, otherwise the nearest blend toward the text colour that does. Three unit tests; axe now clean           |
| S7-2 | Lighthouse's `robots-txt` audit fetches the file through the page, where our strict CSP (`default-src 'none'`) blocks it ("CSP violation"), so SEO scored 92 on every template although `robots.txt` is valid                  | The CSP was **not** relaxed. The audit is skipped in the Lighthouse run and `robots.txt` (200, `User-agent: *`, `Sitemap:` line) is asserted by a direct request instead. Search engines fetch it without a page and are unaffected |
| S7-3 | Design review pending (Owner): in the wedding-royal stats band the large numbers read dim on the maroon background in the screenshot. Large text only needs 3:1, which it meets, so axe passes, but this is a visual judgement | Owner to review the three templates; real photography is still needed (the demo images are placeholders)                                                                                                                            |
| S7-4 | The CI image is `ubuntu-latest` and the baselines come from the Playwright Ubuntu 24.04 image; a small anti-aliasing difference is possible                                                                                    | The job is informational until it has been green on this PR; if it flakes, baselines are regenerated from the CI artifact instead                                                                                                   |

## 5. Audit checklist (SRS audit points for Phase 2)

| Point                         | Evidence                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema strictness             | Strict Zod objects, closed block catalogue, unsafe URL, font and size limits; property tests and malformed-config fixtures (S1 report)                                                                                          |
| Registry consistency          | One registry drives schema, renderer and editor metadata; tests fail if a block type has no schema, renderer or defaults (S3 report)                                                                                            |
| XSS review                    | No `dangerouslySetInnerHTML` for tenant data; own allow-listed serializer equal to `react-dom/server` by test; every href re-checked; hash-based CSP with no script source; block isolation. Threat model updated (S3, S4, S6a) |
| Performance and accessibility | Section 3                                                                                                                                                                                                                       |
| Template quality              | Three templates render, pass axe and the budgets; **Owner design review still required** (S7-3)                                                                                                                                 |
| Extensibility                 | New block = new registry entry and CSS; new template = data plus a seed entry; additive schema fields were Owner-approved (`footer.floatingAction`, `business.language`, `business.logo`)                                       |
| Tenant isolation              | Template tables have RLS; the isolation suite and its mutation check cover them (S5b report)                                                                                                                                    |

## 6. Security review

- No new endpoint, table or secret in S7. The harness server is a test tool, listens on `127.0.0.1` only and is not deployed.
- `esbuild` (harness bundler) is added as a dev dependency with its install script denied (`allowBuilds`, SEC-13); the binary ships in the platform package. `lighthouse` and `@axe-core/playwright` are dev-only, versions at least two weeks old.
- CSP unchanged (S7-2 explains why it was not loosened for a tool).

## 7. Decisions needed

1. **FR-OBS-01 remainder (recommended):** metrics, OpenTelemetry tracing, uptime checks and alert runbooks move to **Phase 8 (launch gate, module 16)**, with two earlier hooks: Sentry goes live when the account exists (DG-23), and an uptime check on the sites health endpoint is added the day the first production host serves traffic (DG-27). Reason: there is no production traffic to observe before P3 publishing; building dashboards for nothing now would be unused work. Owner to confirm.
2. **CI `quality` job:** keep informational for this PR, then make it required once green on main (recommended).
3. **NFR-PERF-04 in region:** needs DG-27 (dashboard production go-live: DG-10 email, DG-16 production Turnstile, auth and app database variables). Until then the number is open.
4. **Design review** of the three templates and real photography (S7-3).

**Owner decisions, 2026-11-06:** (1) FR-OBS-01 remainder to Phase 8 with the two hooks: approved. (2) CI `quality` job informational first, then required: approved. (3) NFR-PERF-04 in region: recorded as gap DG-28 so it is not lost. (4) Design review and real photography: done at the end of Phase 2, when the Owner tests the product through the Claude extension, before the Phase 2 audit is closed.

## 8. Open items carried out of Phase 2

DG-27 (dashboard production); per-link preview revocation (not built; links expire, 30 days at most); `PREVIEW_HOST` is `sites-two-nu.vercel.app` as an interim because `*.vercel.app` has no sub-subdomains, to be `preview.<domain>` once the real sites domain exists (DG-11); the contact form is dormant until the P5 lead endpoint; analytics is a slice after P3.

## 9. Tests and CI-equivalent run

Clean worktree at `5467497`, `pnpm install --frozen-lockfile`. Steps run: format:check, sync-plan:check, lint (18/18), typecheck (18/18), traceability regenerated with no diff, `pnpm audit --audit-level high` (exit 0; 2 low and 6 moderate transitive advisories, none from the new dev dependencies), build (3/3; the existing Edge-runtime logger warnings only), `pnpm test` (15/15 tasks: schema 44, ui 25, blocks 74, templates 28, hosting 27, sites 49, auth 150, workspaces 71, logger 39, jobs 22, db 24, providers 13, dashboard 3, ai 1), axe 6/6, Lighthouse (second full run: gym-bold 97, taxi-quick 99, wedding-royal 100 performance; 100/96/100 accessibility minus wedding 96; SEO and best practices 100), visual check in the Linux image 6/6.

**Not re-run locally for S7:** the `db-integration` and `e2e` jobs. S7 changes no database, auth or route code (only the link colour in CSS and the theme compiler); both run in CI on the PR and must be green before merge.
