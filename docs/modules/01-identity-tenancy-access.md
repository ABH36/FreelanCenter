# 01 — Identity, Tenancy and Access

**Status:** Planned (P1). **SRS:** FR-AUTH-01..08, FR-WS-01..05, SEC-01..07. **Owner:** Platform team.

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

Depends on the verified P1 Supabase RLS proof and chosen auth ADR. Unblocks every dashboard module. Before coding, read SRS §5.3, §6.1–6.2, ADR-003, ADR-006 and the live Spike-B evidence; do not bypass the verified transaction-local pattern.
