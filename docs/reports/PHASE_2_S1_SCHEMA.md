# Phase 2, slice 1: `packages/schema` (SiteConfig v1.0, Template, patch operations)

**Status:** built on `feat/p2-s1-schema`, awaiting Owner approval. **Date:** 2026-11-05 · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 2 task 1 · **Module:** `docs/modules/04-template-engine-renderer.md`.

## 1. Requirements

| Requirement                                      | State after S1                                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TPL-01 (Zod schemas, JSON Schema export)      | Implemented: `siteConfigSchema`, `templateSchema`, `patchSchema`, block props schemas; JSON Schema (draft 2020-12) generated and drift-tested                                                                               |
| FR-TPL-07 (versioning and migrations with tests) | Implemented as a framework (`createMigrator`, `migrateConfig`): forward on read, optional `down`, refuses unknown/future/missing/throwing steps and cycles. No real step yet: `1.0` is the first version; tested with fakes |
| SEC-04 (data not markup), schema half            | Implemented in the schema (text rejects `<`/`>`, control and bidi characters). The lint rule against `dangerouslySetInnerHTML` is S3                                                                                        |
| FR-TPL-02 (registry, 15 blocks)                  | **Not yet.** S1 ships the catalog half (12 section types, their variants and strict props). Registry, components, editor metadata, header/footer/floating action are S3                                                     |
| FR-TPL-08, -11                                   | Schema side only: category enum (10) and manifest schema with path resolution. Data in S5                                                                                                                                   |
| FR-TPL-03/04/05/06/09/10, NFR-PERF/A11Y/BROW     | Out of S1 (S2-S7)                                                                                                                                                                                                           |

Nothing is marked "verified"; `docs/traceability.md` is generated and untouched.

## 2. What was built (`packages/schema/src`)

- `primitives.ts`: bounds (`LIMITS`: 256 KB, depth 24, 20 pages, 40 sections/page, 12 nav items, 24 items), text without markup, URLs (`https:`, `tel:`, `mailto:` only; no credentials, whitespace or `<>"`), in-site paths, 6-digit hex colours, phone/email, `assetRef` (id pattern plus mandatory alt), inline rich text as data, CTA (link/scroll need a target), icon allow-list.
- `theme.ts`: font allow-list of 10 (5 Devanagari-capable, subsetting policy is S2), closed token enums, `reducedMotionRespected` is the literal `true`.
- `blocks.ts`: catalog of hero, about, services, pricing, gallery, testimonials, faq, team, stats, contact, map, cta-banner with variants and strict props; `sectionSchema` is a discriminated union, so an unknown type or variant is a validation error.
- `site-config.ts`: strict config plus cross-checks (unique page ids/paths/section ids, a `/` page, internal navigation targets exist).
- `parse.ts`: `parseSiteConfig` never throws. Bytes and depth are checked **before** schema work, then migrate, then validate; at most 25 issues are reported.
- `patch.ts`: closed operation set (updateBusiness/Theme/Page/Section, add/remove/moveSection), applied to a copy, accepted only if the **whole** config validates; prototype keys are never merged.
- `template.ts`: template with embedded config, category must match, onboarding manifest paths must resolve to a value of the right kind (own properties only).
- `json-schema/*.json`: generated; excluded from Prettier (`.prettierignore`); regenerate with `UPDATE_JSON_SCHEMA=1 pnpm --filter @platform/schema test`.

## 3. Findings

| ID   | Finding                                                                                                                                   | Consequence                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-1 | `hasBlockVariant('constructor', ...)` threw (inherited property on the catalog object). Found by the catalog test                         | Fixed with `Object.hasOwn`; test kept                                                                                                                      |
| S1-2 | `getAtPath(config, 'pages.length')` returned a value (arrays have an own `length`). Would let an onboarding manifest point at non-content | Fixed: arrays accept numeric segments only; test kept                                                                                                      |
| S1-3 | SRS 5.2 has no home for the floating WhatsApp/call button (FR-TPL-02)                                                                     | **Open decision:** added optional `footer.floatingAction` (`none` default). It is additive but changes the 5.2 contract; Owner to accept or require an ADR |
| S1-4 | SRS 5.2 allows images via "an allow-listed CDN". No asset domain exists until P3 (R2, DG-08), so `assetRef` takes asset ids only          | Reference templates use ids that do not resolve; the renderer shows a placeholder (S4). Widen in P3 with an ADR if needed                                  |
| S1-5 | JSON Schema cannot express the refinements (uniqueness, URL scheme, catalog membership)                                                   | Documented in `json-schema.ts`; the Zod schema stays the authority                                                                                         |
| S1-6 | `pnpm format:check` fails on 19 files on Windows, also on a clean `main` (line endings); none are in `packages/schema`                    | Not touched; CI on Linux is the reference                                                                                                                  |

## 4. Security, abuse and failure paths

- Untrusted inputs (AI, client, template package) enter only through `parseSiteConfig`, `applyPatch` or `templateSchema`; none trusts caller-supplied shapes.
- Render-DoS: byte and depth caps run first; item, page, section and string limits are in the schema; the issue list is capped.
- Tested rejections: HTML in every text kind, `javascript:`/`data:`/`vbscript:`/`http:`/`file:`/protocol-relative/credential URLs, bidi and control characters, unknown keys at every level, unknown type/variant, missing alt, path-like asset ids, off-list fonts, non-hex colours, reduced motion off, duplicate ids, missing home page, dangling navigation, cyclic and BigInt input, `__proto__` keys.
- No tenant data, no database, no network, no logging: the package is pure. RLS and audit are not touched.

## 5. Tests

38 tests in 7 files. Fuzz: 2,000 seeded mutations of a valid config (XSS corpus, wrong types, deleted keys, prototype keys) plus 500 random patches: no exception; every accepted config is markup-free; the fuzzer reaches the accept path more than 20 times, so the property is not vacuous. Typecheck and lint clean.

CI-equivalent run in a clean worktree: see section 6.

## 6. CI-equivalent run

(filled in after the clean-worktree run)

## 7. Compatibility, migration, rollback

New package code and one dependency (`zod` 4.6.6, already used by other packages; lockfile gains one importer entry). **No database change, no migration, no API/event change, no live action.** Rollback is a revert.

## 8. Open items for the Owner

1. Approve S1.
2. S1-3: accept `footer.floatingAction` as an additive 5.2 extension, or ask for an ADR.
3. S1-4: images by asset id only until P3, acceptable?
