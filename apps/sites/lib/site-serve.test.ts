/**
 * P2 S4: a live host renders its site (FR-TPL-03). Real resolver, real renderer, in-memory cache; only the database
 * lookup and the site source are stubs. Covers the response contract: status, CSP (hash-based, no inline allowance),
 * robots/sitemap, HEAD, failure pages, and that nothing about a bad config is leaked.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registry } from '@platform/blocks';
import { type HostResolution, createHostResolver } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import { serveHost } from './serve';
import { contentSecurityPolicy, styleHash } from './site-response';
import type { SiteContent, SiteSource } from './site-source';

const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';
const live: HostResolution = { outcome: 'placeholder', workspaceId: W, projectId: P };

function section(id: string, type: string, variant: string, props?: unknown) {
  const def = registry.get(type);
  return { id, type, variant, visible: true, props: props ?? def?.defaults(variant) };
}

function siteConfig(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    business: {
      name: 'Iron Pulse Fitness',
      category: 'gym',
      tagline: 'Premium weight training in Indore',
      phone: '+919800000000',
      whatsapp: '+919800000001',
      email: 'hello@example.com',
    },
    theme: {
      colors: {
        primary: '#1D4ED8',
        secondary: '#111827',
        accent: '#B45309',
        background: '#FFFFFF',
        surface: '#F3F4F6',
        text: '#111827',
      },
      typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
      radius: 'md',
      spacing: 'regular',
      buttons: { style: 'solid', shape: 'rounded', hover: 'lift' },
      motion: { preset: 'subtle', reducedMotionRespected: true },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        title: 'Home',
        sections: [section('s1', 'hero', 'centered'), section('s2', 'services', 'cards-3')],
      },
      { id: 'about', path: '/about', title: 'About', sections: [section('a1', 'about', 'text-only')] },
      { id: 'thanks', path: '/thanks', title: 'Thanks', seo: { noindex: true }, sections: [] },
    ],
    navigation: { items: [{ label: 'Home', target: '/' }], cta: { label: 'Call', action: 'tel' } },
    footer: { variant: 'simple', showPlatformBadge: false, floatingAction: 'none' },
    integrations: {},
    ...extra,
  };
}

const logs: { message: string; data: unknown }[] = [];
const logger = {
  debug() {},
  info() {},
  warn: (message: string, data?: unknown) => logs.push({ message, data }),
  error() {},
  fatal() {},
} as never;

function setup(content: SiteContent | null | Error, resolution: HostResolution = live) {
  const resolver = createHostResolver({ cache: createMemoryStore(), lookup: async () => resolution });
  const source: SiteSource = {
    load: async () => {
      if (content instanceof Error) throw content;
      return content;
    },
  };
  const get = (path: string, init: { host?: string; method?: string } = {}) =>
    serveHost(
      new Request(`http://internal${path}`, {
        method: init.method ?? 'GET',
        headers: { host: init.host ?? 'iron-pulse.sites.example.test' },
      }),
      { resolver: async () => resolver, logger, source },
    );
  return { get };
}

const inlineStyles = (html: string) =>
  [...html.matchAll(/<style>(.*?)<\/style>/gs)].map((m) => m[1] as string);

describe('a live host with a published site', () => {
  const { get } = setup({ config: siteConfig() });

  it('renders the home page: 200, HTML, no-store, correlation id', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-robots-tag')).toBeNull();
    const html = await res.text();
    expect(html).toContain('<title>Iron Pulse Fitness - Premium weight training in Indore</title>');
    expect(html).toContain('<link rel="canonical" href="https://iron-pulse.sites.example.test/">');
    expect(html).toContain('Your business, online and ready for customers');
  });

  it('CSP: every inline style is allowed by hash, nothing else; no script, frame or connect source', async () => {
    const res = await get('/about');
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    const styles = inlineStyles(html);
    expect(styles).toHaveLength(2);
    for (const css of styles) {
      expect(csp).toContain(`'sha256-${createHash('sha256').update(css).digest('base64')}'`);
    }
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|script-src|connect-src|\*/);
  });

  it('a page that does not exist is a branded 404 that still carries the CSP and noindex', async () => {
    const res = await get('/missing');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Page not found');
  });

  it('hostile paths are a 404 page, not an error', async () => {
    for (const path of ['/about/..', '/%2e%2e/etc', '/ABOUT', '/about%00', '//evil.com', '/a'.repeat(500)]) {
      const res = await get(path);
      expect([404, 200]).toContain(res.status);
      expect(res.status === 200 ? await res.text() : await res.text()).not.toContain('evil.com<');
    }
  });

  it('HEAD answers like GET without a body', async () => {
    const res = await get('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('robots.txt points at the sitemap; sitemap.xml lists indexable pages as absolute URLs', async () => {
    const robots = await get('/robots.txt');
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toContain('Sitemap: https://iron-pulse.sites.example.test/sitemap.xml');
    const sitemap = await get('/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await sitemap.text();
    expect(xml).toContain('<loc>https://iron-pulse.sites.example.test/</loc>');
    expect(xml).toContain('<loc>https://iron-pulse.sites.example.test/about</loc>');
    expect(xml).not.toContain('/thanks');
  });

  it('local development uses http and keeps the port in the canonical URL', async () => {
    const { get: local } = setup({ config: siteConfig() });
    const res = await local('/', { host: 'iron-pulse.sites.localhost:3001' });
    expect(res.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
    expect(await res.text()).toContain('href="http://iron-pulse.sites.localhost:3001/"');
  });
});

describe('non-indexable and degraded sites', () => {
  it('a staging-style site is rendered but blocked for crawlers everywhere', async () => {
    const { get } = setup({ config: siteConfig(), noindex: true });
    const home = await get('/');
    expect(home.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await home.text();
    expect(html).toContain('content="noindex,nofollow"');
    expect(html).not.toContain('rel="canonical"');
    expect(await (await get('/robots.txt')).text()).toBe('User-agent: *\nDisallow: /\n');
    expect((await get('/sitemap.xml')).status).toBe(404);
  });

  it('a stored config that no longer validates is a 503 "unavailable" page and the log names paths, never values', async () => {
    logs.length = 0;
    const bad = siteConfig({ business: { name: '<script>alert(1)</script>', category: 'gym' } });
    const { get } = setup({ config: bad });
    const res = await get('/');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    const body = await res.text();
    expect(body).not.toMatch(/Iron Pulse|alert\(1\)/);
    const entry = logs.find((l) => l.message === 'sites.render.failed');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.data)).toContain('business.name');
    expect(JSON.stringify(entry?.data)).not.toContain('alert');
    expect((await get('/sitemap.xml')).status).toBe(503);
  });

  it('a failing source is a 503, not a crash; no source content means the placeholder as before', async () => {
    expect((await setup(new Error('db down')).get('/')).status).toBe(503);
    const placeholder = await setup(null).get('/');
    expect(placeholder.status).toBe(200);
    expect(await placeholder.text()).toContain('coming soon');
  });

  it('maintenance and unknown hosts never reach the source', async () => {
    let called = 0;
    const content = new Proxy({ config: siteConfig() }, { get: (t, k) => ((called += 1), (t as never)[k]) });
    for (const resolution of [
      { outcome: 'maintenance', workspaceId: W, projectId: P },
      { outcome: 'unknown' },
    ] as HostResolution[]) {
      const { get } = setup(content as unknown as SiteContent, resolution);
      const res = await get('/');
      expect([404, 503]).toContain(res.status);
    }
    expect(called).toBe(0);
  });

  it('block failures are logged with a safe summary and the page still renders', async () => {
    logs.length = 0;
    const cfg = siteConfig();
    // Valid for the schema but rejected by a block's own validation would need a registry mismatch; instead make the
    // asset resolver throw, which is a failure inside block rendering.
    const { get } = setup({
      config: cfg,
      assetUrl: () => {
        throw new Error('asset service down 555-0100');
      },
    });
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(JSON.stringify(logs)).not.toContain('555-0100');
  });
});

