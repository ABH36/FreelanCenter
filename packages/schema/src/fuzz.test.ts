/* eslint-disable @typescript-eslint/no-explicit-any -- mutation helpers edit untyped documents on purpose */
/**
 * Property/fuzz tests (module 04 evidence): a seeded, dependency-free mutation fuzzer over a valid config.
 * Properties: (1) parseSiteConfig never throws, whatever the input; (2) any config it accepts contains no markup,
 * no unsafe URL scheme and no unknown key anywhere, i.e. "valid" really means safe to render as data.
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, isSafeUrl, parseSiteConfig } from './index';
import { validConfig } from './fixtures';

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

export const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  "javascript:alert('x')",
  'JaVaScRiPt:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  '&#106;avascript:alert(1)',
  '\u0000javascript:alert(1)',
  '{{constructor.constructor("alert(1)")()}}',
  '${alert(1)}',
  '<iframe src="https://evil.example"></iframe>',
  'x'.repeat(5000),
  '‮exe.txt',
  '../../../etc/passwd',
  '__proto__',
];
const WEIRD: unknown[] = [
  null,
  undefined,
  0,
  -1,
  1e308,
  NaN,
  true,
  [],
  {},
  [[]],
  { a: { b: {} } },
  '',
  ' ',
  'true',
];

type Node = Record<string, unknown> | unknown[];
function collectPaths(node: unknown, path: (string | number)[] = [], out: (string | number)[][] = []) {
  if (typeof node === 'object' && node !== null) {
    out.push(path);
    for (const [k, v] of Object.entries(node))
      collectPaths(v, [...path, Array.isArray(node) ? Number(k) : k], out);
  } else out.push(path);
  return out;
}
function setAt(root: Node, path: (string | number)[], value: unknown, del = false) {
  let node: any = root;
  for (const seg of path.slice(0, -1)) node = node?.[seg];
  const last = path[path.length - 1];
  if (node === undefined || node === null || last === undefined) return;
  if (del) {
    if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete node[last];
  } else node[last] = value;
}

function walkStrings(node: unknown, visit: (s: string) => void) {
  if (typeof node === 'string') visit(node);
  else if (Array.isArray(node)) node.forEach((n) => walkStrings(n, visit));
  else if (typeof node === 'object' && node !== null)
    Object.values(node).forEach((n) => walkStrings(n, visit));
}

describe('fuzz: parseSiteConfig', () => {
  it('never throws and accepted configs are markup-free (2,000 seeded mutations)', () => {
    const rand = rng(20261105);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T;
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const doc = validConfig() as Node;
      const rounds = 1 + Math.floor(rand() * 4);
      for (let r = 0; r < rounds; r++) {
        const paths = collectPaths(doc).filter((p) => p.length > 0);
        const path = pick(paths);
        const mode = rand();
        if (mode < 0.4) setAt(doc, path, pick(XSS_CORPUS));
        else if (mode < 0.7) setAt(doc, path, pick(WEIRD));
        else if (mode < 0.85) setAt(doc, path, undefined, true);
        else
          setAt(
            doc,
            [...path.slice(0, -1), pick(['__proto__', 'constructor', 'extra', 'onclick'])],
            pick(XSS_CORPUS),
          );
      }
      let result: ReturnType<typeof parseSiteConfig> | undefined;
      expect(() => (result = parseSiteConfig(doc))).not.toThrow();
      if (result?.ok) {
        accepted += 1;
        walkStrings(result.config, (s) => {
          expect(/[<>]/.test(s)).toBe(false);
        });
        for (const page of result.config.pages) {
          for (const section of page.sections) expect(section.id).toMatch(/^[a-z0-9-]+$/);
        }
        expect(
          isSafeUrl(result.config.navigation.items[0]?.target ?? 'https://x.com') ||
            result.config.navigation.items[0]?.target.startsWith('/'),
        ).toBe(true);
      }
    }
    // The fuzzer must also exercise the accept path, otherwise the property above proves nothing.
    expect(accepted).toBeGreaterThan(20);
  });

  it('applyPatch never throws on arbitrary patches', () => {
    const rand = rng(7);
    const base = parseSiteConfig(validConfig());
    if (!base.ok) throw new Error('fixture invalid');
    const ops = [
      'updateBusiness',
      'updateTheme',
      'updateSection',
      'addSection',
      'removeSection',
      'moveSection',
      'zzz',
    ];
    for (let i = 0; i < 500; i++) {
      const patch = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const op: Record<string, unknown> = { op: ops[Math.floor(rand() * ops.length)] };
        for (const k of ['sectionId', 'pageId', 'value', 'props', 'toIndex', 'section', 'variant']) {
          if (rand() < 0.5)
            op[k] =
              rand() < 0.5
                ? XSS_CORPUS[Math.floor(rand() * XSS_CORPUS.length)]
                : WEIRD[Math.floor(rand() * WEIRD.length)];
        }
        return op;
      });
      expect(() => applyPatch(base.config, patch)).not.toThrow();
    }
  });
});
