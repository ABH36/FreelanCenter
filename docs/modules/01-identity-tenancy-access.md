# 01 — Identity, Tenancy and Access

**Status:** Partially implemented (P1). Authentication (FR-AUTH-01..04, -07) landed in P1 S4: `packages/auth`, dashboard pages, product auth suite; evidence `docs/reports/PHASE_1_S4_DASHBOARD_AUTH.md`. Workspaces, membership, RBAC (`authorize()` + tested SRS 7 matrix) and invitations (FR-AUTH-05, -06, -08, FR-WS-01..03, SEC-10) landed in P1 S5: `packages/workspaces`, `@platform/auth/rbac`, migration `p1_s5_workspaces_rbac`, dashboard `/w/<slug>` routes and `/invite/<token>`; evidence `docs/reports/PHASE_1_S5_WORKSPACES_RBAC.md` (implemented, pending phase audit). **SRS:** FR-AUTH-01..08, FR-WS-01..05, SEC-01..07. **Owner:** Platform team.

## Outcome and scope

Securely identify people, map them to one or more workspaces, and authorize every dashboard mutation. This module includes email/password, Google OAuth, sessions, MFA, invitations, workspace creation/switching, roles and suspension. It does not include enterprise SSO/SCIM unless a post-v1 ADR adds it.

## Contracts and data

`User ↔ Membership ↔ Workspace` is mandatory; credits, plans and billing belong to `Workspace`, never `User`. Roles are `PlatformAdmin`, `Owner`, `Admin`, `Editor`, `Viewer`; `Client` is project-scoped. The server derives active workspace from a membership and never trusts a workspace ID supplied by a browser. Required auditable actions: sign-in/out, MFA changes, invitation lifecycle, role/owner change, suspension and workspace deletion request.

## Critical flows

```text
Sign in → verified identity → session rotation → membership lookup
→ choose/restore workspace → authorize action → tenant-scoped transaction → audit event

Invite → signed/hashed, expiring token → accept identity → create membership once
→ invalidate token → notify inviter
```

Auth failure responses must not reveal whether an account exists. Login, reset, MFA and invitation endpoints require rate limits. Suspension blocks dashboard writes and applies the SRS-defined site policy.

## Security and failure rules

- Secure httpOnly/SameSite cookies; session rotation and “log out all devices”.
- Password-reset and magic tokens: random, short-lived, single-use, hashed at rest.
- MFA is mandatory before enabling payout or white-label functions.
- Authorization is checked at service/API boundaries; UI hiding is not authorization.
- Duplicate callback/invite acceptance must be safe and idempotent.

## Acceptance evidence

Unit-test permission matrix and token expiry. Integration-test registration, OAuth callback, MFA, invite race, session revocation and cross-workspace denial. RLS suite must prove a user cannot access another workspace after connection reuse. Record audit events and redacted structured logs.

## Dependencies / handoff

Depends on the verified P1 Supabase RLS proof and chosen auth ADR. The auth proof is `docs/spikes/SPIKE_F_BETTER_AUTH.md`: reuse its `identity` schema / `app_auth` role split, the membership `self_read` bridge and the mandatory Better Auth configuration listed in ADR-006. Unblocks every dashboard module. Before coding, read SRS §5.3, §6.1–6.2, ADR-003, ADR-006 and the live Spike-B evidence; do not bypass the verified transaction-local pattern.