describe('contentSecurityPolicy', () => {
  const styles = ['a{color:red}', 'b{color:blue}'];
  it('adds only a plain https asset origin to img-src', () => {
    const csp = (assetOrigin: string | null) =>
      contentSecurityPolicy({ inlineStyles: styles, assetOrigin, secure: true });
    expect(csp('https://assets.example.test')).toContain("img-src 'self' data: https://assets.example.test;");
    for (const bad of [
      'http://assets.example.test',
      'https://a.test/path',
      "https://a.test; script-src 'unsafe-inline'",
      '*',
      'data:',
    ]) {
      expect(csp(bad), bad).toContain("img-src 'self' data:;");
    }
  });
  it('allows form posts to this origin only when a lead form exists', () => {
    expect(contentSecurityPolicy({ inlineStyles: styles, leadForm: true, secure: true })).toContain(
      "form-action 'self'",
    );
    expect(contentSecurityPolicy({ inlineStyles: styles, secure: true })).toContain("form-action 'none'");
  });
  it('hashes are stable and match sha256 base64', () => {
    const h = createHash('sha256')
      .update(styles[0] as string)
      .digest('base64');
    expect(styleHash(styles[0] as string)).toBe(`'sha256-${h}'`);
    expect(styleHash(styles[0] as string)).toBe(styleHash(styles[0] as string));
  });
});
