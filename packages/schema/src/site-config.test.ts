/* eslint-disable @typescript-eslint/no-explicit-any -- mutation helpers edit untyped documents on purpose */
import { describe, expect, it } from 'vitest';
import { LIMITS, isSafeUrl, parseSiteConfig, BLOCKS, BLOCK_TYPES, hasBlockVariant } from './index';
import { validConfig } from './fixtures';

type Mutable = Record<string, any>;
const mutated = (fn: (c: Mutable) => void): unknown => {
  const c = validConfig() as Mutable;
  fn(c);
  return c;
};
const rejects = (raw: unknown, pathPart?: string) => {
  const r = parseSiteConfig(raw);
  expect(r.ok).toBe(false);
  if (!r.ok && pathPart) expect(r.issues.some((i) => i.path.includes(pathPart))).toBe(true);
};

describe('parseSiteConfig: accepts', () => {
  it('a complete valid config', () => {
    const r = parseSiteConfig(validConfig());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.migratedFrom).toBeNull();
  });
  it('applies defaults (visible, noindex) without mutating the input', () => {
    const input = mutated((c) => {
      delete c.pages[0].sections[0].visible;
    });
    const r = parseSiteConfig(input);
    expect(r.ok && r.config.pages[0]?.sections[0]?.visible).toBe(true);
    expect((input as Mutable).pages[0].sections[0].visible).toBeUndefined();
  });
  it('Devanagari and Hinglish text', () => {
    const r = parseSiteConfig(mutated((c) => (c.business.name = 'लोहा जिम - Iron Pulse')));
    expect(r.ok).toBe(true);
  });
});

describe('parseSiteConfig: rejects (SRS 5.2 config rules)', () => {
  it('non-objects and wrong version', () => {
    for (const raw of [null, undefined, 1, 'x', [], () => 1, { schemaVersion: '1.0' }]) rejects(raw);
    rejects(
      mutated((c) => (c.schemaVersion = '2.0')),
      'schemaVersion',
    );
    rejects(
      mutated((c) => delete c.schemaVersion),
      'schemaVersion',
    );
  });
  it('unknown keys at every level (strict objects)', () => {
    rejects(mutated((c) => (c.extra = 1)));
    rejects(mutated((c) => (c.business.extra = 1)));
    rejects(mutated((c) => (c.theme.colors.extra = '#000000')));
    rejects(mutated((c) => (c.pages[0].sections[0].props.onClick = 'x')));
    rejects(mutated((c) => (c.pages[0].sections[0].dangerouslySetInnerHTML = 'x')));
  });
  it('unknown block type or variant', () => {
    rejects(mutated((c) => (c.pages[0].sections[0].type = 'script')));
    rejects(mutated((c) => (c.pages[0].sections[0].variant = 'nope')));
  });
  it('HTML in any text field', () => {
    for (const bad of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a > b', '<b>x</b>']) {
      rejects(
        mutated((c) => (c.business.name = bad)),
        'business.name',
      );
      rejects(mutated((c) => (c.pages[0].sections[0].props.headline = bad)));
      rejects(mutated((c) => (c.pages[0].sections[1].props.items[0].title = bad)));
    }
  });
  it('control and bidi override characters', () => {
    rejects(mutated((c) => (c.business.name = 'a\u0000b')));
    rejects(mutated((c) => (c.business.name = 'gym‮txt.exe')));
  });
  it('unsafe URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'http://example.com',
      'file:///etc/passwd',
      '//evil.com',
      'https://user:pw@example.com',
      'vbscript:x',
      'JaVaScRiPt:alert(1)',
      ' https://x.com',
      'https://x.com/ a',
    ]) {
      expect(isSafeUrl(bad)).toBe(false);
      rejects(mutated((c) => (c.navigation.items[0].target = bad)));
      rejects(mutated((c) => (c.business.social.instagram = bad)));
    }
    for (const good of [
      'https://wa.me/919800000000',
      'tel:+919800000000',
      'mailto:a@b.com',
      'https://example.com/path?q=1',
    ]) {
      expect(isSafeUrl(good)).toBe(true);
    }
  });
  it('link/scroll CTAs without a target', () => {
    rejects(mutated((c) => (c.pages[0].sections[0].props.primaryCta = { label: 'Go', action: 'link' })));
  });
  it('images without alt, and with path-like or URL asset ids', () => {
    rejects(mutated((c) => (c.pages[0].sections[0].props.image = { assetId: 'a' })));
    rejects(mutated((c) => (c.pages[0].sections[0].props.image = { assetId: 'a', alt: '' })));
    rejects(
      mutated((c) => (c.pages[0].sections[0].props.image = { assetId: 'https://evil.com/x.png', alt: 'x' })),
    );
    rejects(mutated((c) => (c.pages[0].sections[0].props.image = { assetId: '../../etc', alt: 'x' })));
  });
  it('fonts outside the allow-list, bad colours, reduced motion switched off', () => {
    rejects(
      mutated((c) => (c.theme.typography.heading = 'Comic Sans')),
      'typography',
    );
    rejects(mutated((c) => (c.theme.colors.primary = 'red')));
    rejects(mutated((c) => (c.theme.colors.primary = '#fff')));
    rejects(mutated((c) => (c.theme.colors.primary = 'url(javascript:x)')));
    rejects(mutated((c) => (c.theme.motion.reducedMotionRespected = false)));
  });
  it('structural rules: unique ids and paths, home page, navigation targets', () => {
    rejects(
      mutated((c) => (c.pages[1].id = 'home')),
      'pages.1.id',
    );
    rejects(
      mutated((c) => (c.pages[1].path = '/')),
      'pages.1.path',
    );
    rejects(
      mutated((c) => (c.pages[0].sections[1].id = 's1')),
      'sections.1.id',
    );
    rejects(
      mutated((c) => (c.pages[0].path = '/home')),
      'pages',
    );
    rejects(
      mutated((c) => (c.navigation.items[1].target = '/missing')),
      'navigation',
    );
    rejects(mutated((c) => (c.pages[1].path = '/a/../b')));
  });
  it('bounds: pages, sections, items, text length, total size, depth', () => {
    rejects(
      mutated(
        (c) =>
          (c.pages = Array.from({ length: LIMITS.maxPages + 1 }, (_, i) => ({
            id: `p${i}`,
            path: i === 0 ? '/' : `/p${i}`,
            title: 't',
            sections: [],
          }))),
      ),
    );
    rejects(mutated((c) => (c.business.name = 'x'.repeat(LIMITS.maxShortText + 1))));
    rejects(
      mutated(
        (c) => (c.pages[0].sections[1].props.items = Array.from({ length: 13 }, () => ({ title: 't' }))),
      ),
    );
    const huge = mutated(
      (c) =>
        (c.pages[1].sections = Array.from({ length: 40 }, (_, i) => ({
          id: `t${i}`,
          type: 'about',
          variant: 'text-only',
          visible: true,
          props: {
            heading: 'h',
            body: Array.from({ length: 60 }, () => ({ type: 'text', text: 'x'.repeat(600) })),
          },
        }))),
    );
    const r = parseSiteConfig(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toMatch(/exceeds/);
    let deep: Mutable = {};
    const root = deep;
    for (let i = 0; i < 100; i++) deep = deep.n = {};
    const rd = parseSiteConfig(root);
    expect(rd.ok).toBe(false);
  });
  it('cyclic, bigint and prototype-polluting input never throws', () => {
    const cyclic: Mutable = validConfig() as Mutable;
    cyclic.self = cyclic;
    expect(parseSiteConfig(cyclic).ok).toBe(false);
    expect(parseSiteConfig({ n: 10n }).ok).toBe(false);
    expect(parseSiteConfig(JSON.parse('{"__proto__":{"polluted":true},"schemaVersion":"1.0"}')).ok).toBe(
      false,
    );
    expect(({} as Mutable).polluted).toBeUndefined();
  });
  it('caps the number of reported issues', () => {
    const r = parseSiteConfig(
      mutated((c) => (c.pages[0].sections = Array.from({ length: 40 }, () => ({ bad: 1 })))),
    );
    expect(!r.ok && r.issues.length).toBeLessThanOrEqual(25);
  });
});

