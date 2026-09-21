# ADR-002: Two apps, two registrable domains

**Status:** Accepted (verified: separate apps, lint boundary) · **Date:** 2026-09-21 · **SRS:** SEC-03, C14

## Context

Tenant sites contain content authored by freelancers, clients and (later) marketplace creators. A stored-XSS bug or cookie-scope mistake on a tenant site must not reach freelancer sessions, billing, or leads.

## Decision

- `apps/dashboard` (e.g., `app.<brand>.com`) and `apps/sites` (tenant sites on a **different registrable domain**, e.g., `*.<brand>-sites.com`, plus customers' custom domains) are separate Next.js apps and separate Vercel projects.
- No shared cookies or sessions. Cross-app interaction (draft preview in an iframe, staging access) uses **short-lived signed tokens**, not cookies.
- Neither app imports the other (ESLint rule).
- Custom domains and platform subdomains are served only by `apps/sites`.

## Options rejected

Single app with host-based routing: simplest, but one origin family shares cookie/XSS blast radius. Same registrable domain with subdomains: cookies can be scoped up by mistake, and `*.brand.com` tenants could set cookies for `brand.com`.

## Consequences

- A compromised tenant site cannot read dashboard cookies. + Independent scaling/WAF policy for public traffic.

* Two deployments, two env sets. Preview iframe needs a token handshake (open point in IMPLEMENTATION_PLAN, Phase 3).
* Owner must buy and delegate two domains (D1).

## Evidence

Apps scaffolded and running on ports 3000/3001 with separate configs; lint fails on cross-imports (tested).
