import { describe, expect, it } from 'vitest';
import {
  STATIC_CSS,
  buildRobots,
  buildSitemap,
  clip,
  escapeHtml,
  localBusinessJsonLd,
  renderDocument,
  safeJsonForScript,
  type DocumentResult,
} from './index';
import { allDefaultSections, baseConfig, parsed } from './test-helpers';

const ORIGIN = 'https://iron-pulse.sites.example.test';
const config = (sections: unknown[] = allDefaultSections(), extra = {}) => baseConfig(sections, extra);
const ok = (r: DocumentResult) => {
  if (r.kind !== 'page') throw new Error(`expected page, got ${r.kind}`);
  return r;
};
const render = (cfg: unknown, path = '/', extra = {}) =>
  renderDocument({ config: cfg, path, origin: ORIGIN, mode: 'public', ...extra });

describe('renderDocument: a complete, script-free page', () => {
  const r = ok(render(config()));
  it('is a full HTML5 document with lang, viewport, title and description', () => {
    expect(r.status).toBe(200);
    expect(r.html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">')).toBe(true);
    expect(r.html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(r.html).toContain('<title>Iron Pulse Fitness - Premium weight training in Indore</title>');
    expect(r.html).toContain('<meta name="description" content="Premium weight training in Indore">');
    expect(r.html).toContain('<main id="main">');
  });
  it('ships no JavaScript at all (only a JSON-LD data block)', () => {
    const scripts = [...r.html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="application/ld+json">']);
    expect(r.html).not.toMatch(/\son[a-z]+=|javascript:|<iframe|<link[^>]+stylesheet/i);
  });
  it('has exactly two inline stylesheets, reported verbatim for the CSP hashes', () => {
    expect(r.inlineStyles).toHaveLength(2);
    expect(r.inlineStyles[0]).toBe(STATIC_CSS);
    for (const css of r.inlineStyles) expect(r.html).toContain(`<style>${css}</style>`);
    expect(r.inlineStyles[1]).toContain(':root{--color-primary:#1d4ed8');
    expect(r.inlineStyles[1]).toContain('@font-face{font-family:"Poppins"');
  });
  it('is indexable with canonical, robots and Open Graph metadata', () => {
    expect(r.indexable).toBe(true);
    expect(r.html).toContain('<link rel="canonical" href="https://iron-pulse.sites.example.test/">');
    expect(r.html).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(r.html).toContain('<meta property="og:type" content="website">');
    expect(r.html).toContain('<meta property="og:url" content="https://iron-pulse.sites.example.test/">');
    expect(r.html).toContain('<meta property="og:locale" content="en_IN">');
    expect(r.html).toContain('<meta name="twitter:card" content="summary">');
  });
  it('preloads only Latin fonts and carries an inline favicon', () => {
    const preloads = [...r.html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(preloads).toEqual([
      '/fonts/inter-latin-400-normal.woff2',
      '/fonts/poppins-latin-700-normal.woff2',
    ]);
    expect(r.html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
  });
  it('renders the page chrome and every section, with a single h1', () => {
    expect(r.html).toContain('class="pb-header');
    expect(r.html).toContain('class="pb-footer');
    expect(r.html).toContain('class="pb-float"');
    expect(r.html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(r.html.match(/<section /g)?.length).toBe(24);
  });
  it('adds a visually hidden h1 when no block provides one', () => {
    const cfg = config([{ id: 's1', type: 'map', variant: 'link-card', visible: true, props: {} }]);
    const out = ok(render(cfg));
    expect(out.html).toContain('<h1 class="pb-sr-only">Home</h1>');
  });
});

describe('SEO per page and mode', () => {
  const two = () =>
    config([{ id: 's1', type: 'map', variant: 'link-card', visible: true, props: {} }], {
      pages: [
        { id: 'home', path: '/', title: 'Home', sections: [] },
        {
          id: 'about',
          path: '/about',
          title: 'About',
          seo: { title: 'About Iron Pulse', description: 'Our story', noindex: false },
          sections: [],
        },
        { id: 'secret', path: '/thanks', title: 'Thanks', seo: { noindex: true }, sections: [] },
      ],
    });
  it('uses the page SEO fields, a self-canonical and no structured data outside the home page', () => {
    const r = ok(render(two(), '/about'));
    expect(r.html).toContain('<title>About Iron Pulse</title>');
    expect(r.html).toContain('<meta name="description" content="Our story">');
    expect(r.html).toContain('href="https://iron-pulse.sites.example.test/about"');
    expect(r.html).not.toContain('application/ld+json');
  });
  it('falls back to "Page | Business" and tolerates a trailing slash', () => {
    const cfg = config([], {
      pages: [
        { id: 'home', path: '/', title: 'Home', sections: [] },
        { id: 'about', path: '/about', title: 'About', sections: [] },
      ],
    });
    expect(ok(render(cfg, '/about/')).html).toContain('<title>About | Iron Pulse Fitness</title>');
  });
  it('a noindex page is not indexable and says so', () => {
    const r = ok(render(two(), '/thanks'));
    expect(r.indexable).toBe(false);
    expect(r.html).toContain('<meta name="robots" content="noindex,nofollow">');
  });
  it('preview, draft and forced-noindex renders are never indexable, without canonical or structured data', () => {
    for (const extra of [{ mode: 'preview' }, { mode: 'draft' }, { noindex: true }]) {
      const r = ok(render(two(), '/', extra));
      expect(r.indexable, JSON.stringify(extra)).toBe(false);
      expect(r.html).toContain('content="noindex,nofollow"');
      expect(r.html).not.toContain('rel="canonical"');
      expect(r.html).not.toContain('application/ld+json');
      expect(r.html).not.toContain('og:url');
    }
  });
  it('Open Graph image uses the 1200 px variant when the asset exists', () => {
    const cfg = config([], {
      pages: [
        {
          id: 'home',
          path: '/',
          title: 'Home',
          seo: { ogImage: { assetId: 'og-1', alt: 'Our gym' }, noindex: false },
          sections: [],
        },
      ],
    });
    const r = ok(
      render(cfg, '/', { assetUrl: (id: string, w: number) => `https://cdn.example.test/${id}-${w}.webp` }),
    );
    expect(r.html).toContain('<meta property="og:image" content="https://cdn.example.test/og-1-1200.webp">');
    expect(r.html).toContain('<meta property="og:image:alt" content="Our gym">');
    expect(r.html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(r.html).toContain('"image":"https://cdn.example.test/og-1-1200.webp"');
    expect(ok(render(cfg)).html).not.toContain('og:image');
  });
  it('preloads the first image (LCP) with its responsive sources, and only when it exists', () => {
    const hero = {
      id: 's1',
      type: 'hero',
      variant: 'split-image',
      visible: true,
      props: { headline: 'Hi', image: { assetId: 'hero-1', alt: 'Gym floor' } },
    };
    const assetUrl = (id: string, w: number) => `https://cdn.example.test/${id}-${w}.webp`;
    const withAssets = ok(render(config([hero]), '/', { assetUrl })).html;
    expect(withAssets).toContain(
      '<link rel="preload" as="image" imagesrcset="https://cdn.example.test/hero-1-400.webp 400w, https://cdn.example.test/hero-1-800.webp 800w, https://cdn.example.test/hero-1-1200.webp 1200w, https://cdn.example.test/hero-1-1600.webp 1600w" imagesizes="(min-width: 1024px) 50vw, 100vw" fetchpriority="high">',
    );
    expect(withAssets.indexOf('rel="preload" as="image"')).toBeLessThan(withAssets.indexOf('<style>'));
    expect(ok(render(config([hero]))).html).not.toContain('as="image"');
  });
  it('speaks Hindi: lang, locale and the 404 page', () => {
    const cfg = config([], { business: { ...baseConfig().business, language: 'hi' } });
    const r = ok(render(cfg));
    expect(r.html).toContain('<html lang="hi">');
    expect(r.html).toContain('og:locale" content="hi_IN"');
    expect(ok(render(cfg, '/missing')).html).toContain('पेज नहीं मिला');
  });
});

describe('404 for a page that does not exist on a valid site', () => {
  it('is a branded page with the site chrome, status 404, noindex, and a way home', () => {
    const r = ok(render(config(), '/nope'));
    expect(r.status).toBe(404);
    expect(r.indexable).toBe(false);
    expect(r.html).toContain('Page not found');
    expect(r.html).toContain('href="/"');
    expect(r.html).toContain('class="pb-header');
    expect(r.html).toContain('noindex,nofollow');
    expect(r.html).not.toContain('application/ld+json');
  });
});

describe('structured data (category JSON-LD)', () => {
  const ld = (cfg: unknown) => {
    const m = ok(render(cfg)).html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    return JSON.parse(m?.[1] ?? 'null') as Record<string, unknown>;
  };
  it('describes the business with the schema.org type of its category', () => {
    const data = ld(config());
    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'ExerciseGym',
      name: 'Iron Pulse Fitness',
      url: `${ORIGIN}/`,
      telephone: '+919800000000',
      email: 'hello@example.com',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '12 MG Road',
        addressLocality: 'Indore',
        postalCode: '452001',
      },
      sameAs: ['https://instagram.com/ironpulse'],
    });
    expect(JSON.stringify(data)).toContain('"dayOfWeek":["Monday","Tuesday"]');
  });
  it('maps every category and omits what the business did not provide', () => {
    const base = parsed(config());
    for (const [category, type] of [
      ['taxi', 'TaxiService'],
      ['salon', 'BeautySalon'],
      ['clinic', 'MedicalClinic'],
      ['restaurant', 'Restaurant'],
      ['generic', 'LocalBusiness'],
    ] as const) {
      expect(
        localBusinessJsonLd({ ...base, business: { ...base.business, category } }, ORIGIN, null)['@type'],
      ).toBe(type);
    }
    const bare = localBusinessJsonLd(
      { ...base, business: { name: 'X', category: 'generic', language: 'en' } },
      ORIGIN,
      null,
    );
    expect(Object.keys(bare).sort()).toEqual(['@context', '@type', 'inLanguage', 'name', 'url']);
  });
  it('cannot be closed early: hostile names are escaped inside the data block', () => {
    expect(safeJsonForScript({ n: '</script><script>alert(1)</script>&\u2028' })).not.toMatch(/[<>&\u2028]/);
    const cfg = config([], { business: { ...baseConfig().business, name: 'Tom & Jerry "Gym" it\'s' } });
    const html = ok(render(cfg)).html;
    expect(html).toContain(
      '<title>Tom &amp; Jerry &quot;Gym&quot; it&#39;s - Premium weight training in Indore</title>',
    );
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(ld(cfg)['name']).toBe('Tom & Jerry "Gym" it\'s');
  });
});

describe('sitemap.xml and robots.txt', () => {
  const cfg = parsed(
    config([], {
      pages: [
        { id: 'home', path: '/', title: 'Home', sections: [] },
        { id: 'about', path: '/about', title: 'About', sections: [] },
        { id: 'thanks', path: '/thanks', title: 'Thanks', seo: { noindex: true }, sections: [] },
      ],
    }),
  );
  it('lists indexable pages only, as absolute URLs, with an optional lastmod', () => {
    const xml = buildSitemap(cfg, ORIGIN, new Date('2026-11-05T10:00:00Z'));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<loc>${ORIGIN}/</loc><lastmod>2026-11-05T10:00:00.000Z</lastmod>`);
    expect(xml).toContain(`<loc>${ORIGIN}/about</loc>`);
    expect(xml).not.toContain('/thanks');
    expect(buildSitemap(cfg, ORIGIN)).not.toContain('lastmod');
    expect(buildSitemap(cfg, ORIGIN, new Date('nope'))).not.toContain('lastmod');
  });
  it('robots.txt points crawlers at the sitemap, or blocks everything when not indexable', () => {
    expect(buildRobots(ORIGIN, true)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    expect(buildRobots(ORIGIN, false)).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('failure paths: never throws, never leaks', () => {
  it('invalid configs are reported with issues and nothing is rendered', () => {
    for (const bad of [null, 'x', {}, { schemaVersion: '9.9' }, { ...config(), theme: { nope: 1 } }]) {
      const r = render(bad);
      expect(r.kind).toBe('invalid');
    }
    const r = render({
      ...config(),
      business: { ...baseConfig().business, name: '<script>alert(1)</script>' },
    });
    expect(r.kind).toBe('invalid');
  });
  it('rejects an origin that is not a plain scheme and host', () => {
    for (const origin of [
      '',
      'javascript:alert(1)',
      'https://a.test/path',
      'https://a.test"><script>',
      'ftp://a.test',
    ]) {
      expect(renderDocument({ config: config(), path: '/', origin, mode: 'public' }).kind).toBe('error');
    }
  });
  it('escapeHtml and clip behave on edge cases', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…');
  });
});

describe('base path and banner (preview links live under /p/<token>)', () => {
  const BASE = '/p/v1.abc_DEF-123.sig';
  const homeSections = [
    {
      id: 'hero1',
      type: 'hero',
      variant: 'centered',
      visible: true,
      props: {
        headline: 'Hello',
        primaryCta: { label: 'About us', action: 'link', target: '/about' },
        secondaryCta: { label: 'Services', action: 'scroll', target: '#svc' },
      },
    },
    { id: 'svc', type: 'services', variant: 'list', visible: true, props: { items: [{ title: 'One' }] } },
    {
      id: 'story',
      type: 'about',
      variant: 'text-only',
      visible: true,
      props: {
        heading: 'About',
        body: [
          { type: 'link', text: 'our rates', href: '/about' },
          { type: 'link', text: 'outside', href: 'https://example.com' },
        ],
      },
    },
  ];
  const twoPages = () =>
    config([], {
      pages: [
        { id: 'home', path: '/', title: 'Home', sections: homeSections },
        { id: 'about', path: '/about', title: 'About', sections: [] },
      ],
      navigation: {
        items: [
          { label: 'Home', target: '/' },
          { label: 'About', target: '/about' },
          { label: 'Top', target: '/#svc' },
        ],
        cta: { label: 'Call', action: 'tel' },
      },
    });

  it('prefixes every in-site link (brand, menu, buttons, rich text, footer) and nothing else', () => {
    const r = ok(
      render(twoPages(), '/', {
        mode: 'preview',
        basePath: BASE,
        banner: 'Preview of Gym Bold. Demo content.',
      }),
    );
    const hrefs = [...r.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string);
    const internal = hrefs.filter((h) => h.startsWith('/') && !h.startsWith('/fonts/'));
    expect(internal.length).toBeGreaterThan(6);
    for (const h of internal) expect(h === BASE || h.startsWith(`${BASE}/`), h).toBe(true);
    expect(hrefs).toContain(BASE);
    expect(hrefs).toContain(`${BASE}/about`);
    expect(hrefs).toContain(`${BASE}/#svc`);
    expect(hrefs).toContain('#svc');
    expect(hrefs).toContain('#main');
    expect(hrefs).toContain('https://example.com');
  });

  it('marks the current page in the menu under a base path', () => {
    const r = ok(render(twoPages(), '/about', { mode: 'preview', basePath: BASE }));
    expect(r.html).toContain('aria-current="page">About</span>');
  });

  it('the 404 page links home inside the base path, and the banner is escaped text above the header', () => {
    const r = ok(
      render(twoPages(), '/missing', { mode: 'preview', basePath: BASE, banner: 'Preview "Gym" <b>x</b>' }),
    );
    expect(r.status).toBe(404);
    expect(r.html).toContain(`<a class="pb-btn pb-btn--primary" href="${BASE}">`);
    expect(r.html).toContain('<div class="pb-banner" role="note">Preview "Gym" &lt;b&gt;x&lt;/b&gt;</div>');
    expect(r.html.indexOf('pb-banner')).toBeLessThan(r.html.indexOf('<header'));
  });

  it('without a base path or a banner nothing changes; a malformed base path is refused', () => {
    const plain = ok(render(twoPages(), '/'));
    expect(plain.html).not.toContain('class="pb-banner"');
    expect(plain.html).toContain('<a class="pb-brand" href="/">');
    for (const basePath of [
      'p/x',
      '/',
      '//evil.com',
      '/p/x y',
      '/p/<x>',
      '/a/b/c/d',
      '/p/x"onmouseover=',
      '/..%2f',
    ]) {
      expect(
        renderDocument({ config: twoPages(), path: '/', origin: ORIGIN, mode: 'preview', basePath }).kind,
        basePath,
      ).toBe('error');
    }
  });
});
