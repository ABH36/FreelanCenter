# Dashboard go-live plan (DG-27) and in-region performance measurement (DG-28)

**Status:** decision taken by Claude on the Owner's delegation (2026-11-12: "jo best ho, enterprise aur right approach wo karo"); to be confirmed by the Owner in the Phase 2 report. Nothing in this plan has been executed. Every live change below needs the Owner's approval at the time, and every secret is set by the Owner, never pasted in chat.

## 1. The problem

The dashboard Production project has no `DATABASE_URL` (app_user), `DATABASE_URL_AUTH`, `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL`, and no working e-mail path, so `/sign-in` answers 500 on the production alias. Consequences: the Templates page cannot be used live, a valid live preview link cannot be made (DG-26), and the dashboard API cannot be measured in region (NFR-PERF-04, DG-28). The obvious "go live with everything" needs a sending domain (DG-10) and a registered domain (DG-11), which are purchases and decisions that belong with the public launch, not with Phase 2.

## 2. Decision: two stages

**Stage A, a private technical go-live (before Phase 3 starts).** The production dashboard works for exactly one person, the Owner, without any domain purchase. It exists to prove the whole chain on real infrastructure (Vercel, Supabase `ap-south-1`, Upstash, Cloudflare Turnstile, the e-mail provider) and to measure it.

**Stage B, the public go-live (with Phase 3 and the domain work).** Needs a registered domain (DG-11), a verified sending domain (DG-10), the production Turnstile hostnames for the final domain (DG-16), legal pages and the launch gate (Phase 8). Not started here.

Why this order: it removes the only blocker of C1 (the in-region number and the live preview check) with the smallest possible live surface, keeps the purchases where they belong, and makes Phase 3 start from a deployed, observed dashboard instead of a theoretical one.

## 3. Stage A in detail

### 3.1 Owner actions (secrets, with steps given at the time; Claude Code cannot write Vercel secrets)

| Variable (dashboard project, Production)                         | Value                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                   | the `app_user` pooled URL of the live database (the same one `db:verify --target env` already uses locally)                                                                                                                                                               |
| `DATABASE_URL_AUTH`                                              | the `app_auth` pooled URL                                                                                                                                                                                                                                                 |
| `BETTER_AUTH_SECRET`                                             | 32 random bytes generated on the Owner's machine and sent straight to Vercel                                                                                                                                                                                              |
| `BETTER_AUTH_URL`                                                | the production dashboard alias                                                                                                                                                                                                                                            |
| `EMAIL_TRANSPORT=resend`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM` | the Resend key already held by the Owner, with the provider's shared test sender (it delivers only to the Owner's own address). Until DG-10 this is what keeps the dashboard private: nobody else can receive a verification e-mail, so nobody else can finish signing up |

Already done: production Turnstile keys (DG-16), Sentry (DG-23), `PREVIEW_HOST` and `PREVIEW_TOKEN_SECRET` (DG-26), Inngest and Upstash variables.

### 3.2 Claude actions

1. Read-only check of the Vercel environment (names only) before and after.
2. Redeploy and smoke test: `/api/health`, `/sign-in` 200, security headers, no error in Sentry.
3. With the Owner: one live sign-up with the Owner's own e-mail (closes the open part of DG-16: one live widget solve, and the first real verification e-mail), create a workspace, open Templates, **make a valid preview link and open it on the sites host** (closes the open part of DG-26), turn it off and see "withdrawn".
4. Add a `Server-Timing` header to dashboard responses (duration of the request on the server, nothing else), so the measurement separates server time from network time. Useful for Phase 8 observability anyway.
5. **NFR-PERF-04 in region:** run the existing harness shape (10 concurrent clients, 500 ms p95 budget) against the deployed dashboard with a dedicated measurement account the Owner creates, from a machine with a low round trip to the function region (`bom1`), and report two numbers per route: client-observed p95 and server-side p95 from `Server-Timing`. The result goes into the Phase report and closes DG-28.

### 3.3 Safety and rollback

- No schema change, no new endpoint besides a response header; no secret printed or stored by Claude.
- Rollback: remove the five variables (the dashboard returns to its current state) or set `EMAIL_TRANSPORT` back; no data to undo. The measurement account is deleted by an operator function afterwards.
- Risk: low. The production alias is public, but without a deliverable verification e-mail no other account can be created, and sign-up is protected by Turnstile and rate limits (P1).

## 4. What closes what

| Item                                        | Closed by                                      |
| ------------------------------------------- | ---------------------------------------------- |
| DG-27 (dashboard production not configured) | Stage A, then Stage B for the public launch    |
| DG-28 (NFR-PERF-04 in region)               | Stage A, step 3.2.5                            |
| DG-26 open part (valid live preview link)   | Stage A, step 3.2.3                            |
| DG-16 open part (one live widget solve)     | Stage A, step 3.2.3                            |
| DG-10, DG-11                                | Stage B (purchases and decisions of the Owner) |

## 5. When

Stage A is the first slice of Phase 3 ("P3 S0"), started when the Owner approves it. It takes about one working session if the Owner can set the variables in one sitting.