describe('block catalog consistency', () => {
  it('every catalog type has variants and a matching section schema entry', () => {
    expect(BLOCK_TYPES.length).toBe(12);
    for (const type of BLOCK_TYPES) {
      expect(BLOCKS[type].variants.length).toBeGreaterThan(0);
      for (const v of BLOCKS[type].variants) expect(hasBlockVariant(type, v)).toBe(true);
    }
    expect(hasBlockVariant('hero', 'nope')).toBe(false);
    expect(hasBlockVariant('constructor', 'x')).toBe(false);
  });
});

describe('section anchors (found in P2 S3: scroll CTAs and one-page navigation)', () => {
  const ok = (raw: unknown) => expect(parseSiteConfig(raw).ok).toBe(true);
  it('accepts anchors in navigation that point at a real section', () => {
    ok(mutated((c) => (c.navigation.items[1].target = '/#s3')));
    ok(mutated((c) => (c.navigation.items[1].target = '#s3')));
    ok(mutated((c) => c.navigation.items.push({ label: 'Services', target: '/#s2' })));
  });
  it('rejects dangling or malformed anchors', () => {
    rejects(
      mutated((c) => (c.navigation.items[1].target = '/#nope')),
      'navigation',
    );
    rejects(
      mutated((c) => (c.navigation.items[1].target = '/missing#s3')),
      'navigation',
    );
    rejects(
      mutated((c) => (c.navigation.items[1].target = '/about#s3')),
      'navigation',
    );
    rejects(mutated((c) => (c.navigation.items[1].target = '#')));
    rejects(mutated((c) => (c.navigation.items[1].target = '/#A B')));
    rejects(mutated((c) => (c.navigation.items[1].target = '/#<x>')));
  });
  it('scroll CTAs need an anchor; link CTAs may still use anchors, paths and URLs', () => {
    ok(
      mutated(
        (c) =>
          (c.pages[0].sections[0].props.primaryCta = { label: 'Contact', action: 'scroll', target: '#s3' }),
      ),
    );
    rejects(
      mutated(
        (c) => (c.pages[0].sections[0].props.primaryCta = { label: 'x', action: 'scroll', target: '/about' }),
      ),
    );
    rejects(mutated((c) => (c.pages[0].sections[0].props.primaryCta = { label: 'x', action: 'scroll' })));
    rejects(
      mutated(
        (c) =>
          (c.pages[0].sections[0].props.primaryCta = {
            label: 'x',
            action: 'scroll',
            target: 'https://x.com',
          }),
      ),
    );
    ok(
      mutated(
        (c) => (c.pages[0].sections[0].props.primaryCta = { label: 'x', action: 'link', target: '/about' }),
      ),
    );
  });
});
