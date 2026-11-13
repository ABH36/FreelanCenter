# ADR-014: Tenant-site styling: one static stylesheet driven by per-site CSS variables

**Status:** Accepted (Owner acknowledgement 2026-11-13, Phase 2 report section 7b) · **Date:** 2026-11-13 · **SRS:** FR-TPL-04, FR-BLD-04, SEC-03, NFR-PERF-01/03

## Context

FR-TPL-04 asks for the theme "via CSS variables generated from `theme` tokens (Tailwind mapped to variables); no runtime stylesheet rebuild". Phase 2 built the CSS-variable half exactly; it did not use Tailwind on tenant sites.

## Decision

Tenant sites use one hand-written static stylesheet (`packages/blocks/src/blocks.css`, inlined) whose colours, fonts, radius, spacing, buttons and motion all come from CSS variables. Each site's variables are compiled from its own SiteConfig theme on every render (`@platform/ui` theme compiler). Tailwind remains the dashboard's tool.

## Why

- **Dynamic per site without a build:** a theme change is a config change; nothing is compiled per site (the point of FR-TPL-04).
- **Security:** the stylesheet is identical for every tenant and the per-site part is small, so both are allowed by exact hash in the CSP (no `'unsafe-inline'`, SEC-03).
- **Speed and accessibility:** a small, fixed stylesheet keeps the Lighthouse budgets; derived colours (links, muted text, text on bands) are guaranteed to meet WCAG AA by construction.

## Consequences

- The user's design freedom comes from **controls**, not from writing CSS: the Phase 3 theme editor (FR-BLD-04) edits the tokens, section management (FR-BLD-03) chooses blocks, variants and backgrounds, and the token set will grow (Owner direction: "CSS dynamic, so users can launch their own design").
- Free-form custom CSS is **not** offered in v1 (it would break the guarantees above and the support model). Adding it later needs its own decision.
- A new visual capability is added as a token or a block variant in the shared stylesheet, with tests (axe on every block, variant and band colour; visual regression).
