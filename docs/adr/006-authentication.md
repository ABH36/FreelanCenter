# ADR-006: Authentication - Better Auth, self-managed

**Status:** Proposed · **Date:** 2026-09-21 · **SRS:** 6.1, D3

## Context

Needs: email+password with verification, Google OAuth, TOTP MFA, sessions with rotation, password reset, brute-force limits, multiple workspaces per user. A managed vendor (Clerk) charges per monthly active user, which is punishing for a B2B2C product with many small clients.

## Decision (working assumption)

**Better Auth**, storing users/sessions in our Postgres, with our own `Membership` tables (roles per workspace). Auth.js is the fallback. Clerk only if the Owner prefers speed over cost control.

## Not verified

No spike was run in Phase 0. Compatibility of Better Auth with Prisma 7 + the RLS pattern (auth tables live outside tenant RLS), its MFA/TOTP support, and its Next 16 integration are **unverified**. Phase 1 starts with a short proof (sign-up, verify email, login, TOTP, session rotation) before schema work depends on it.

## Consequences

Owning auth means owning its security. The security review checklist in the plan covers token hashing, enumeration resistance, and lockout.
