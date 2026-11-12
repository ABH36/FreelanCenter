# Phase 2, slice 8: hardening before the Phase 2 audit

**Status:** built on `feat/p2-s8-hardening`; awaiting Owner approval. Nothing is marked "verified" until the Phase 2 audit. **Date:** 2026-11-12 · **Plan:** Owner-approved gap list after S7 (items A1-A8) · **Module:** 04 · **Depends on:** S7 (PR #54).

## 1. What was asked and what was done

| Item | Gap after S7                                                                    | Result                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Only the 3 templates' home pages were tested, not all 24 block variants         | The harness now serves `/all-blocks` on every site: **all 12 blocks / 24 variants** under each template's theme, in English and Hindi (`<slug>-hi`). Axe: 12 pages x 2 viewports, 0 violations. Visual baselines for the 3 galleries (12 baselines in all)                                                                                                    |
| A2   | Contrast was guaranteed for links only                                          | `--color-muted` is now derived with the same guarantee (`mutedColor`). Property test: 400 random palettes whose text colour passes AA, link and muted text both reach 4.5:1 on background and surface. Button, footer and accent labels use `onColor`, which is always >= 4.58:1 by construction                                                              |
| A3   | No automated checks for reduced motion, forced colours, reflow, keyboard, Hindi | Added for each template: reduced motion (no animation or transition longer than 1 ms), forced colours (every button keeps a border), reflow at 320 CSS px with no horizontal scroll (WCAG 1.4.10), keyboard only (skip link first, visible focus on every stop, no trap). Hindi is covered by the `-hi` galleries                                             |
| A4   | "Fonts are not preloaded"                                                       | **My S7 claim was wrong.** The renderer already preloads the body Latin 400 and heading Latin 700 files (`themePreloads`). No change. The run-to-run spread of gym-bold's performance score is machine noise on pages with no JavaScript, not a missing preload                                                                                               |
| A5   | `quality` CI job is informational                                               | Not changed here: making it required is a branch-protection setting. Green on PR #54 and on this PR; **Owner decision: make it a required check**                                                                                                                                                                                                             |
| A6   | Preview links cannot be revoked                                                 | **Done in slice 8b** (`PHASE_2_S8B_REVOCABLE_PREVIEW_LINKS.md`); section 5 is the plan it followed                                                                                                                                                                                                                                                            |
| A7   | Preview route has no abuse limit                                                | Assessed, no code change (section 4)                                                                                                                                                                                                                                                                                                                          |
| A8   | wedding-royal accessibility 96                                                  | Cause found: the scroll-driven entrance animation (`animation-timeline: view()`) leaves text below the fold at partial opacity until it scrolls into view, and Lighthouse measures before scrolling (it reports foreground `#9f9390`, a blend). A measurement artefact, not a defect: axe, which waits for the final state, passes. Still above the 95 budget |

## 2. Real defects found by the new tests

| ID   | Finding                                                                                                                                                                                                     | Fix                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| S8-1 | **Reflow failure at 320 CSS px.** The stats block (`repeat(2, 1fr)` with a card padding of 1.5 rem) pushed the page 31 px wider than the screen on gym-bold and taxi-quick, so phones would scroll sideways | `minmax(0, 1fr)`, `overflow-wrap: anywhere`, a smaller padding and number size below 480 px. Found by the new reflow test; passes now |
| S8-2 | Test-setup mistake, not a product defect: the gallery page used the id and path `gallery`, which wedding-royal already has, so the config was (correctly) refused                                           | Renamed to `all-blocks`; the harness now logs the render failure reason when `QUALITY_DEBUG` is set                                   |

## 3. Tests

| Suite                                      | Result                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `@platform/ui`                             | 26 tests (new: `mutedColor` guarantee, 400-palette property test)                                       |
| `@platform/blocks`                         | 74 tests (CSS bundle regenerated)                                                                       |
| axe + modes (`tests/quality`, `@a11y`)     | 42 of 42: 3 home + 6 galleries (EN and HI) x 2 viewports, and 4 mode checks x 3 templates x 2 viewports |
| Visual regression (Linux image, `@visual`) | 12 of 12, re-checked in the same image                                                                  |

## 4. A7: the preview route under abuse (assessed)

A request to `/p/<token>` is checked in this order: path shape (token at most 700 characters), HMAC and expiry (microseconds, constant time, no database), then the catalogue lookup, which is cached in process for 60 seconds (15 seconds for misses). So a flood of forged or expired links costs a hash each and never reaches the database; a flood of one valid link costs a render each (no database). The same property holds for every public page until published sites get their versioned cache in P3 (NFR-PERF-02). No in-app limiter was added because it would need shared state (Upstash) on a public hot path for little gain. **Recommendation (Owner, Vercel project settings):** add a platform rate-limit rule for the sites project when the real domain exists (DG-11). Residual risk: low; recorded here and not a blocker.

## 5. Slice 8b (proposed): revocable preview links

Today a link lives until it expires (at most 30 days) and cannot be withdrawn. Plan: a `template_preview_links` table (workspace id, link id, template, creator, expiry, revoked at; RLS and FORCE like every tenant table), a `jti` claim in the signed token (old tokens stay valid until they expire but cannot be revoked), an `app_public` function `app.is_preview_link_revoked(id)` called by the sites app with a 30 second cache, a list and a Revoke button on the Templates page (capability `templates.preview`), audit events, isolation-suite registration and tests. **It needs a live migration, which needs your separate approval, as before.** Revocation takes effect within 30 seconds on the sites app.

## 6. Security

No new route, secret or dependency. The harness stays local. The CSS change only affects layout. Derived colours are computed server-side from validated theme colours.

## 7. Open decisions

1. Make the `quality` CI job a required check on `main` (recommended).
2. Start slice 8b (live migration will be asked for separately).
3. Carried over: design review and photography at the end of Phase 2; DG-27, DG-28.

## 8. CI-equivalent run

Clean worktree, `pnpm install --frozen-lockfile`. The first run caught a typecheck error in the new modes spec (DOM `NodeListOf` iteration), fixed in a follow-up commit and re-run. Passing: format:check, sync-plan:check, lint 18/18, typecheck 18/18, traceability (no diff), `pnpm audit --audit-level high` (exit 0), build 3/3, `pnpm test` 15/15 tasks (ui 26, blocks 74, schema 44, sites 49, auth 150, workspaces 71, others unchanged), axe and modes 42/42, Lighthouse (performance 100 / 99 / 99, accessibility 100 / 100 / 96, SEO and best practices 100), visual check in the Linux image 12/12. `db-integration` and `e2e` run in CI; S8 changes no database, auth or route code.
