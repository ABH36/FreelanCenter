# 04 — Template Engine and Renderer

**Status:** Phase 2 approved with conditions (2026-11-13). S1-S7 merged (#43-#54; S5b is live); S7 phase exit merged (#54); S8 hardening merged (#58); S8b revocable preview links merged (#59) and its migration is live; Phase 2 audit pending. Nothing is marked verified. **SRS:** FR-TPL-01..11.

## Outcome

Render many safe, fast, accessible sites from declarative configuration without per-site compilation. A template is tokens, page/section layout, block variants and onboarding manifest—not arbitrary code.

## Canonical contracts

`SiteConfig`, `Template`, block-props and `PatchOperation` have Zod schemas and exported JSON Schema. The block registry owns allowed variants, defaults, form metadata and migration versions. Every read validates configuration; invalid blocks render a safe fallback inside block-level error boundaries.

```text
Template definition → schema validation → Project SiteDraft
→ SiteRenderer(config, host context, version) → SSR HTML + CSS variables
```

Theme tokens compile to CSS variables; no runtime stylesheet rebuilding. Renderer respects responsive design, WCAG 2.1 AA, reduced motion and SEO metadata. Initial template categories and three reference templates are explicit P2 deliverables.

## Data model (P2 S5b)

`templates` (identity, status, owner) and `template_versions` (the immutable content: SiteConfig and onboarding manifest). `workspace_id` NULL is a platform built-in; otherwise a private template of that workspace (marketplace templates, P6, will be non-NULL with visibility `marketplace`). Tenants read and write only their own private templates (RLS, editor roles); built-ins are written by `app.operator_publish_builtin_template` (migrator only, audited, idempotent by content hash) through `pnpm --filter @platform/db db:seed-templates` from the reviewed seed file `packages/templates/seed/builtin-templates.json`. The catalogue is read through `app.list_catalog_templates()` and `app.get_catalog_template(id, version?)`, executable by tenants and visitors. Versions are numbered 1, 2, 3 without gaps and cannot be changed or deleted.

## Failure/security rules

- Reject unknown block types, unsafe URLs, unsupported fonts and malformed config.
- Version migrations are deterministic, tested and reversible or refuse safely.
- Preview links (FR-TPL-09, P2 S6) are public but expiring and `noindex`; no tenant secret is embedded. Form: `https://<PREVIEW_HOST>/p/<token>[/<page>]`, a signed claim set (template id, optional version, optional prospect name, issued and expiry time, at most 30 days; HMAC-SHA256, rotation with a previous secret), served only on the dedicated preview host, with demo content from the catalogue, a visible "demo content" banner, `Referrer-Policy: no-referrer` and every in-site link kept inside the link. Made in the dashboard on `/w/<slug>/templates` (capability `templates.preview`: owner, admin, editor; audited; 100 per person per day) or with `pnpm --filter @platform/db db:preview-link`. **Revocation (P2 S8b):** links made in the dashboard carry an id (`lid`) of a row in `template_preview_links` (no token, no prospect name stored); the Templates page lists them and owners, admins and editors can turn one off (final, audited); the sites app checks `app.is_preview_link_revoked` for links that carry an id and fails closed; a revocation reaches visitors within about 30 seconds. Links made before S8b or by the operator script have no id: they expire on their date.
- Render only a resolved immutable version in public live/staging paths.

## Evidence / handoff

Schema/property tests, migration fixtures, renderer snapshots, axe, visual-regression and mobile Lighthouse checks (`tests/quality`, CI job `quality`; see `docs/reports/PHASE_2_REPORT.md`), malformed-config fallback tests. Upstream: Modules 01–03. Downstream: editor, AI, onboarding, publish, export. Read SRS §5.2, §6.4 and ADR-004.
