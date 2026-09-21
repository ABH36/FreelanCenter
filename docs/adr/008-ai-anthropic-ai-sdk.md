# ADR-008: AI - Anthropic through the Vercel AI SDK v7, patch-based edits, credit ledger

**Status:** Accepted for planning (offline half verified; live half needs an API key) · **Date:** 2026-09-21 · **SRS:** 8, FR-AI-*

## Decision

- **SDK:** `ai` v7 + `@ai-sdk/anthropic`. Structured output via `generateText({ output: Output.object({ schema }) })`. **`generateObject` is deprecated in v7** and must not be used.
- **System prompt** goes in `instructions` (system-role entries in `messages` are rejected at runtime in v7).
- **The model proposes a `PatchSet`** (closed set of typed operations incl. a harmless `noChange`); deterministic code validates, applies to a copy, re-validates the whole config, and only then may the user accept it. Invalid output is never persisted; repair loop <= 2.
- **Models are configuration, not code.** Defaults: heavy `claude-sonnet-5`, light `claude-haiku-4-5`, held in a model-registry table (id, tier, per-token cost) so they can change without a deploy. Verify IDs and prices at first live run.
- **Credits:** append-only ledger, reserve -> commit/refund, idempotency keys, model-weighted; usage from **failed attempts** is recorded too (`NoObjectGeneratedError` carries usage).
- **Rate limiting:** per user and per workspace token bucket in Upstash, global queue/circuit breaker below Anthropic org limits (Phase 4).

## Evidence

[SPIKE_C_AI_PATCH.md](../spikes/SPIKE_C_AI_PATCH.md): 24/24 offline tests through the real SDK. **Not measured:** valid-first-try rate, repair rate, latency, cost, caching hit rate, injection resistance of a real model.

## Consequences

One more SDK major to track (v7 API differs from what most tutorials show). Provider swap remains possible because the harness takes an injected model.
