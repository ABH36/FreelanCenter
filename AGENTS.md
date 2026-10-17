# AI and Contributor Operating Rules

## Source of truth

`SRS.md` is the frozen product-requirement source of truth. `DEVELOPMENT_PLAN.md` is a byte-identical mirror and must not be edited directly. Material requirement or architecture changes require an ADR and Owner approval.

Read [docs/governance/DOCUMENTATION_INDEX.md](docs/governance/DOCUMENTATION_INDEX.md) before planning or implementing work. Do not treat `docs/enterprise-enhancements/` as a specification: it is an untracked exploratory proposal set with claims that conflict with the actual Phase-0 implementation state.

## Current delivery state

The repository is at Phase 0 approved-with-conditions. No product feature is implemented. The live Supabase `ap-south-1` RLS/pooler proof passed on 2026-10-16 (see `docs/spikes/SPIKE_B_RLS_POOLING.md`), so product Prisma schema work is permitted. The Phase-1 Vercel preview-deployment proof passed on 2026-10-17 (see `docs/reports/PHASE_1_DG02_VERCEL_PREVIEW.md`); remaining early controls are tracked in the gap register.

## Required implementation discipline

- Work on one module/requirement slice at a time and read the linked module contract, SRS requirements, ADRs and upstream contracts first.
- Every tenant-owned record has `workspace_id`; every normal tenant query/mutation runs in the transaction-scoped RLS pattern. Never trust a browser-provided workspace ID.
- Use server-side authorization, idempotency keys for retried external mutations, validated state transitions, structured redacted logging and audit events for sensitive actions.
- AI output, client submissions and template packages are untrusted proposals; validate and explicitly approve them before applying changes.
- Keep published SiteVersions immutable. Do not add arbitrary template JavaScript or raw script injection.
- Report requirement IDs, tests/evidence, security review, migrations/contracts and unresolved decisions in every handoff.

## Documentation updates

Update the target module document and traceability/phase evidence when implementation changes reality. Never mark a feature “implemented” without code, automated evidence and phase-report verification.
