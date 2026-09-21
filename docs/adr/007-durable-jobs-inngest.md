# ADR-007: Durable background jobs - Inngest

**Status:** Proposed · **Date:** 2026-09-21 · **SRS:** 8.7, C10

## Context

Publish-time SEO, embeddings, DNS/cert polling, exports, notifications and vetting are long-running, must retry, and must be idempotent. Serverless request handlers time out and have no retry queue.

## Decision (working assumption)

**Inngest**: step functions, retries with backoff, throttling/concurrency keys (needed for the Vercel 100-domains/hour limit, ADR-005, and per-workspace AI fairness), scheduled functions (`retention.sweep`). Alternatives: Trigger.dev, Upstash QStash + own worker.

## Not verified

No Inngest account or SDK trial in Phase 0. Verify in Phase 1 with one real function (lead notification) including retry and dead-letter behaviour and local dev experience. The provider is wrapped behind `packages/jobs` so it can be swapped.

## Consequences

Another vendor on the critical path for background work (not for serving sites). All job payloads carry `workspace_id` and are traced.
