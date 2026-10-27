# ADR-006: Authentication - Better Auth, self-managed

**Status:** Accepted (verified) - Owner ratified 2026-10-22 with the mandatory configuration below; evidence Spike F (automated suite + live Google round trip) · **Date:** 2026-09-21 · **SRS:** 6.1, D3

## Context

Needs: email+password with verification, Google OAuth, TOTP MFA, sessions with rotation, password reset, brute-force limits, multiple workspaces per user. A managed vendor (Clerk) charges per monthly active user, which is punishing for a B2B2C product with many small clients.

## Decision (working assumption)

**Better Auth**, storing users/sessions in our Postgres, with our own `Membership` tables (roles per workspace). Auth.js is the fallback. Clerk only if the Owner prefers speed over cost control.

## Verification (Spike F, DG-05)

Better Auth 1.7.12 + Prisma 7.10 (`adapter-pg`) through transaction-mode PgBouncer passed 36/36 tests on seven fresh-volume runs: verified-email sign-up, generic errors, hashed single-use expiring reset tokens, rotation and fixation resistance, log-out-all, TOTP with encrypted secrets and lockout, per-IP rate limits, Google authorization URL with state + PKCE and forged-state rejection, CSRF/origin checks, 40 + 120 concurrent auth operations with 0 errors, and the session -> membership bridge under RLS. Evidence: [docs/spikes/SPIKE_F_BETTER_AUTH.md](../spikes/SPIKE_F_BETTER_AUTH.md).

**Persistence pattern.** Identity tables are global and live in schema `identity`, readable only by a dedicated role `app_auth`; the tenant role `app_user` has no access to it. A signed-in user reaches workspaces through `membership`, which has a read-only `self_read` policy on a transaction-local `app.user_id` (NULLIF form) in addition to the workspace policy.

**Mandatory configuration** (each one closes a spike finding):

| Setting                                                                           | Reason                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `verification.storeIdentifier: 'hashed'`                                          | default stores reset tokens/OAuth state in plain text (F-1, FR-AUTH-04)                                      |
| `advanced.disableOriginCheck: false`                                              | default turns CSRF/origin checks off under test runners (F-2)                                                |
| `advanced.ipAddress` set to the deployment's trusted client-IP header             | an untrusted `x-forwarded-for` lets clients evade the rate limit (F-5)                                       |
| explicit `rateLimit.customRules` and `twoFactor.accountLockout`                   | defaults are generous (F-6)                                                                                  |
| `emailAndPassword.requireEmailVerification`, `revokeSessionsOnPasswordReset`      | FR-AUTH-01/04                                                                                                |
| `account.encryptOAuthTokens: true`, plus dropping `id_token` in the account hooks | provider access/id tokens are otherwise stored in plain text (F-10); 1.7.12 never encrypts `id_token` (S4-6) |
| `telemetry.enabled: false`                                                        | no undeclared processor                                                                                      |
| plugin subpath imports only                                                       | the plugins barrel is very slow to load (F-8)                                                                |
| exact version pin; re-run Spike F on every Better Auth upgrade                    | two unsafe defaults (F-1, F-2) were only visible by testing                                                  |

## Still not verified

- ~~Mounting inside `apps/dashboard`~~: done in P1 S4 (`apps/dashboard/app/api/auth/[...all]/route.ts`), smoke-tested through a running Next 16.4.2 server; the product auth suite (successor of the Spike F suite) asserts every mandatory setting and runs 3x in CI. Evidence: `docs/reports/PHASE_1_S4_DASHBOARD_AUTH.md`.
- Session tokens are stored in plain text (F-3); accepted with the role split and expiry as controls.

## P1 S8 addition (pending Owner approval with the S8 report)

- **S8-1:** with a signed-in session, Better Auth 1.7.12's `/two-factor/verify-totp` and `/two-factor/verify-backup-code` apply no lockout and no attempt limit (only the `/two-factor/*` rate limit), so for a user who already has 2FA they are an online oracle for the current code. A `before` hook in `packages/auth/src/auth.ts` now refuses both over HTTP (403 `TWO_FACTOR_ALREADY_ENABLED`) when the session's user has 2FA on; enrolment (2FA not yet on) and the sign-in challenge (no session) are unchanged. Asserted in the product auth suite. Re-check on every Better Auth upgrade, like S4-6.
- **Google sign-in skips the TOTP challenge** (the plugin's sign-in hook matches `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number` only). The admin console therefore asks for its own TOTP step-up per session (`verifySessionTotp`, a server-side `auth.api.verifyTOTP` call) with a database-enforced lockout. Payout and white-label MFA (P6/P7A) must use the same step-up rather than `requireMfa` alone.

## Consequences

Owning auth means owning its security. The security review checklist in the plan covers token hashing, enumeration resistance, and lockout. Every Better Auth upgrade re-runs Spike F's suite (or its product successor) before merge.
