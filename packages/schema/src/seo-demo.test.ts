import { describe, expect, it } from 'vitest';
import { validConfig } from './fixtures';
import {
  type SiteConfig,
  applyPatch,
  clipSeoText,
  findDemoSeo,
  parseSiteConfig,
  replaceDemoSeo,
} from './index';

// P3 S9d (DG-40): the template's demo business name left in page search titles and descriptions.
const DEMO = 'Iron Pulse Fitness';

function site(name: string, seo: { title?: string; description?: string } = {}): SiteConfig {
  const c = validConfig();
  c.business.name = name;
  c.pages[0]!.seo = { ...c.pages[0]!.seo, ...seo } as never;
  const r = parseSiteConfig(c);
  if (!r.ok) throw new Error('fixture invalid');
  return r.config;
}

describe('findDemoSeo', () => {
  it('finds the demo name in a title or description, whatever its case and spacing', () => {
    const c = site('Sharma Fitness', {
      title: 'Iron Pulse Fitness | Gym in Indore',
      description: 'Train at IRON  PULSE fitness today',
    });
    expect(findDemoSeo(c, DEMO)).toEqual([
      { pageId: 'home', pageTitle: 'Home', fields: ['title', 'description'] },
    ]);
  });

  it('finds nothing once the texts are the business own, or when the business kept the demo name', () => {
    expect(
      findDemoSeo(site('Sharma Fitness', { title: 'Sharma Fitness', description: 'Weights' }), DEMO),
    ).toEqual([]);
    expect(findDemoSeo(site('Iron Pulse Fitness'), DEMO)).toEqual([]);
    expect(findDemoSeo(site('Sharma Fitness'), null)).toEqual([]);
    expect(findDemoSeo(site('Sharma Fitness'), '  ')).toEqual([]);
  });
});

describe('replaceDemoSeo', () => {
  it('builds one updatePage per affected page, which applies and leaves nothing behind', () => {
    const c = site('Sharma Fitness', {
      title: 'Iron Pulse Fitness | Gym',
      description: 'Join Iron Pulse Fitness.',
    });
    const ops = replaceDemoSeo(c, DEMO);
    expect(ops).toEqual([
      {
        op: 'updatePage',
        pageId: 'home',
        seo: {
          title: 'Sharma Fitness | Gym',
          description: 'Join Sharma Fitness.',
          ogImage: null,
          noindex: false,
        },
      },
    ]);
    const applied = applyPatch(c, ops);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(findDemoSeo(applied.config, DEMO)).toEqual([]);
  });

  it('keeps a longer business name within the title limit, cut at a word', () => {
    const long = 'Shri Ganesh Health and Fitness Club Vijay Nagar';
    const c = site(long, { title: 'Iron Pulse Fitness | Gym and personal training in Indore' });
    const [op] = replaceDemoSeo(c, DEMO);
    const title = (op as { seo: { title: string } }).seo.title;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.startsWith(long)).toBe(true);
    expect(title).not.toMatch(/[\s|]$/);
    expect(applyPatch(c, [op!]).ok).toBe(true);
  });

  it('a business name that contains the demo name is left alone (the texts may use its short form)', () => {
    // Real case: the integration template "Gupta Sweets" renamed to "Gupta Sweets 1234".
    const c = site('Iron Pulse Fitness Indore', {
      title: 'Iron Pulse Fitness | Gym',
      description: 'Weights',
    });
    expect(findDemoSeo(c, DEMO)).toEqual([]);
    expect(replaceDemoSeo(c, DEMO)).toEqual([]);
  });

  it('is empty when there is nothing to replace', () => {
    expect(replaceDemoSeo(site('Iron Pulse Fitness'), DEMO)).toEqual([]);
    expect(replaceDemoSeo(site('Sharma Fitness', { title: 'Sharma', description: 'x' }), DEMO)).toEqual([]);
  });
});

describe('clipSeoText', () => {
  it('cuts at a word boundary and drops a trailing separator', () => {
    expect(clipSeoText('short', 70)).toBe('short');
    expect(clipSeoText('Alpha Beta | Gamma Delta', 13)).toBe('Alpha Beta');
    expect(clipSeoText('x'.repeat(80), 70)).toHaveLength(70);
  });
});
