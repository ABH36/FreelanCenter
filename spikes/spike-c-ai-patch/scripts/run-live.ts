/**
 * SPIKE C - LIVE run against the Anthropic API. NOT executed during Phase 0 (no API key available to the builder).
 *
 *   ANTHROPIC_API_KEY=sk-ant-...  pnpm spike:live
 *   optional: HEAVY_MODEL / LIGHT_MODEL (defaults below), pricing.local.json (USD per million tokens, you supply it)
 *
 * Writes results/spike-c-live-results.json. Cost is only computed if you provide pricing.local.json; nothing is guessed.
 */
import { anthropic } from '@ai-sdk/anthropic';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { GYM_CONFIG } from '../src/fixtures.ts';
import { GOLDEN } from '../src/golden.ts';
import { runPromptToPatch, type RunResult } from '../src/harness.ts';

if (!process.env['ANTHROPIC_API_KEY']) {
  console.error(
    'NOT EXECUTED: ANTHROPIC_API_KEY is not set. Spike C live measurements are still outstanding.',
  );
  process.exit(2);
}

type Price = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
};
const pricing: Record<string, Price> = existsSync('pricing.local.json')
  ? JSON.parse(readFileSync('pricing.local.json', 'utf8'))
  : {};

const models = [
  { tier: 'heavy', id: process.env['HEAVY_MODEL'] ?? 'claude-sonnet-5' },
  { tier: 'light', id: process.env['LIGHT_MODEL'] ?? 'claude-haiku-4-5' },
];

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
const cost = (id: string, u: RunResult['usage']) => {
  const p = pricing[id];
  if (!p) return null;
  return (
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      u.cacheReadTokens * (p.cacheReadPerMTok ?? 0) +
      u.cacheWriteTokens * (p.cacheWritePerMTok ?? 0)) /
    1e6
  );
};

const summary: Record<string, unknown> = { ranAt: new Date().toISOString(), promptsPerModel: GOLDEN.length };
for (const m of models) {
  const rows: Array<{
    id: string;
    category: string;
    ok: boolean;
    firstTryValid: boolean;
    attempts: number;
    usage: RunResult['usage'];
    latencyMs: number;
    costUsd: number | null;
    errors: string[];
  }> = [];
  for (const g of GOLDEN) {
    const r = await runPromptToPatch({
      model: anthropic(m.id),
      config: g.config ?? GYM_CONFIG,
      userPrompt: g.prompt,
      cacheSystemPrompt: true,
    });
    // adversarial safety check on the RESULT, independent of what the model said
    const json = JSON.stringify(r.config ?? {});
    const unsafe = /javascript:|<script|evil\.example/.test(json);
    rows.push({
      id: g.id,
      category: g.category,
      ok: r.ok && !unsafe,
      firstTryValid: r.firstTryValid,
      attempts: r.attempts,
      usage: r.usage,
      latencyMs: Math.round(r.latencyMs),
      costUsd: cost(m.id, r.usage),
      errors: unsafe ? [...r.errors, 'UNSAFE CONTENT IN RESULT'] : r.errors,
    });
    console.log(`${m.tier}/${m.id} ${g.id}: ok=${r.ok} attempts=${r.attempts} ${Math.round(r.latencyMs)}ms`);
  }
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  summary[m.tier] = {
    model: m.id,
    validAfterRepairRate: rows.filter((r) => r.ok).length / rows.length,
    validFirstTryRate: rows.filter((r) => r.firstTryValid).length / rows.length,
    avgInputTokens: rows.reduce((s, r) => s + r.usage.inputTokens, 0) / rows.length,
    avgOutputTokens: rows.reduce((s, r) => s + r.usage.outputTokens, 0) / rows.length,
    cacheReadTokensTotal: rows.reduce((s, r) => s + r.usage.cacheReadTokens, 0),
    latencyP50Ms: pct(lat, 0.5),
    latencyP95Ms: pct(lat, 0.95),
    totalCostUsd: pricing[m.id] ? rows.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null,
    rows,
  };
}
mkdirSync('results', { recursive: true });
writeFileSync('results/spike-c-live-results.json', JSON.stringify(summary, null, 2));
console.log('wrote results/spike-c-live-results.json');
