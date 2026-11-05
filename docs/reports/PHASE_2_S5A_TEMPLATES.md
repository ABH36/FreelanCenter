# Phase 2, slice 5a: reference templates and onboarding manifests

**Status:** built on `feat/p2-s5-templates`, awaiting Owner approval. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 5 (first half) · **Module:** `docs/modules/04-template-engine-renderer.md` · **Depends on:** S1-S4 (PRs #43-#47).

S5 is split in two so that the live database migration stays small and separately approved. **S5a (this report)** is data and code only: no database, no migration. **S5b** adds `Template`/`TemplateVersion` tables, row-level security, the seed command and the live migration, and needs a separate Owner approval before anything touches the live database.

## 1. Requirements

| Requirement                                                                                                          | State after S5a                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-10 (at least 3 reference templates: Gym, Taxi, Event/Wedding)                                                 | Implemented as data in `packages/templates`: `gym-bold`, `taxi-quick`, `wedding-royal`. The Lighthouse Performance >= 90 and Accessibility >= 95 scores per template are measured in S7                          |
| FR-TPL-11 (onboarding manifest per template)                                                                         | Implemented: 14 shared business questions plus template-specific lists, mapped to config paths, validated by `templateSchema`; 21 to 24 fields each. The wizard that consumes them is P5                         |
| FR-TPL-08 (taxonomy)                                                                                                 | The 10 categories exist in the schema (S1); three have a template, the other seven are "generic" until more templates are designed (Q17: 10 or more templates by launch is a design-capacity item for the Owner) |
| ADR-004 acceptance: 3 distinct templates without renderer changes                                                    | Proven by test: three templates differ in palette, heading font, hero layout, button shape, background, page count and section mix, and no renderer or block code changed to make them                           |
| FR-ONB-02 data needs (logo, phone/WhatsApp, address, hours, services and prices, photos, social links, testimonials) | Covered by the manifest after two schema extensions (section 3: S5-1, S5-2)                                                                                                                                      |

Nothing is marked "verified".

## 2. What was built

- `packages/templates` (new, pure): `gym.ts`, `taxi.ts`, `wedding.ts`, shared helpers, `BUILT_IN_TEMPLATES`, `getBuiltInTemplate`. Plain data only: no code, no assets (images are asset ids that show a placeholder until P3 assets exist). Demo phone numbers are obviously fake (`+9112345678xx`), emails use `example.com`.
- **Gym Bold:** dark, red and gold, Poppins and Inter, split hero, stats, programmes, about, three plans, coaches, reviews, FAQ, trial banner, contact. One long page with anchors.
- **Taxi Quick:** navy and yellow, Montserrat and Open Sans, full-bleed hero, icon grid, rate-card page (`/rates`), one-tap WhatsApp booking, details-only contact.
- **Wedding Royal:** ivory, maroon and gold, Playfair Display and Lato, centred hero, masonry gallery plus `/gallery` page, single quote, consultation form.
- Manifest kinds extended for what real onboarding needs: opening `hours`, a photo gallery (`images`), and repeating groups (`list` with columns, for example a service's name, description and price).

## 3. Findings

| ID   | Finding                                                                                                                                                                                                                                              | Consequence                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5-1 | The S1 manifest could only describe single values, but FR-ONB-02 asks for hours, services with prices, photos and testimonials                                                                                                                       | Manifest schema extended (additive, 3 new kinds, shape checked against the default config, no duplicate paths); 3 new schema tests; JSON Schema regenerated                                                                                                                        |
| S5-2 | **Open decision.** The config had no business logo, yet the wizard asks for one                                                                                                                                                                      | Added optional `business.logo` (asset reference with alt). The header shows the logo once its file exists and the written name until then; JSON-LD gets `logo`. Same kind of additive SRS 5.2 extension as `footer.floatingAction` and `business.language`; needs Owner acceptance |
| S5-3 | Looking at the rendered templates in a browser showed three layout flaws no test sees: a full-bleed hero background stopped short of its section (padding outside it), six cards broke 5+1 or 4+2 unevenly, and the list variant was one long column | Fixed in `blocks.css` (`:has()` for the hero, at most 3 cards per row, 4 for the icon grid, two columns for the list on wide screens); bundle regenerated; all templates re-checked at 1280 px                                                                                     |
| S5-4 | A skip-link `#main` looked like a dangling anchor in my link-integrity test                                                                                                                                                                          | Test exempts it explicitly; the check still fails for any other missing anchor or page                                                                                                                                                                                             |
| S5-5 | Template copy is English only; the language switch exists (`business.language`) but a Hindi version of each template's content is not written                                                                                                        | Planned with the P5 i18n work (NFR-I18N-01) or when the Owner wants Hindi default content; the blocks' own strings are already bilingual                                                                                                                                           |
| S5-6 | Photos are placeholders: no asset pipeline until P3                                                                                                                                                                                                  | Templates look complete with the gradient placeholders but need real photography for sales previews (S6) and final design review                                                                                                                                                   |

## 4. Tests and evidence

`@platform/templates`: 25 tests. Per template: valid under `templateSchema`; **WCAG 2.1 AA contrast for all colour tokens** (the S2 checker); every page renders as 200 with one `<h1>`, no block error, no script other than JSON-LD, under 80 KB of HTML; every internal link and anchor resolves; every block and variant exists in the registry; the manifest has the essentials with unique keys; **applying an answer to every manifest field leaves the config valid and renderable** (proves each path is a real place to fill). For the set: exactly the three required categories, visibly distinct on five design dimensions plus section mix, and at least ten block types used.

Real browser (Chromium, real self-hosted fonts): all three templates load their own fonts (Poppins/Inter, Montserrat/Open Sans, Playfair Display/Lato), no console errors, layout reviewed at 1280 px. Schema: 44 tests (3 new). Blocks: 70 tests (logo). Quality of the design itself is for Owner review (Q17).

## 5. Security, privacy, failure paths

Templates are data validated by the same closed schema as any creator package (ADR-004); nothing executable. Demo contact data is fake so a preview cannot reach a real person. No database, tenant data, network or secret is involved. A template that failed validation would fail CI, not production.

## 6. CI-equivalent run

(filled in after the clean-worktree run)

## 7. Compatibility, migration, rollback

New package; additive schema fields (`business.logo`, three manifest kinds, optional `maxItems`/`itemFields`). Existing stored configs and manifests stay valid. **No database change, migration, API, event or live action.** Rollback is a revert.

## 8. Open items

1. Approve S5a.
2. S5-2: accept `business.logo` as an additive SRS 5.2 extension.
3. Design review of the three templates (palette, copy, structure) when convenient; real photography is needed for sales-grade previews.
4. Next: S5b (database tables, RLS, seed, live migration). The migration will not be applied live without the Owner's separate approval.
