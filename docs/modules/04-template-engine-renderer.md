# 04 — Template Engine and Renderer

**Status:** Planned (P2). **SRS:** FR-TPL-01..11.

## Outcome

Render many safe, fast, accessible sites from declarative configuration without per-site compilation. A template is tokens, page/section layout, block variants and onboarding manifest—not arbitrary code.

## Canonical contracts

`SiteConfig`, `Template`, block-props and `PatchOperation` have Zod schemas and exported JSON Schema. The block registry owns allowed variants, defaults, form metadata and migration versions. Every read validates configuration; invalid blocks render a safe fallback inside block-level error boundaries.

```text
Template definition → schema validation → Project SiteDraft
→ SiteRenderer(config, host context, version) → SSR HTML + CSS variables
```

Theme tokens compile to CSS variables; no runtime stylesheet rebuilding. Renderer respects responsive design, WCAG 2.1 AA, reduced motion and SEO metadata. Initial template categories and three reference templates are explicit P2 deliverables.

## Failure/security rules

- Reject unknown block types, unsafe URLs, unsupported fonts and malformed config.
- Version migrations are deterministic, tested and reversible or refuse safely.
- Preview links are public but expiring and `noindex`; no tenant secret is embedded.
- Render only a resolved immutable version in public live/staging paths.

## Evidence / handoff

Schema/property tests, migration fixtures, renderer snapshots, axe and mobile Lighthouse tests, malformed-config fallback tests. Upstream: Modules 01–03. Downstream: editor, AI, onboarding, publish, export. Read SRS §5.2, §6.4 and ADR-004.
