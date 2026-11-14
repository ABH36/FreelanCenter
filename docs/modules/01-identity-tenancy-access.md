# 01 — Identity, Tenancy and Access

**Status:** Partially implemented (P1). Authentication (FR-AUTH-01..04, -07) landed in P1 S4: `packages/auth`, dashboard pages, product auth suite; evidence `docs/reports/PHASE_1_S4_DASHBOARD_AUTH.md`. Workspaces, membership, RBAC (`authorize()` + tested SRS 7 matrix) and invitations (FR-AUTH-05, -06, -08, FR-WS-01..03, SEC-10) landed in P1 S5: `packages/workspaces`, `@platform/auth/rbac`, migration `p1_s5_workspaces_rbac`, dashboard `/w/<slug>` routes and `/invite/<token>`; evidence `docs/reports/PHASE_1_S5_WORKSPACES_RBAC.md` (implemented, pending phase audit). A TOTP challenge after Google sign-in and after the e-mail-verification auto sign-in (DG-22, ADR-006 addition; `packages/auth/src/sign-in-challenge.ts`) is built and awaiting Owner approval and its live round trip: `docs/reports/PHASE_1_DG22_GOOGLE_TOTP.md`. **SRS:** FR-AUTH-01..08, FR-WS-01..05, SEC-01..07. **Owner:** Platform team.

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
- A user with 2FA on gets no session from any sign-in path (password, Google, e-mail-verification link) until a valid TOTP or backup code; the session is held behind the plugin's challenge state (ADR-006, DG-22).
- Authorization is checked at service/API boundaries; UI hiding is not authorization.
- Duplicate callback/invite acceptance must be safe and idempotent.
- `BETTER_AUTH_SECRET` encrypts two-factor secrets, backup codes and OAuth tokens. It is never replaced in place, because every factor written under it would become unreadable (P3 S0 finding S0-1). Keys are rotated through versioned keys, as described in the runbook below.

## Runbooks

**Rotating the auth key (versioned keys, ADR-006 P3 addition).**

1. Generate a new key (32 random bytes) on the operator's machine.
2. Set `BETTER_AUTH_SECRETS=<n>:<new key>` for the environment, keeping `BETTER_AUTH_SECRET` unchanged. If versions already exist, put the new one first and keep the old ones: `<n>:<new>,<n-1>:<old>`.
3. Redeploy. New ciphertext is written with version `<n>`; unlabelled rows still decrypt with `BETTER_AUTH_SECRET`, and labelled rows with their own version.
4. Expect every user to be signed out once, because cookies are signed with the current key.
5. A version, or the legacy `BETTER_AUTH_SECRET`, is removed only after no stored row still needs it. A retired key makes its factors unreadable (proved in the product auth suite, section 9).

Preview and Production use different keys; see DG-30 for the shared-database consequence.

**A user's two-factor factor cannot be read.**

- Symptom: on the two-factor step the user sees "We could not check codes for your account right now…". The function log shows `ERROR [Better Auth]: Error Error: invalid tag` on `/api/auth/two-factor/verify-totp` or `/verify-backup-code`.
- Cause: the factor was encrypted with a key this deployment does not hold, for example one enrolled on a Preview deployment that shares the database, or after a key was removed too early.
- Fix:
  1. Confirm the person's identity through a channel the account already owns: a reply from the account's e-mail address, plus one detail only the account holder knows (workspace name, a recent project).
  2. Get approval from a second person; until the support role exists (P5), that is the Owner.
  3. Run `node scripts/ops/reset-user-2fa.mjs --email <address>`, which is a dry run, then the same command with `--apply`. It deletes the factor and clears the flag in one transaction and writes `auth.mfa.disabled` with the reason `factor_unreadable_after_secret_change`.
  4. Ask the user to sign in with their password and enrol again immediately.
  5. Record the request, the identity check and the audit id in the support log.
- Never: send a "disable 2FA" link by e-mail (that would reduce 2FA to e-mail possession), or reset without the identity check.

## Acceptance evidence

Unit-test permission matrix and token expiry. Integration-test registration, OAuth callback, MFA, invite race, session revocation and cross-workspace denial. RLS suite must prove a user cannot access another workspace after connection reuse. Record audit events and redacted structured logs.

## Dependencies / handoff

Depends on the verified P1 Supabase RLS proof and chosen auth ADR. The auth proof is `docs/spikes/SPIKE_F_BETTER_AUTH.md`: reuse its `identity` schema / `app_auth` role split, the membership `self_read` bridge and the mandatory Better Auth configuration listed in ADR-006. Unblocks every dashboard module. Before coding, read SRS §5.3, §6.1–6.2, ADR-003, ADR-006 and the live Spike-B evidence; do not bypass the verified transaction-local pattern.
