# ADR-007: Durable background jobs - Inngest

**Status:** Accepted - Owner ratified 2026-10-22 with the mandatory configuration below; evidence Spike G (local signed-executor suite). Live Inngest Cloud run pending · **Date:** 2026-09-21 · **SRS:** 8.7, C10

## Context

Publish-time SEO, embeddings, DNS/cert polling, exports, notifications and vetting are long-running, must retry, and must be idempotent. Serverless request handlers time out and have no retry queue.

## Decision (working assumption)

**Inngest**: step functions, retries with backoff, throttling/concurrency keys (needed for the Vercel 100-domains/hour limit, ADR-005, and per-workspace AI fairness), scheduled functions (`retention.sweep`). Alternatives: Trigger.dev, Upstash QStash + own worker.

## Not verified

No Inngest account or SDK trial in Phase 0. Verify in Phase 1 with one real function (lead notification) including retry and dead-letter behaviour and local dev experience. The provider is wrapped behind `packages/jobs` so it can be swapped.

## Verification (Spike G, DG-06)

Local proof passed against the self-hosted Inngest executor in signed cloud mode: retry with backoff, memoized steps, function idempotency key, event-id de-duplication, `onFailure` dead-letter, per-workspace concurrency key, ids-only payloads and request/response signatures (SEC-06). Live Inngest Cloud run pending. Evidence: [../spikes/SPIKE_G_INNGEST.md](../spikes/SPIKE_G_INNGEST.md).

Mandatory configuration (ratified by the Owner on 2026-10-22):

1. `isDev` is set explicitly; startup fails in preview/production when dev mode is on or `INNGEST_SIGNING_KEY` is missing (G-1: dev mode skips signature checks).
2. Every side-effecting step is idempotent on a stable domain key: provider idempotency keys, upserts or unique constraints (G-2 replay window, G-3 at-least-once steps).
3. Events are emitted only through typed ids-only helpers in `packages/jobs`; direct `send` elsewhere is a lint error (G-4).
4. `onFailure` writes a workspace-scoped dead-letter row and raises an alert; Inngest has no dead-letter store of its own (G-5).
5. The serve route is rate-limited at the edge (G-6).

## Consequences

Another vendor on the critical path for background work (not for serving sites). All job payloads carry `workspace_id` and are traced.
