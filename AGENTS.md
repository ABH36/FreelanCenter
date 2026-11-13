# AI and Contributor Operating Rules

## Source of truth

`SRS.md` is the frozen product-requirement source of truth. `DEVELOPMENT_PLAN.md` is a byte-identical mirror and must not be edited directly. Material requirement or architecture changes require an ADR and Owner approval.

Read [docs/governance/DOCUMENTATION_INDEX.md](docs/governance/DOCUMENTATION_INDEX.md) before planning or implementing work. Do not treat `docs/enterprise-enhancements/` as a specification: it is an untracked exploratory proposal set with claims that conflict with the actual Phase-0 implementation state.

## Current delivery state

Phases 0, 1 and 2 are approved with conditions (Phase 2 on 2026-11-13; see `docs/reports/PHASE_2_REPORT.md`). Implemented and live: auth (ADR-006 mandatory configuration), workspaces and RBAC, projects, host routing, admin console, audit, the template engine and renderer, three reference templates (version 2 live), preview links (revocable, live migrations applied). Next: Phase 3 (Builder/Editor), starting with S0, the private technical go-live of the dashboard (`docs/governance/DASHBOARD_GO_LIVE_PLAN.md`). Product direction: this product serves local-business websites with lead capture; heavy apps (full e-commerce, ride-hailing) are a separate future product that will integrate through services, not features here. Open conditions and decisions are tracked in the gap register and the phase reports.

## Required implementation discipline

- Work on one module/requirement slice at a time and read the linked module contract, SRS requirements, ADRs and upstream contracts first.
- Every tenant-owned record has `workspace_id`; every normal tenant query/mutation runs in the transaction-scoped RLS pattern. Never trust a browser-provided workspace ID.
- Use server-side authorization, idempotency keys for retried external mutations, validated state transitions, structured redacted logging and audit events for sensitive actions.
- AI output, client submissions and template packages are untrusted proposals; validate and explicitly approve them before applying changes.
- Keep published SiteVersions immutable. Do not add arbitrary template JavaScript or raw script injection.
- Report requirement IDs, tests/evidence, security review, migrations/contracts and unresolved decisions in every handoff.

## Documentation updates

Update the target module document and traceability/phase evidence when implementation changes reality. Never mark a feature “implemented” without code, automated evidence and phase-report verification.
