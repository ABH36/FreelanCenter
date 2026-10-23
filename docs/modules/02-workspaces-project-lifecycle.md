# 02 — Workspaces and Project Lifecycle

**Status:** Workspace part implemented in P1 S5 (create with reserved slugs, `/w/<slug>` routes, settings, usage overview, members/roles, last-owner protection, deletion-request hook FR-WS-05/Q4); evidence `docs/reports/PHASE_1_S5_WORKSPACES_RBAC.md`. Projects and lifecycle: planned for S6 (P1; extended P3/P5). **SRS:** FR-WS-01..05, FR-PRJ-01..06.

## Outcome and scope

Provide the agency’s secure operational boundary and a lifecycle-managed container for each client site. A project owns its draft, versions, domains, leads, assets and integrations. It does not duplicate templates; a project starts from a template in P2.

## State and contracts

Project lifecycle is `Draft → InReview → Approved → Live → Paused → Archived`. Only explicit, server-side transition commands may change it; each validates permissions, prerequisites and audit logging. A project has exactly one mutable `SiteDraft`; publishing creates immutable versions (Module 06). `workspace_id` must be denormalized on every project-owned record with composite FKs.

```text
Authorized member → choose template → create Project + SiteDraft
→ edit/onboard changes → review → approved version published → Live
→ pause/archive (retention policy applies)
```

## Rules and failures

- List/search/filter results are tenant-scoped, paginated and show derived health only from authorized data.
- Deletion/export is a scheduled, auditable privacy workflow with grace period; no hard cascade in a request handler.
- Project transfer is post-MVP/COULD: require recipient acceptance and a transactionally safe migration plan before enabling.
- Status updates, duplication and archival must be idempotent.

## Acceptance evidence

Transition-table unit tests; API tests for role denial and workspace isolation; integration tests for project creation, archive/delete scheduling and a concurrent transition race. UI tests cover empty/loading/error states and accessibility.

## Handoff

Upstream: Module 01. Downstream: templates, editor, publishing, onboarding, leads, domains, billing. Read SRS §5.1, §6.2–6.3 and privacy inventory before schema design.
