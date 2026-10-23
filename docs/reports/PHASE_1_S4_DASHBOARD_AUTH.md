# Phase 1 · Slice 4: dashboard authentication

**Status:** Implemented and covered by automated tests; local CI-equivalent run recorded in section 6. GitHub Actions on PR #23: all checks green, product auth suite 54/54 ×3 in CI. **Not yet:** live Google round trip through the dashboard, real e-mail delivery (DG-10) and the production Turnstile keys (DG-16). Those are listed in section 8 with who has to do what.
**Date:** 2026-10-23 · **Branch:** `feat/p1-s4-dashboard-auth` · **Plan:** `docs/IMPLEMENTATION_PLAN.md`, Phase 1 slice plan, row S4.

## 1. Requirements

| Addressed                      | How                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-AUTH-01                     | E-mail + password sign-up with mandatory verification (1 h link), Google OAuth (state + PKCE S256, `prompt=select_account`), sign-in pages                                                                        |
| FR-AUTH-02                     | Host-only `HttpOnly; SameSite=Lax` cookie, `__Secure-` + `Secure` on https; new token per sign-in; fixation refused; "log out all devices"; password change revokes other sessions                                |
| FR-AUTH-03 (enrolment + guard) | TOTP enrolment (password, locally rendered QR, setup key, backup codes, confirm with a code), challenge at sign-in, 5-attempt/15-min lockout, disable, regenerate codes; `requireMfa()` guard in `@platform/auth` |
| FR-AUTH-04, SEC-11             | Reset token hashed at rest, single use, 15 min, revokes sessions; identical responses for known/unknown addresses; `Referrer-Policy: no-referrer` on every page/endpoint that carries a token in the URL          |
| FR-AUTH-07                     | Explicit per-endpoint limits persisted in `identity.rate_limits`, keyed **only** on the deployment's trusted client-IP header (`x-vercel-forwarded-for` on Vercel, Spike F F-5)                                   |
| SEC-09 (sign-up)               | Cloudflare Turnstile on sign-up, password-reset request and verification resend; official test keys in dev/CI (pass and fail proven); production refuses the test secret                                          |
| SEC-03 (CSRF/framing)          | Origin check pinned on (Spike F F-2), tested through the Next route handler; `frame-ancestors 'none'` + `X-Frame-Options: DENY` on the dashboard                                                                  |
| FR-AUD-01 (auth)               | 14 platform audit actions written through `app.record_platform_audit` (section 4)                                                                                                                                 |
| Dashboard shell                | Signed-in layout with server-side session check, nav (Overview, Projects, Security), user menu, empty states                                                                                                      |
| **Not in this slice:**         | Workspaces/RBAC/invitations (S5); MFA _enforcement_ call sites for payouts/white-label (P6/P7A); admin MFA (S8); Playwright E2E through a browser (S9); Sentry (S9)                                               |

## 2. What was built

- **`packages/auth`** (`@platform/auth`, new):
  - `config.ts`: `loadAuthConfig()` validates every variable at the first request (origin without path, https outside localhost, secret >= 32 chars, Google id/secret together, mail transport). In `VERCEL_ENV=production` it refuses capture mail and the Turnstile test secret.
  - `auth.ts`: `createAuth()` with every ADR-006 mandatory setting, Turnstile (`captcha` plugin), TOTP plugin, `accountLinking.requireLocalEmailVerified: true` (pre-account-takeover), a suspended-account block, the audit hooks, and plugin subpath imports only (F-8).
  - `audit.ts`: writer over `app.record_platform_audit`; returns the row id; never throws (logs `auth.audit.write_failed` at error level).
  - `mail.ts`: verification/reset mail, HTML-escaped, sent **after** the response (Next `after()`) so timing does not reveal whether an account exists; idempotency key = SHA-256 of kind + token.
  - `guards.ts`: `requireSession`, `requireMfa({ maxAgeSeconds })`.
