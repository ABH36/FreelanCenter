# Phase 2, slice 2: theme variables, font policy, animation presets

**Status:** built on `feat/p2-s2-theme-fonts-motion`, awaiting Owner approval. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 3 (Q19) · **Module:** `docs/modules/04-template-engine-renderer.md` · **Depends on:** S1 (merged, PR #43).

## 1. Requirements

| Requirement                        | State after S2                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-04 (theme as CSS variables) | Implemented as a compiler (`compileThemeCss`); no per-site stylesheet build. Wired into the page by the renderer in S4                                                           |
| FR-TPL-05 (animation presets)      | Implemented as static CSS plus variables; `prefers-reduced-motion` removes all animation and transition. Applied to sections by the blocks in S3                                 |
| Q19 (Devanagari fonts vs budget)   | Policy implemented and byte budgets enforced by tests (section 4). **Lighthouse measurement of a real page is S7**; the policy is a bound on font bytes, not a Lighthouse result |
| NFR-A11Y-01 (contrast part)        | `contrastIssues(theme)` (WCAG 2.1 AA 1.4.3/1.4.11) exists; reference templates must pass it in S5; the builder/preflight calls it in P3                                          |
| FR-TPL-03, -06, NFR-PERF-01/02/03  | Not yet (S3, S4, S7)                                                                                                                                                             |

Nothing is marked "verified".

## 2. What was built

- `packages/ui/src/color.ts`: hex parsing, WCAG luminance and contrast, mixing, readable-text pick.
- `packages/ui/src/theme.ts`: `compileThemeCss` (about 45 variables: colours, derived on-colours/border/muted, `color-scheme`, fonts, radii, section padding scale, type scale, button look and hover, motion), `compileThemeCssSafe` (never throws; an invalid theme degrades to `DEFAULT_THEME`), `contrastIssues`. Every value comes from a lookup table or a validated hex; the input is re-validated with the S1 `themeSchema` inside the compiler.
- `packages/ui/src/fonts.ts`: policy and `@font-face` generation for the 10 allow-listed fonts. Weights 400 and 700 only; `font-display: swap`; Latin preloaded; Devanagari declared behind its `unicode-range`; only the two fonts a theme uses are declared; Devanagari fallback names in the stack for fonts without Devanagari glyphs; base path validated.
- `packages/ui/src/motion.ts`: presets `none` (0 ms), `subtle` (450 ms, 16 px), `energetic` (700 ms, 36 px); five enter animations; scroll-driven start where `animation-timeline: view()` exists.
- `apps/sites`: `@fontsource/*` 5.3.0 (10 packages, exact versions, published 2026-07-19, no install scripts) as dev dependencies; `scripts/copy-fonts.mjs` (run by `predev`/`prebuild`) copies 28 woff2 files to the git-ignored `public/fonts`; `/fonts/*` is served with `Cache-Control: public, max-age=2592000, stale-while-revalidate=86400` (not immutable, since file names have no content hash). `@platform/schema` added as a dependency and to `transpilePackages`.

## 3. Findings

| ID   | Finding                                                                                                                                                                                        | Consequence                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| S2-1 | Not every allow-listed family has weight 600 (Lato has none), so the plan to use 400/600/700 would have broken some pairs                                                                      | Policy is 400 and 700 only, for all fonts                                                                                                 |
| S2-2 | Devanagari files are 39 to 105 KB each (Mukta 400+700 = 199.6 KB). Declaring them behind `unicode-range` keeps Latin-only pages at zero Devanagari bytes, but a Hindi page pays the full price | Poppins (77 KB) and Noto Sans Devanagari (102 KB) are the light choices; Mukta stays allowed but is the heaviest. Real-page numbers in S7 |
| S2-3 | Dark backgrounds need `color-scheme: dark` for form controls and scrollbars                                                                                                                    | Emitted from background luminance                                                                                                         |
| S2-4 | An existing test (`serve.test.ts`, SEC-03 headers) asserted the headers list was exactly one rule                                                                                              | Updated to assert the baseline rule first plus the new font rule; the baseline is unchanged                                               |
| S2-5 | Size-adjusted fallback fonts (CLS control) are not generated; next/font does this automatically but would add a build-time download from Google                                                | **Open.** If S7's Lighthouse run shows CLS above budget, add per-font fallback metrics measured from the files                            |
| S2-6 | An unknown path such as `/fonts/missing.woff2` falls through to the tenant catch-all route (503 in a local run without the database variables; it would be the host's 404 in production)       | Expected: static files win, everything else is the host router                                                                            |

## 4. Measured font bytes (woff2, weights 400 + 700 together)

| Font                 | Latin KB | Devanagari KB |
| -------------------- | -------- | ------------- |
| Inter                | 46.9     | -             |
| Poppins              | 15.3     | 77.1          |
| Montserrat           | 36.7     | -             |
| Lato                 | 45.5     | -             |
| Roboto               | 43.1     | -             |
| Open Sans            | 36.0     | -             |
| Playfair Display     | 44.0     | -             |
| Hind                 | 31.7     | 142.0         |
| Mukta                | 41.1     | 199.6         |
| Noto Sans Devanagari | 20.6     | 102.0         |

Budgets asserted in `apps/sites/lib/fonts.test.ts`: the Latin preload pair (body 400 + heading 700) is at most 50 KB for every possible pair (worst measured 46.9 KB); the heaviest Devanagari family is at most 220 KB (measured 199.6 KB) and the lightest at most 100 KB (measured 77.1 KB). The served file was also checked on a real `next start`: 200, `font/woff2`, the cache header above, the full security baseline.

## 5. Security, privacy and failure paths

- CSS injection: no free text reaches CSS. Property test over 1,500 random valid themes: output is one printable-ASCII `:root{...}` block, no `<`, `>`, `@`, `\`, newline, `url(`, comment or `expression`. An attack theme (`red;}body{display:none`) is rejected and the safe wrapper falls back to the default.
- Third parties: none. Fonts are same-origin; no Google Fonts request; privacy inventory unchanged. The renderer's CSP in S4 needs `font-src 'self'` and a hashed or nonce'd theme `<style>`.
- Supply chain: ten new dev dependencies from one maintainer scope (`@fontsource`), exact versions, no install scripts, `pnpm audit --audit-level high` run below.
- Accessibility: reduced motion cannot be turned off by the schema; hidden start states exist only inside keyframes, so content is visible without animation support; hover effects are not colour-only.
- No database, tenant data, migration or live action.

## 6. Tests

`@platform/ui`: 22 tests (colour maths against WCAG reference values, determinism, token-to-variable isolation, dark scheme, button variants, rejection and fallback, 1,500-theme property test, contrast reporting, font policy, preload and declaration scope, base-path rejection, motion presets, reduced-motion, tenant-free static CSS). `@platform/sites`: 4 font-pipeline tests plus the updated header test (17 total in the package). Lint and typecheck clean for both packages; production build passes.

## 7. CI-equivalent run

(filled in after the clean-worktree run)

## 8. Compatibility, migration, rollback

New code and dependencies only. **No database change, migration, API, event or live action.** The new build step needs `@fontsource/*` installed (it is, via the lockfile). Rollback is a revert.

## 9. Open items

1. Approve S2.
2. S2-5: fallback-font metrics deferred to S7 unless Lighthouse shows CLS above budget.
3. Weights are 400 and 700 only. If the Owner's template designs need a medium (500/600) weight, it is a policy change plus about +20 KB per font.
