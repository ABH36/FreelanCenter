/**
 * Property test (module 04 evidence "any valid config renders; invalid never crashes"): mutate a config that holds
 * every block and variant; whatever the schema accepts must render without throwing and without producing script,
 * inline handlers, inline styles or unsafe URLs; whatever it rejects is never rendered.
 */
import { describe, expect, it } from 'vitest';
import { parseSiteConfig } from '@platform/schema';
import { renderSections, type BlockErrorInfo } from './index';
import { allDefaultSections, baseConfig, ctxFor, html } from './test-helpers';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "javascript:alert('x')",
  'data:text/html,<script>',
  'Tom & "Jerry" \'x\' &lt;b&gt;',
  '{{7*7}} ${alert(1)} %s %d',
  'x'.repeat(700),
  '‮evil',
  'नमस्ते दुनिया',
  '',
];
const WEIRD: unknown[] = [null, 0, -5, 99999, true, [], {}, 'x'];

type Json = Record<string, unknown> | unknown[];
function paths(node: unknown, base: (string | number)[] = [], out: (string | number)[][] = []) {
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      const p = [...base, Array.isArray(node) ? Number(k) : k];
      out.push(p);
      paths(v, p, out);
    }
  }
  return out;
}
function setAt(root: Json, path: (string | number)[], value: unknown) {
  let node: any = root; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const seg of path.slice(0, -1)) node = node?.[seg];
  const last = path[path.length - 1];
  if (node && last !== undefined) node[last] = value;
}

describe('fuzz: schema-valid configs render safely', () => {
  it('3,000 mutated configs: no exception, no unsafe output; rejected configs are never rendered', () => {
    const rand = rng(20261106);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T;
    let accepted = 0;
    let rendered = 0;
    for (let i = 0; i < 3000; i++) {
      const doc = baseConfig(allDefaultSections()) as unknown as Json;
      const rounds = 1 + Math.floor(rand() * 2);
      for (let r = 0; r < rounds; r++) {
        const p = pick(paths(doc));
        setAt(doc, p, rand() < 0.65 ? pick(STRINGS) : pick(WEIRD));
      }
      const result = parseSiteConfig(doc);
      if (!result.ok) continue;
      accepted += 1;
      const errors: BlockErrorInfo[] = [];
      const cfg = result.config;
      const ctx = ctxFor(cfg, { leadForm: { action: '/api/leads' }, onBlockError: (e) => errors.push(e) });
      let out = '';
      expect(() => {
        out = renderSections(cfg.pages[0]?.sections ?? [], ctx)
          .nodes.map((n) => html(n.node))
          .join('');
      }).not.toThrow();
      rendered += out.length > 0 ? 1 : 0;
      // A config the schema accepted must never make a block fail.
      expect(errors, JSON.stringify(errors)).toEqual([]);
      // Tag context only: hostile *text* (escaped) may legitimately contain words like onerror= or javascript:.
      expect(out).not.toMatch(/<(script|iframe|object|embed)|<[a-z][^>]*\s(on[a-z]+|style)=/i);
      for (const href of out.matchAll(/href="([^"]*)"/g)) {
        expect(href[1]).toMatch(/^(\/|#|https:\/\/|tel:|mailto:)/);
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rendered).toBe(accepted);
  }, 120_000);
});
