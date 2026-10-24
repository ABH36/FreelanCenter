# 02 — Workspaces and Project Lifecycle

**Status:** Workspace part implemented in P1 S5 (create with reserved slugs, `/w/<slug>` routes, settings, usage overview, members/roles, last-owner protection, deletion-request hook FR-WS-05/Q4); evidence `docs/reports/PHASE_1_S5_WORKSPACES_RBAC.md`. Projects, lifecycle, platform subdomains, audit viewer and notifications implemented in P1 S6 (awaiting Owner approval); evidence `docs/reports/PHASE_1_S6_PROJECTS_LIFECYCLE.md`. Template-based creation (SiteDraft) P2; published versions P3. **SRS:** FR-WS-01..05, FR-PRJ-01..06.

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

## Implementation (P1 S6)

Read `packages/workspaces/src/{lifecycle,projects,notifications,outbox,audit}.ts` and migration `20261024090000_p1_s6_projects_lifecycle`.

- **Transition table.** `PROJECT_TRANSITIONS` (TypeScript) equals `app.project_transition_roles` (database), asserted for all 36 status pairs. Draft→InReview (draft.edit), InReview→Draft (draft.edit), InReview→Approved (version.approve), Approved→Draft (draft.edit), Approved→Live and Live↔Paused (site.publish), any→Archived and Archived→Draft (projects.archive). Trigger `projects_guard` enforces it for every application write (P5002 invalid, 42501 wrong role), keeps archived projects read-only (P5003), requires an active platform subdomain for Live (P5006; P3 adds a published SiteVersion) and sets `created_by` and `status_changed_at` from the database.
- **Commands.** Transitions carry the status the user saw: a repeat is a no-op, a changed status is STALE, and a compare-and-set UPDATE makes concurrent transitions safe. Create and duplicate are idempotent on a request key (`projects.creation_key`, unique per workspace). Duplicate makes a Draft with its own subdomain and without the client contact.
- **Platform subdomains (Q9).** `app.allocate_platform_subdomain` is the only way to create one: `<label>.<sites_domain>`, the label if free, else `<label>-<4 random>`; reserved labels (the S5 list) always get the suffix and are blocked by a CHECK. `sites_domain` is a per-environment setting (`app.platform_settings`, set with `pnpm --filter @platform/db db:configure`). A rename does not move the address.
- **List (FR-PRJ-04).** Search name and city, filter by status (default: all but archived), category and client (name, phone, e-mail); keyset pages of 20; health = subdomain status and review pending. Unread leads arrive with leads (P5).
- **Notifications** (FR-NOT-01): see module 09. **Audit viewer** (FR-AUD-01): see module 03.
