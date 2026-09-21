# ADR-005: Domain provider - Vercel-hosted sites use the Vercel Domains API; never proxy Vercel behind Cloudflare

**Status:** Accepted for planning (Spike A not executed) · **Date:** 2026-09-21 · **SRS:** 6.12, D2, R2

## Context

Custom domains need automatic SSL and routing. Two workable stacks exist and they must not be mixed. Vercel advises against a reverse proxy (including Cloudflare's orange cloud) in front of Vercel because it hides visitor IPs from Vercel's firewall/bot protection and adds latency and cache confusion ([Vercel KB](https://vercel.com/kb/guide/cloudflare-with-vercel)).

## Decision

- **Option A (default):** `apps/sites` on Vercel (`bom1`), custom domains through the **Vercel Domains API**. Cloudflare only as DNS-only or for our own asset domain (R2).
- **Option B (only if Vercel is abandoned for sites):** a container/origin host plus **Cloudflare for SaaS**.
- The application talks to a `DomainProvider` interface so the choice stays swappable.
- Design inputs from research: 100 domain additions/hour/team (queue + throttle adds), soft limit 100,000 domains/project on Pro, wildcard subdomains need Vercel nameservers, per-domain ownership TXT verification before activation.

## Consequences

- Vendor lock-in to Vercel for the public hot path (R12). Mitigated by the interface, immutable snapshots, and the export feature.
- The 100/hour add limit shapes onboarding UX (queued state).

## Verification owed

Spike A runbook ([SPIKE_A_DOMAINS.md](../spikes/SPIKE_A_DOMAINS.md)) once a Vercel account and test domains exist. Not needed before Phase 7A.
