# Phase 1 · DG-22: TOTP challenge at Google sign-in

**Status:** Implemented and covered by automated tests; clean-worktree CI-equivalent run in section 6.1. **Approved by the Owner on 2026-10-31** (report and decisions D1-D5). Live Google round trip on a Preview: **not yet run** (section 6.2).
**Date:** 2026-10-31 · **Branch:** `feat/dg22-google-totp-challenge` (from `main` 3cbc9e0, whose CI was green) · **Gap register:** DG-22 · **ADR:** 006 (DG-22 addition).

## 1. Requirements

| Addressed                                      | How                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-AUTH-03 (TOTP MFA)                          | A user with 2FA on gets no session from Google sign-in (OAuth callback and ID-token form) or from the e-mail-verification auto sign-in until a valid TOTP or backup code. Owner decision 2026-10-31                                                                                      |
| FR-AUTH-02, -07 (sessions, brute-force limits) | The challenge is the plugin's own, so the attempt counter, the 5-wrong-codes / 15-minute lockout and the `/two-factor/*` rate limit apply unchanged                                                                                                                                      |
| FR-AUD-01 (auth events)                        | New `auth.mfa.challenge_issued`; failed-challenge rows now carry the user id (they had no actor before a session exists)                                                                                                                                                                 |
| **Not in this slice**                          | Enrolment without a password (D14 stays), trusted-device cookies (not honoured on these paths), passkeys / magic link / email OTP (not enabled), forcing 2FA for anyone (recommended only, FR-AUTH-03), payout / white-label MFA (P6/P7A, must use the step-up), migration (none needed) |

## 2. What was built

- `packages/auth/src/sign-in-challenge.ts` (new): `holdSessionForTotp`, `createsSessionOutsidePluginHook`, `safeReturnTo`, `pendingChallengeUserId`.
- `packages/auth/src/auth.ts`: the `hooks.after` middleware calls the hold first for `/callback/:id`, `/sign-in/social` and `/verify-email`; failed-challenge audit rows get the user from the challenge cookie.
- `packages/auth/src/audit.ts`: action `auth.mfa.challenge_issued`.
- `apps/dashboard/app/(auth)/two-factor/two-factor-form.tsx`: after a valid code, go to the same-origin `callbackURL` the server put in the URL (anything else: `/`).
- Docs: ADR-006 DG-22 addition (design, S8-1 interaction, upgrade re-check), module 01, threat model row, gap register DG-22, S8 report note.

**How the session is held.** When the request created a session for a user with `twoFactorEnabled`, the hook deletes that session row before the response leaves, drops its cookies, and creates the plugin's challenge state (signed `two_factor` cookie, `2fa-<id>` row, `2fa-attempts-<id>` counter), then replaces the response: a redirect to `/two-factor?callbackURL=<path>`, or `{ twoFactorRedirect: true }` for JSON forms. `/two-factor/verify-totp` and `/verify-backup-code` create the session only after a valid code.

### 2.1 Decisions taken in this slice (for review)

| #   | Decision                                                                                                  | Why                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Reuse the plugin's challenge state and verify endpoints; no custom table or endpoint                      | Lockout, counter, rate limit, backup codes and audit come for free and behave exactly like the password flow; no migration               |
| D2  | Include `/verify-email` and the ID-token `/sign-in/social` (Owner: "haa shamil karo" for `/verify-email`) | Same gap class: a full session without a code                                                                                            |
| D3  | The session row exists for the milliseconds of the request                                                | Better Auth treats a missing session in the callback as an error and could not then issue a challenge; the token never leaves the server |
| D4  | Trusted-device cookies are not honoured on these paths                                                    | The UI never sets `trustDevice`; skipping the code would reopen the gap                                                                  |
| D5  | Failed-challenge audit rows take the actor from the challenge cookie                                      | Before this, a wrong code during a pending challenge was audited without a user, so a lockout could not be attributed                    |

## 3. Findings during the slice

| #      | Finding                                                                                                                                                                                                                                                                                         | Resolution                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| DG22-1 | In the hook, `ctx.context.returned` for a callback redirect is better-call's own error, not an instance of `better-auth`'s `APIError`; `instanceof` skipped the redirect branch and the user got a session. Found by the first test run                                                         | `isAPIError` from `better-auth/api`; the tests above fail without it                 |
| DG22-2 | `ctx.path` for the callback is the route pattern `/callback/:id`, not the concrete path                                                                                                                                                                                                         | Matcher uses the `/callback/` prefix; unit-tested with both forms                    |
| DG22-3 | Failed TOTP rows during a pending challenge had `actor_user_id` NULL (also for password sign-in since S4)                                                                                                                                                                                       | D5                                                                                   |
| DG22-4 | Stripping the queued session `Set-Cookie` is defence in depth: with the strip disabled the response still carries no live session cookie, because the same-name expiry cookie supersedes it. The mutation "no strip" therefore survives; the other mutation (no hook) is killed by 6 of 8 tests | Strip kept; stated here rather than claimed as tested                                |
| DG22-5 | Other session-creating paths in Better Auth 1.7.12 belong to plugins that are not enabled (anonymous, magic link, email OTP, phone, SIWE, device authorization, admin impersonation)                                                                                                            | Listed in the ADR re-check; enabling any of them requires adding it to the hook list |

## 4. Security review

