# Phase 3, slice S9d: page search titles and descriptions

**Status:** built on `feat/p3-s9d-page-seo`; tests in section 5; **approved by the Owner 2026-11-20** ("yes i approve"). **Date:** 2026-11-20 · **Requirements:** FR-BLD-01/02 (edit the site's content), FR-PUB-04 (preflight before publishing), FR-SEO (page titles and descriptions; module 14) · **Modules:** 05, 06, 14 · **Gap:** DG-40 · **Plan approved by the Owner 2026-11-20:** Live is blocked and Staging warned while a page still names the template's sample business; a one-click replace is included. **Migration:** none, so no live database step.

## 1. Why

The S9b production check found the staging page titled "Iron Pulse Fitness | Gym and personal training" for a business named "S8b Check Gym". Each template page comes with a search title and description (`pages[].seo`) that names the template's demo business. They did not follow the business name, and the editor had no field for them. A staging or live site would therefore show the demo business in the browser tab and in search results (DG-40).

## 2. What was built

| #   | Change                                 | Where                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Search texts in the page settings**  | `structure.tsx` `PageSeo`, under each page's settings: "Search title" (70 characters) and "Search description" (200), with counters. The placeholder shows what the site uses when the field is left empty (home: business name and tagline; other pages: "page \| business"). Saved with the existing `updatePage` operation: lock, revision, validation, undo and audit as for every change. |
| 2   | **Replace the sample name**            | When any page's search texts name the template's business, the page settings show "The search texts of N pages still name the template's sample business …" and a button "Replace the sample name with "<business>"". It replaces the name on every page in **one** change (one undo), keeping each text within its limit (cut at a word).                                                     |
| 3   | **Preflight `demo-seo`**               | `preflight.ts`: while a page's search title or description names the template's business, Live is blocked and Staging warned (same weight as the demo contact details), with the pages named and where to fix it. Not checked when the business name itself contains the demo name ("Gupta Sweets Indore"), where the short form may be the business's own.                                    |
| 4   | **Shared, pure helpers**               | `@platform/schema/seo-demo`: `findDemoSeo`, `replaceDemoSeo`, `clipSeoText`, `SEO_TEXT_LIMITS`. A separate export path keeps zod out of the editor's browser bundle (the file imports types only).                                                                                                                                                                                             |
| 5   | **The template's name for the editor** | `builder.getDraft` returns `demoBusinessName`, read from the catalogue template through `app.catalog_template_for_draft` (platform demo content, executable by any member), the same source the preflight uses.                                                                                                                                                                                |

## 3. Decisions

1. **Live blocked, Staging warned** (approved): a search result naming another business misleads the client's customers, like a demo phone number.
2. **One-click replace** (approved): sites have up to 20 pages; replacing by hand is slow and easy to miss.
3. **No automatic change** when the business is renamed: the person decides, and the preflight says what is left.
4. **A business name that contains the demo name is left alone.** This was found while testing: replacing "Gupta Sweets" inside "Gupta Sweets 1234" would double the name, and the short form may be the business's own.

## 4. Security review

- The new fields go through the existing `updatePage` patch: server-side validation (`text(70)`, `text(200)`, no `<` or `>`, no control characters), the edit lock, the expected revision and the audit row. The browser only proposes the change.
- The replace button builds ordinary `updatePage` operations that the server validates the same way.
- `demoBusinessName` is the business name of a platform catalogue template, which is public demo content; no tenant data is read.
- Rendering is unchanged: titles and descriptions are escaped by the renderer as before.

## 5. Tests and evidence

| Suite                                                                                            | Result  |
| ------------------------------------------------------------------------------------------------ | ------- |
| `packages/schema` `seo-demo.test.ts` (new)                                                       | 7/7     |
| `packages/workspaces` `preflight.unit.test.ts` (1 new, 1 adjusted)                               | 10/10   |
| Integration `publishing.test.ts` (1 new: blocks Live until replaced), `approval-gate`, `builder` | 41/41   |
| Workspaces integration (full)                                                                    | 245/245 |
| Isolation suite                                                                                  | 402/402 |
| E2E (the Live journey now meets the check, replaces the name, and checks the live `<title>`)     | 24/24   |

The integration helpers that rename the business before Live now replace the sample name in the same change, as a person would with the button.

**CI note (PR #112, 2026-11-20):** the first CI run failed twice in the S9a stale-build E2E test ("locator.fill: Test ended"). In CI another server action of the editor (its lock renewal, or a re-render by the development server) met the simulated new build before the test typed, so the editor rightly stopped editing and disabled the field, and the test waited two minutes to type into it. The app behaved as designed; the test assumed one order. It now types only while the field still takes input, and in either order checks the notice, that editing stopped, that nothing is left on "Saving…", and that the reloaded draft lost nothing. Local E2E after the change: 24/24 (12.4 minutes).

## 6. CI-equivalent (local, 2026-11-20)

Branch `feat/p3-s9d-page-seo` on `e316986`. `prettier --check` on every changed file, `sync-plan:check`, `lint` (18 tasks), `typecheck` (18), `test` (15) and `build` (dashboard and sites) pass; `traceability` unchanged. Workspaces integration 245/245, isolation 402/402, E2E 24/24 in 15.5 minutes (2026-11-20).

## 7. Cost

None.

## 8. Open items

- The Open Graph image (`seo.ogImage`) and `noindex` are not editable yet (module 14, local SEO).
- Existing projects get the check at once; their owners fix them with the button before the next Live publish.
