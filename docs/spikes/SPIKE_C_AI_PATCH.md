# Spike C - Anthropic structured output through the Vercel AI SDK

**Status: PARTIAL. Offline half EXECUTED (24/24 tests). Live half NOT EXECUTED - no `ANTHROPIC_API_KEY` was available to the builder.**
Code: [spikes/spike-c-ai-patch](../../spikes/spike-c-ai-patch) · Live runner: `ANTHROPIC_API_KEY=... pnpm spike:live` (refuses to run without a key; verified, exit code 2).

## What was executed (real, offline)

A prompt-to-patch harness built on the **real** AI SDK v7 (`ai` 7.0.107, `@ai-sdk/anthropic` 4.0.58, `zod` 4.6.5) with a mock model (`MockLanguageModelV4`):

| Area                                                                                                                                                                                                                                                                                                                            | Tests | Result |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| Deterministic apply on a copy (theme, business, seo, visibility, reorder, add section); input never mutated                                                                                                                                                                                                                     | 2     | pass   |
| Rejections: unknown id, duplicate id, bad reorder, bad variant, bad props, unknown prop key, removing last section                                                                                                                                                                                                              | 7     | pass   |
| Safety rules by schema: `javascript:`, `data:`, `http:` URLs, HTML in text fields; https/tel/mailto accepted                                                                                                                                                                                                                    | 6     | pass   |
| Pipeline: valid first try; schema-invalid -> repair -> valid; semantically invalid -> repair -> valid; malicious answer repaired and never returned; always-invalid stops after 1 + maxRepairs attempts with **no config returned**; provider error not retried as a "repair"; untrusted content sent inside labelled data tags | 9     | pass   |

These prove the **deterministic half** of FR-AI-01/03: nothing the model says is persisted unless it passes op-schema, apply-on-copy, and full-config validation.

## What was NOT measured (needs the key)

Everything about **real model behaviour**: schema-valid-first-try rate, valid-after-repair rate (SRS target >= 99%), tokens per job, p50/p95 latency, cost per job, prompt-caching hit rate (`cacheReadTokens`), and resistance to the 3 adversarial prompts. The runner (15 golden prompts x heavy and light model, English/Hinglish/Hindi/adversarial) is ready and writes `results/spike-c-live-results.json`. Cost is computed only if the owner supplies `pricing.local.json`; nothing is guessed.

**No claim in the SRS about model quality, latency or cost is supported by evidence yet.**

## Findings from building it against the real SDK

| ID  | Finding                                                                                                                                                                                                                                                                                              | Impact                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C-1 | `generateObject` is **deprecated in AI SDK v7** ("use `generateText` with an `output` setting"). Structured output is `generateText({ output: Output.object({ schema }) })`, result in `.output`.                                                                                                    | SRS 8.2 / ADR-008 wording updated.                                               |
| C-2 | v7 **rejects system-role messages inside `messages` at runtime** (`Invalid prompt: System messages are not allowed...`); system text goes in `instructions`, which accepts a `SystemModelMessage` so `providerOptions` (Anthropic prompt caching) can ride along. TypeScript did **not** catch this. | Always exercise the SDK, not only compile it. Encoded in the harness.            |
| C-3 | Usage shape is `inputTokens`, `inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}`, `outputTokens`; a schema failure throws `NoObjectGeneratedError` which carries `.text` and `.usage` (needed for repair prompts and for billing failed attempts).                                 | Credit ledger design (FR-AI-04) must bill/record usage from failed attempts too. |
| C-4 | Zod 4 needs `z.record(z.string(), ...)` and supports `z.strictObject`; strict objects make "unknown key" injection attempts fail validation.                                                                                                                                                         | Adopt strict schemas in packages/schema.                                         |
| C-5 | The closed-op design needs a harmless escape hatch (`noChange`), otherwise "delete a section that does not exist" forces the model to hallucinate an edit.                                                                                                                                           | Added to the op set; SRS 8.2 to list it.                                         |

## Prompt caching note

Anthropic caches only prompts above a model-specific minimum length. The current system prompt is short; caching may not engage until the block catalogue is added in Phase 2/4. Verify `cacheReadTokens > 0` in the live run.

## To close this spike

1. Owner supplies an API key (env var only, never committed) and `pricing.local.json` from current Anthropic pricing.
2. Run `pnpm spike:live`; attach `results/spike-c-live-results.json` to the Phase 0 report addendum.
3. Confirm model IDs `claude-sonnet-5` and `claude-haiku-4-5` are accepted (they are configuration, never hard-coded).
