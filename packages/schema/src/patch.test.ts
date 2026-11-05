import { describe, expect, it } from 'vitest';
import { applyPatch, parseSiteConfig, type SiteConfig } from './index';
import { validConfig } from './fixtures';

function base(): SiteConfig {
  const r = parseSiteConfig(validConfig());
  if (!r.ok) throw new Error('fixture invalid');
  return r.config;
}

describe('applyPatch', () => {
  it('applies a valid multi-op patch on a copy', () => {
    const cfg = base();
    const before = JSON.stringify(cfg);
    const r = applyPatch(cfg, [
      { op: 'updateBusiness', value: { tagline: 'New tagline' } },
      { op: 'updateTheme', value: { colors: { primary: '#0A7F3F' }, motion: { preset: 'energetic' } } },
      { op: 'updateSection', sectionId: 's1', props: { headline: 'Stronger every day' } },
      { op: 'moveSection', sectionId: 's3', toIndex: 0 },
      {
        op: 'addSection',
        pageId: 'about',
        section: {
          id: 'f1',
          type: 'faq',
          variant: 'accordion',
          visible: true,
          props: { items: [{ question: 'Q?', answer: [{ type: 'text', text: 'A.' }] }] },
        },
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.business.tagline).toBe('New tagline');
      expect(r.config.business.name).toBe('Iron Pulse Fitness');
      expect(r.config.theme.colors.primary).toBe('#0A7F3F');
      expect(r.config.theme.colors.secondary).toBe('#111827');
      expect(r.config.pages[0]?.sections[0]?.id).toBe('s3');
      expect(r.config.pages[1]?.sections).toHaveLength(1);
    }
    expect(JSON.stringify(cfg)).toBe(before);
  });
  it('removes a section', () => {
    const r = applyPatch(base(), [{ op: 'removeSection', sectionId: 's2' }]);
    expect(r.ok && r.config.pages[0]?.sections.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('rejects operations outside the closed set and unknown keys', () => {
    const cfg = base();
    for (const patch of [
      [{ op: 'deletePage', pageId: 'home' }],
      [{ op: 'updateBusiness', value: { name: 'x' }, extra: 1 }],
      [{ op: 'updateBusiness', value: { evil: 1 } }],
      [{ op: 'updateTheme', value: { colors: { primary: 'javascript:x' } } }],
      [],
      'nope',
      null,
      Array.from({ length: 51 }, () => ({ op: 'removeSection', sectionId: 's1' })),
    ]) {
      expect(applyPatch(cfg, patch).ok).toBe(false);
    }
  });
  it('rejects a patch whose result is invalid, leaving nothing applied', () => {
    const cfg = base();
    for (const patch of [
      [{ op: 'updateSection', sectionId: 's1', props: { headline: '<script>x</script>' } }],
      [{ op: 'updateSection', sectionId: 's1', variant: 'bogus' }],
      [{ op: 'updateSection', sectionId: 's1', props: { headline: 'ok', onclick: 'x' } }],
      [
        {
          op: 'addSection',
          pageId: 'home',
          section: { id: 's1', type: 'map', variant: 'link-card', visible: true, props: {} },
        },
      ],
      [{ op: 'updateSection', sectionId: 'missing', visible: false }],
      [{ op: 'removeSection', sectionId: 'missing' }],
      [
        {
          op: 'addSection',
          pageId: 'missing',
          section: { id: 'z', type: 'map', variant: 'link-card', visible: true, props: {} },
        },
      ],
    ]) {
      const r = applyPatch(cfg, patch);
      expect(r.ok).toBe(false);
    }
    expect(cfg.pages[0]?.sections[0]?.id).toBe('s1');
  });
  it('does not allow prototype pollution through merge keys', () => {
    const r = applyPatch(
      base(),
      JSON.parse('[{"op":"updateBusiness","value":{"__proto__":{"polluted":true}}}]'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.ok === false || r.ok === true).toBe(true);
  });
});