- **Session hold.** No session cookie reaches the browser and no session row survives the request (tests assert both, on callback, ID-token and verify-email). The pending state is a hashed verification row plus a signed httpOnly cookie, valid 10 minutes, single use.
- **S8-1 oracle stays closed.** The S8-1 `before` hook refuses HTTP verify only when a session exists; a pending challenge has none, so the verify endpoints serve the challenge, and a signed-in 2FA session is still refused (403, tested after a Google sign-in).
- **Lockout / rate limit / audit.** Five wrong codes after Google lock the factor, a correct code is then refused, and a fresh Google sign-in does not reset the lock; the five failures are audited with the user id. Backup code passes once and cannot be reused.
- **Open redirect.** Only a same-origin path survives into `callbackURL` (server `safeReturnTo`, client check on `/` and not `//` or `\`); Better Auth's own origin check on the Google `callbackURL` is unchanged and still tested.
- **Unchanged flows.** 2FA-off users (existing and new Google users), account linking and the S4-6 `id_token` drop are tested to behave as before; the admin step-up is untouched (admin and S8 suites pass).
- **Privacy.** The new audit row holds the user id and a path label, no address or token (asserted).
- **Residual.** Enrolment still needs a password (D14); a Google-only user cannot enable 2FA until they set one.

## 5. Schema, compatibility, migration and rollback

No schema change, no migration, no new environment variable. API: for a 2FA user, `/callback/google` answers 302 to `/two-factor?callbackURL=…` instead of the callback target, and the JSON forms return `twoFactorRedirect`; clients that already handle the password challenge need nothing new. Rollback: revert the commit; the challenge rows are ordinary verification rows that expire in 10 minutes.

## 6. Tests

New product auth tests (`packages/auth/test/integration/google-2fa.test.ts`, 8 tests; `unit.test.ts`, 2 tests):

1. Google callback, 2FA on: 302 to `/two-factor` with the return path, no session cookie, no session row, challenge cookie, `get-session` null, audit row without address.
2. Valid code completes it; a browser without the challenge cookie gets nothing.
3. S8-1: a signed-in 2FA session is still refused over HTTP.
4. Five wrong codes lock; correct code refused; failures audited with the user; fresh Google sign-in does not reset the lock.
5. Backup code once; reuse refused.
6. 2FA off: callback target, session, no challenge; linking works, `id_token` still null; a brand-new Google user is signed in.
7. ID-token form of `/sign-in/social`: `twoFactorRedirect`, no session.
8. E-mail-verification auto sign-in (JSON and redirect forms).
9. Unit: matcher paths and `safeReturnTo`.

Google is faked at `fetch` (token endpoint, JWKS) with an RSA key generated at test start; nothing secret is committed.

### 6.1 CI-equivalent run

2026-10-31 15:28-15:50 IST, clean worktree (`core.autocrlf=false`) at `main` 3cbc9e0 plus the uncommitted DG-22 working tree (nothing was committed before this report), `pnpm install --frozen-lockfile`, Turborepo cache bypassed (`turbo run … --force`), database volume dropped and recreated. Same steps as `.github/workflows/ci.yml` plus `test:perf`:

| Step                                                         | Result                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| format:check, sync-plan:check, traceability (no diff)        | pass                                                                                                                                                                                             |
| lint / typecheck / test / build (15 / 15 / 14 / 3 tasks)     | pass                                                                                                                                                                                             |
| db generate, bootstrap ×2, migrate, configure, drift, verify | pass (db:verify green)                                                                                                                                                                           |
| `@platform/db` integration with coverage, then again         | 99/99 and 99/99                                                                                                                                                                                  |
| Isolation suite / mutation check                             | 189/189 / pass                                                                                                                                                                                   |
| **Product auth suite, three runs**                           | **191/191 each** (was 181 at 3cbc9e0; +8 integration, +2 unit)                                                                                                                                   |
| Workspace / jobs / hosting suites                            | 124/124 / 7/7 / 21/21                                                                                                                                                                            |
| gitleaks over the working tree (repository config)           | no hits in tracked or changed files; 12 hits only in gitignored local `.env.local*` files                                                                                                        |
| NFR-PERF-04 load test                                        | **fail, environmental:** two runs, highest p95 729 and 601 ms; clean `main` 3cbc9e0 on the same machine and database: 624 ms. Workspaces code, not auth. CI does not run it (same finding as S8) |

Mutation checks on the new tests: removing the hook (matcher never matches) fails 6 of 8; skipping the cookie strip is not detected (DG22-4).

### 6.2 Live run

**Not yet run.** Needs the PR Preview (section 8): Google round trip for the Owner's account with 2FA on (challenge page, wrong code, correct code, return path), and for an account with 2FA off (no change); audit rows `auth.mfa.challenge_issued` / `auth.mfa.challenge_failed`.

## 7. Better Auth upgrade re-check

Recorded in ADR-006 (DG-22 addition): whether the plugin now covers the callback, the list of session-creating paths, and the DG-22 tests in the product suite.

## 8. Open items and decisions for the Owner

| Item                        | State                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve DG-22 (this report) | **Approved by the Owner on 2026-10-31** (D1-D5)                                                                                                                                                                                          |
| Live round trip             | After the PR opens: move the Preview variables and the Inngest sync to the new branch (message for the browser extension is prepared), then the Owner drives Google sign-in. No database migration, so no live migration approval needed |
| Perf test                   | Environmental failure on this machine, same on `main`; live measurement stays an S9 item                                                                                                                                                 |
| Gap register                | DG-22 stays open until approval and the live run                                                                                                                                                                                         |
