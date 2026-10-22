# Threat Model v1 (STRIDE)

**Date:** 2026-09-21 · **Scope:** the platform as specified in SRS v1.2 · **Status:** design-level. Nothing here has been tested by an external party (SEC-18 requires a pen test before launch). Reviewed again at the end of every phase.

## Assets (what an attacker wants)

1. Tenant data isolation (leads, drafts, client data) - a leak destroys trust.
2. Freelancer/client sessions and magic links.
3. Stored credentials (SMTP, WhatsApp, GitHub/Vercel tokens).
4. Money flows (subscriptions, marketplace payouts).
5. Platform AI budget (Anthropic key/credits).
6. Visitor trust in tenant sites (phishing, malware).
7. Marketplace template IP.
8. Availability of tenant sites.

## Trust boundaries

`Visitor -> sites app` (untrusted) · `Freelancer -> dashboard` (authenticated, tenant-scoped) · `Client -> onboarding/portal` (token-scoped) · `apps -> Postgres` (RLS) · `apps -> AI/payment/email providers` (secrets) · `Creator -> marketplace submission` (untrusted content).

## STRIDE by component

| Component                         | Threat                                                                   | Type | Mitigation (SRS ref)                                                                                  | Phase | How it is tested                                                |
| --------------------------------- | ------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------- |
| Postgres                          | Query without tenant filter leaks another tenant's rows                  | I    | RLS forced, fail-closed, NOBYPASSRLS roles (5.3, SEC-01)                                              | 1     | Isolation suite, merge gate (SEC-02); proven pattern in Spike B |
| Postgres                          | Session-level `SET` leaks context through a pooler                       | I/E  | Transaction-local `set_config` only; lint + suite (5.3)                                               | 1     | Anti-pattern test (Spike B #9)                                  |
| Postgres                          | Migration role inherits definer policies and reads all tenants           | I/E  | `INHERIT FALSE` (Spike B B-7)                                                                         | 1     | Owner-no-context test                                           |
| Postgres                          | Definer functions abused via `search_path`                               | E    | `SET search_path` on every definer function; only listed functions granted                            | 1     | Grants review + test                                            |
| Dashboard                         | Broken access control / IDOR across projects or workspaces               | E/I  | AuthZ in data layer + RLS (SEC-10)                                                                    | 1+    | IDOR test per resource                                          |
| Dashboard                         | Credential stuffing, enumeration, session theft                          | S    | Rate limits, generic errors, MFA, hashed reset tokens, cookie flags (6.1)                             | 1     | Auth security tests                                             |
| Auth (Better Auth)                | Session tokens stored in plain text in `identity.sessions` (Spike F F-3) | I/S  | Only `app_auth` can read identity schema; 7-day expiry; log-out-all; encrypted backups (SEC-14)       | 1     | Role-split test (Spike F #1)                                    |
| Auth (Better Auth)                | CSRF/origin checks silently off under test runners (Spike F F-2)         | S/T  | `disableOriginCheck: false` pinned; permanent CSRF test                                               | 1     | CSRF test (Spike F #20)                                         |
| Auth (Better Auth)                | Rate-limit evasion by spoofing `x-forwarded-for` (Spike F F-5)           | D/S  | Trust only the edge-provided client-IP header; edge rate limits (SEC-19)                              | 1     | Header-spoof test in the P1 auth slice                          |
| Auth (Better Auth)                | Google access/id tokens stored in plain text (Spike F F-10)              | I    | `account.encryptOAuthTokens: true`; only `app_auth` reads identity schema                             | 1     | Manual Google run asserts not-plain                             |
| Sites app                         | Stored XSS through tenant content                                        | T/I  | Schema forbids markup, React escaping, no `dangerouslySetInnerHTML` (lint), strict CSP (SEC-03/04)    | 2     | Fuzz + XSS corpus tests                                         |
| Sites app                         | Tenant XSS reaches dashboard cookies                                     | E    | Different registrable domains, no shared cookies (ADR-002)                                            | 0/1   | Architecture check                                              |
| Sites app                         | Oversized/deep config causes render DoS                                  | D    | Size and count bounds in schema (5.2)                                                                 | 2     | Fuzz/limits tests                                               |
| Sites app                         | Host-header confusion serves the wrong tenant                            | S/I  | Exact host match, cache key per host, negative cache                                                  | 1     | Routing tests                                                   |
| Custom domains                    | Subdomain/domain takeover, dangling DNS                                  | S    | TXT ownership verification, cleanup on delete (SEC-12)                                                | 7A    | Spike A runbook, tests                                          |
| Custom domains                    | Certificate-issuance abuse                                               | D    | DNS pre-check + backoff (FR-DOM-04); Vercel 100/h limit queue                                         | 7A    | Wrong-DNS test                                                  |
| Magic links                       | Link theft/guessing/replay                                               | S/E  | >=128-bit token hashed at rest, expiry, revocation, no-referrer (SEC-11)                              | 5     | Token tests                                                     |
| Uploads                           | Malware, SVG script, EXIF leak, polyglot files                           | T/I  | Magic-byte sniffing, re-encode, EXIF strip, SVG disallowed/sanitised (SEC-08)                         | 3     | Malicious-file corpus                                           |
| Public lead endpoint              | Spam/DoS/injection                                                       | D/T  | Turnstile/hCaptcha, honeypot, rate limits, size caps, parameterised SQL (FR-LEAD-01)                  | 5     | Abuse tests                                                     |
| AI                                | Prompt injection (freelancer, client text, visitor chat)                 | T/E  | Content as labelled data; model has no side-effecting tools; output validated and user-accepted (8.5) | 4     | Adversarial golden set; offline tests in Spike C                |
| AI                                | Cost exhaustion / noisy neighbour                                        | D    | Reserve->commit ledger, per-user/workspace limits, global queue (8.4)                                 | 4     | Load test                                                       |
| AI                                | API key exposure                                                         | I    | Server-only, never in client bundles, secret scanning (SEC-05)                                        | 0+    | gitleaks in CI                                                  |
| Integrations                      | Stored credential theft                                                  | I    | Envelope encryption, key rotation, write-only UI (FR-INT-03)                                          | 7A    | Rotation test                                                   |
| Webhooks (payments/GitHub/Vercel) | Forgery/replay                                                           | S/T  | Signature + timestamp check, idempotency table (SEC-06)                                               | 6/7B  | Replay tests                                                    |
| Marketplace                       | Malicious or plagiarised template                                        | T/R  | Declarative templates only (ADR-004), vetting pipeline, takedown                                      | 6     | Malicious fixture set                                           |
| Export                            | Cross-tenant data or secrets in export                                   | I    | Per-project scoping, secret scan of artefacts (FR-EXP-04)                                             | 7B    | Automated export audit                                          |
| Export                            | Paid template IP taken via export                                        | I/R  | Export rights follow licence (FR-MKT-11)                                                              | 7B    | Bypass tests                                                    |
| Free tier                         | Phishing sites on our subdomains                                         | R/T  | Blocklists, Safe Browsing, rate limits, abuse report (FR-ABU)                                         | 3/8   | Abuse queue drills                                              |
| Admin                             | Impersonation abuse                                                      | E/R  | Consent, time box, banner, audit (FR-ADM-03)                                                          | 8     | Audit checks                                                    |
| Supply chain                      | Malicious dependency install script                                      | T    | pnpm denies scripts by default; allowlist reviewed (ADR-001); Dependabot/OSV, lockfile                | 0     | `pnpm audit`, CI                                                |
| CI/CD                             | Secret leak, compromised action                                          | I/T  | Secret scanning, least-privilege tokens, pinned actions (SHA pin pending)                             | 0     | CI review                                                       |
| Logs                              | PII/secrets in logs                                                      | I    | Structured logging with redaction (FR-OBS-01)                                                         | 1     | Log tests                                                       |

## Top risks carried into Phase 1

1. Supabase shared pooler behaviour differs from the PgBouncer used in Spike B (ADR-003) - blocks schema work until re-verified.
2. Job runner (Inngest) is an unverified choice (ADR-007). Auth (ADR-006) was verified by Spike F on 2026-10-22; its accepted residual risks are the Better Auth rows above.
3. Client-portal access model versus RLS is unresolved (a Client has no workspace membership): see IMPLEMENTATION_PLAN ambiguity Q5.
4. No live measurement of real-model injection resistance yet (Spike C live run).

## Not covered yet

DoS at network level (delegated to Vercel/Cloudflare, SEC-19), physical/insider threats, legal/regulatory review, and any threat introduced by features not yet designed in detail (chatbot, marketplace payouts).