- **`packages/providers`**: `EmailProvider` interface, Resend adapter (REST, no SDK, idempotency header, 10 s timeout) and a capture sink.
- **`apps/dashboard`**: `/api/auth/[...all]` (auth built lazily, so `next build` needs no secrets; responses get `no-store` and `x-correlation-id`); pages `/sign-up`, `/sign-in`, `/verify-email`, `/verified`, `/forgot-password`, `/reset-password` (drops the token from the address bar), `/two-factor`; signed-in `/`, `/projects`, `/settings/security`; `/dev/mailbox` (404 in production builds and with a real provider).
- **CI**: the `db-integration` job runs the product auth suite 3 times on the same database (Spike F's open flake). ESLint forbids `@platform/auth` in `apps/sites` (ADR-002).
- **Dependencies added:** `better-auth@1.7.12` (exact, as verified), `uqr@0.1.3` (zero-dependency QR encoder; the TOTP secret never leaves the browser), `server-only@0.0.1`.

## 3. Findings during the slice

| ID   | Finding                                                                                                                                                                                                                | Consequence                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| S4-1 | No database role can read platform audit rows (`workspace_id IS NULL`): `app_auth` may only call the definer function, tenants see their workspace only, and the operator role has no schema usage. This is by design. | Tests verify audit through the real writer and the row id it returns. The read path for platform events is S8 (`app_admin`).      |
| S4-2 | Better Auth 1.7's `twoFactor.enable` returns a union (`totp` or `otp`), unlike the shape Spike F relied on.                                                                                                            | The UI narrows on `method === 'totp'`.                                                                                            |
| S4-3 | With no trusted IP header, Better Auth puts every caller into one shared `no-trusted-ip` bucket.                                                                                                                       | Fails closed (shared limit) instead of open; test §5.3. A misconfigured header shows up as early 429s, not as missing protection. |
| S4-4 | Next 16 refuses a second `next dev` in the same directory.                                                                                                                                                             | The smoke run used a separate clean worktree; documented for contributors.                                                        |
| S4-5 | The account-linking default could let a Google sign-in attach to an attacker's unverified pre-registered password account.                                                                                             | `requireLocalEmailVerified: true` pinned explicitly (deprecated option, will become unconditional upstream) and asserted.         |

## 4. Security review

- **Mandatory configuration (ADR-006):** each row is asserted on the options the product builds (`config.test.ts`), and three are also proven behaviourally with **mutations** (section 7).
- **Enumeration:** sign-up, sign-in failure and reset request are byte-identical for existing and unknown addresses; mail is sent after the response; audit events for these paths carry no actor and no address.
- **Sessions:** server-side session check in the signed-in layout on every request; no cookie cache, so revocation is immediate (`/` redirects to `/sign-in` after "log out all"). Plain-text session tokens (F-3) remain an accepted residual, readable only by `app_auth`.
- **Suspended users:** `session.create.before` refuses `status <> 'active'` with 403 and audits `auth.sign_in.blocked`.
- **Audit actions:** `auth.user.created`, `auth.email.verified`, `auth.session.created`, `auth.session.revoked`, `auth.sessions.revoked_all`, `auth.sign_in.failed`, `auth.sign_in.blocked`, `auth.password.reset_requested`, `auth.password.reset`, `auth.password.changed`, `auth.mfa.enabled`, `auth.mfa.disabled`, `auth.mfa.challenge_failed`, `auth.oauth.linked`. The suite scans every event for `@`, the password and every mailed token.
- **Headers:** `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`; `no-referrer` on `/reset-password` and on `/api/auth/reset-password|verify-email`. A full CSP is P3.
- **Tenancy:** S4 adds no tenant query or server action, so nothing new is registered with the IDOR harness; S5 does.
- **Residual / accepted:** F-3 (plain session tokens), F-4 (verification JWT not single-use before first use), F-7 (weak timing difference, mitigated by limits). Threat model updated.

## 5. Schema, compatibility, migration and rollback

No migration: the `identity` schema and `app.record_platform_audit` came with S1. New environment variables are documented in `.env.example` (`AUTH_CLIENT_IP_HEADER`, `APP_NAME`, `EMAIL_TRANSPORT`, `TURNSTILE_*`). Rollback: revert the PR; no data shape changes.

## 6. Tests

| Suite                                                                                                                                                                                                                                                                                                        | Result |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `@platform/auth` product suite (`test/integration`): config 5 + flows 32 (sign-up/Turnstile 7, sessions 4, reset 5, TOTP 5, rate limits 3, Google 3, CSRF 1, suspension 1, audit 2, concurrency 1)                                                                                                           | 37/37  |
| `@platform/auth` unit (config validation, guards, mail)                                                                                                                                                                                                                                                      | 17/17  |
| `@platform/providers` unit (Resend adapter, capture sink)                                                                                                                                                                                                                                                    | 5/5    |
| HTTP smoke through a running `next dev` (Next 16.4.2): unauthenticated `/` -> `/sign-in`; headers; sign-up without/with Turnstile 400/200; unverified sign-in 403; mailbox link -> 302 `/` signed in; shell renders; evil origin 403; log out all -> `/sign-in`; bad link -> `/verified?error=INVALID_TOKEN` | pass   |
| `next build` with **no** environment variables (CI condition)                                                                                                                                                                                                                                                | pass   |

CI-equivalent run in a clean LF worktree on a fresh database volume: see section 6.1 (filled from the run log).

### 6.1 CI-equivalent run

2026-10-23, clean worktree (`core.autocrlf=false`) at commit `c717f35`, `pnpm install --frozen-lockfile`, Turborepo cache bypassed (`--force`), database volume destroyed and recreated (`db:down` + `db:up`). Same steps as `.github/workflows/ci.yml`:

| Step                                                                                          | Result                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `format:check`, `sync-plan:check`, lint + typecheck + unit tests (all packages), traceability | pass                                                       |
| `build` (both apps, `BETTER_AUTH_URL` unset)                                                  | pass                                                       |
| `db:bootstrap` twice (idempotent), `db:migrate`, `db:drift`, `db:verify`                      | pass                                                       |
| `@platform/db` integration, with coverage, then again on the non-fresh database               | 67/67 twice; coverage 96.7 % lines, 88.1 % branches        |
| Isolation suite / mutation check                                                              | 101/101; 7/7 mutations killed                              |
| **Product auth suite, 3 consecutive runs on the same database**                               | **54/54, 54/54, 54/54** (37 integration + 17 unit per run) |

## 7. Mutation check (manual, this slice)

Each mutation was applied to `packages/auth/src/auth.ts` and the behavioural suite (`auth.test.ts`, without the config assertions) was run:

| Mutation                                                        | Result                |
| --------------------------------------------------------------- | --------------------- |
| M1 `disableOriginCheck: true` (F-2)                             | killed (2 tests fail) |
| M2 IP header `x-forwarded-for` instead of the trusted one (F-5) | killed (6 tests fail) |
| M3 `storeIdentifier: 'plain'` (F-1)                             | killed (1 test fails) |

## 8. Open items and decisions for the Owner

| Item                                 | Needed from                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live Google round trip via dashboard | Owner: sign in with Google on the running dashboard once (redirect URI `http://localhost:3000/api/auth/callback/google` is already registered from Spike F).      |
| ADR-012 / DG-10 e-mail               | Owner (2026-10-23): no own domain yet, so ADR-012 stays Proposed and every environment uses capture mail. Real delivery waits for a verified sending domain.      |
| DG-16 production Turnstile           | Widget created and site key in Vercel (2026-10-23). Owner: add `TURNSTILE_SECRET_KEY` (Production + Preview) by hand; then one live widget solve on a deployment. |
| Branch protection                    | No change needed: the auth suite runs inside the already-required `db-integration` job.                                                                           |
