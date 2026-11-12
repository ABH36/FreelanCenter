/**
 * P2 S6: preview and pitch links (FR-TPL-09). Real token verification and renderer; the catalogue is a stub that
 * serves the committed seed file (what the database holds after `db:seed-templates`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogTemplate } from '@platform/db/public';
import { createHostResolver } from '@platform/hosting';
import { mintPreviewToken } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import { clearPreviewCache, type PreviewDeps } from './preview';
import { previewSettings } from './preview-settings';
import { serveHost } from './serve';

const SECRET = 's'.repeat(40);
const PREVIOUS = 'p'.repeat(40);
const HOST = 'preview.sites.example.test';
const TPL_IDS: Record<string, string> = {
  'gym-bold': '01920000-0000-7000-8000-0000000000a1',
  'taxi-quick': '01920000-0000-7000-8000-0000000000a2',
  'wedding-royal': '01920000-0000-7000-8000-0000000000a3',
};
const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';

const seed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../packages/templates/seed/builtin-templates.json', import.meta.url)),
    'utf8',
  ),
) as {
  templates: {
    slug: string;
    name: string;
    category: string;
    schemaVersion: string;
    config: unknown;
    manifest: unknown;
    contentHash: string;
  }[];
};

const catalogue = new Map<string, CatalogTemplate>(
  seed.templates.map((t) => [
    TPL_IDS[t.slug] as string,
    {
      templateId: TPL_IDS[t.slug] as string,
      slug: t.slug,
      name: t.name,
      category: t.category,
      visibility: 'platform',
      version: 1,
      schemaVersion: t.schemaVersion,
      config: t.config,
      manifest: t.manifest,
      contentHash: t.contentHash,
    },
  ]),
);

const logs: { message: string; data: unknown }[] = [];
const logger = {
  debug() {},
  info() {},
  warn: (message: string, data?: unknown) => logs.push({ message, data }),
  error() {},
  fatal() {},
} as never;

const calls: { id: string; version: number | undefined }[] = [];
const revocationChecks: string[] = [];
const revoked = new Set<string>();
let now = new Date('2026-11-05T12:00:00Z');

function setup(options: { preview?: Partial<PreviewDeps> | null } = {}) {
  const resolver = createHostResolver({
    cache: createMemoryStore(),
    lookup: async () => ({ outcome: 'placeholder', workspaceId: W, projectId: P }),
  });
  const previewDeps: PreviewDeps | null =
    options.preview === null
      ? null
      : {
          host: HOST,
          secrets: { current: SECRET, previous: PREVIOUS },
          logger,
          now: () => now,
          isRevoked: async (linkId) => {
            revocationChecks.push(linkId);
            return revoked.has(linkId);
          },
          catalog: async (id, version) => {
            calls.push({ id, version });
            const found = catalogue.get(id);
            return found && (version === undefined || version === found.version) ? found : null;
          },
          ...options.preview,
        };
  const get = (path: string, init: { host?: string; method?: string } = {}) =>
    serveHost(
      new Request(`http://internal${path}`, {
        method: init.method ?? 'GET',
        headers: { host: init.host ?? HOST },
      }),
      { resolver: async () => resolver, logger, preview: async () => previewDeps },
    );
  return { get };
}

const mint = (
  slug: string,
  extra: Parameters<typeof mintPreviewToken>[1] extends infer O ? Partial<O> : never = {},
  secret = SECRET,
) => mintPreviewToken(secret, { templateId: TPL_IDS[slug] as string, now, ...extra });

beforeEach(() => {
  clearPreviewCache();
  calls.length = 0;
  revocationChecks.length = 0;
  revoked.clear();
  logs.length = 0;
  now = new Date('2026-11-05T12:00:00Z');
});

describe('a valid link', () => {
  it('shows the template with demo data: 200, noindex, no referrer, no JavaScript, a visible demo banner', async () => {
    const { get } = setup();
    const token = mint('gym-bold');
    const res = await get(`/p/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/unsafe-inline|script-src/);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('<script');
    expect(html).toContain(
      'Preview of the &quot;Gym Bold&quot; template: demo content, not a live website.'
        .replace('&quot;', '"')
        .replace('&quot;', '"'),
    );
    expect(html).toContain('Iron Pulse Fitness');
  });

  it('keeps the visitor inside the link: every in-site link, including other pages, carries the token', async () => {
    const { get } = setup();
    const token = mint('taxi-quick');
    const home = await (await get(`/p/${token}`)).text();
    const hrefs = [...home.matchAll(/href="(\/[^"]*)"/g)]
      .map((m) => m[1] as string)
      .filter((h) => !h.startsWith('/fonts/'));
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) {
      expect(h === `/p/${token}` || h.startsWith(`/p/${token}/`) || h.startsWith(`/p/${token}#`), h).toBe(
        true,
      );
    }
    expect(hrefs).toContain(`/p/${token}/rates`);
    const rates = await get(`/p/${token}/rates`);
    expect(rates.status).toBe(200);
    expect(await rates.text()).toContain('Our rates');
    const trailing = await get(`/p/${token}/rates/`);
    expect(trailing.status).toBe(200);
  });

  it('personalises the demo with the prospect name (header, footer, title) and escapes it', async () => {
    const { get } = setup();
    const res = await get(`/p/${mint('wedding-royal', { prospectName: 'Sharma & Sons "Events"' })}`);
    const html = await res.text();
    expect(html).toContain(
      '<title>Sharma &amp; Sons &quot;Events&quot; | Wedding and event planners</title>',
    );
    expect(html).toContain('Sharma &amp; Sons "Events"');
  });

  it('an unknown page inside a valid link is a 404 page that still looks like the site and links back into the preview', async () => {
    const { get } = setup();
    const token = mint('gym-bold');
    const res = await get(`/p/${token}/nothing-here`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('Page not found');
    expect(html).toContain(`href="/p/${token}"`);
    expect(html).toContain('class="pb-banner"');
  });

  it('HEAD answers like GET without a body', async () => {
    const { get } = setup();
    const res = await get(`/p/${mint('gym-bold')}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('pins a version when the link names one, and caches the catalogue read', async () => {
    const { get } = setup();
    const pinned = mint('gym-bold', { version: 1 });
    await get(`/p/${pinned}`);
    await get(`/p/${pinned}/`);
    await get(`/p/${pinned}#x`);
    expect(calls).toEqual([{ id: TPL_IDS['gym-bold'], version: 1 }]);
    await get(`/p/${mint('gym-bold')}`);
    expect(calls).toHaveLength(2);
  });

  it('local development uses http and keeps the port', async () => {
    const { get } = setup({ preview: { host: 'preview.sites.localhost' } });
    const res = await get(`/p/${mint('gym-bold')}`, { host: 'preview.sites.localhost:3001' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });
});

describe('refused links never reach the catalogue', () => {
  it('tampered, forged, wrongly-signed and malformed tokens are a uniform 404', async () => {
    const { get } = setup();
    const good = mint('gym-bold');
    const [h, p, s] = good.split('.') as [string, string, string];
    const wrongSecret = mint('gym-bold', {}, 'x'.repeat(40));
    for (const path of [
      `/p/${h}.${p}x.${s}`,
      `/p/${h}.${p}.${s}x`,
      `/p/${wrongSecret}`,
      '/p/not-a-token',
      '/p/',
      '/p',
      `/p/v1.${p}`,
      `/p/${'a'.repeat(701)}`,
      '/',
      '/anything',
      '/about',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain('not valid');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(calls).toEqual([]);
  });

  it('an expired link is 410 with a clear message; one second earlier it still works', async () => {
    const { get } = setup();
    const token = mint('gym-bold', { lifetimeSeconds: 3600 });
    now = new Date(now.getTime() + 3599_000);
    expect((await get(`/p/${token}`)).status).toBe(200);
    now = new Date(now.getTime() + 1_000);
    const expired = await get(`/p/${token}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('has expired');
    expect(expired.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('a validly signed link to a template that is not published (or does not exist) is the same 404', async () => {
    const { get } = setup();
    const ghost = mintPreviewToken(SECRET, { templateId: '01920000-0000-7000-8000-0000000000ff', now });
    const res = await get(`/p/${ghost}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not valid');
    expect((await get(`/p/${mint('gym-bold', { version: 7 })}`)).status).toBe(404);
  });

  it('a link minted with the previous secret works while it is configured, and stops without it', async () => {
    const withBoth = setup();
    const old = mint('gym-bold', {}, PREVIOUS);
    expect((await withBoth.get(`/p/${old}`)).status).toBe(200);
    clearPreviewCache();
    const without = setup({ preview: { secrets: { current: SECRET } } });
    expect((await without.get(`/p/${old}`)).status).toBe(404);
  });

  it('robots.txt on the preview host disallows everything', async () => {
    const { get } = setup();
    const res = await get('/robots.txt');
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('scope', () => {
  it('only the preview host serves previews: a tenant host with the same path is an ordinary site', async () => {
    const { get } = setup();
    const res = await get(`/p/${mint('gym-bold')}`, { host: 'sharma.sites.example.test' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('coming soon');
  });

  it('when previews are not configured the preview host is just an unknown-host lookup', async () => {
    const { get } = setup({ preview: null });
    const res = await get(`/p/${mint('gym-bold')}`);
    expect(await res.text()).toContain('coming soon'); // the stub resolver says "live host"; nothing preview-specific happens
    expect(calls).toEqual([]);
  });

  it('a catalogue failure is a 503, not a crash, and is not cached as a missing template', async () => {
    let fail = true;
    const { get } = setup({
      preview: {
        catalog: async (id) => {
          if (fail) throw new Error('db down');
          return catalogue.get(id) ?? null;
        },
      },
    });
    const token = mint('gym-bold');
    expect((await get(`/p/${token}`)).status).toBe(503);
    fail = false;
    expect((await get(`/p/${token}`)).status).toBe(200);
  });
});

describe('previewSettings (environment)', () => {
  const ok = { PREVIEW_HOST: 'Preview.Sites.Example.test', PREVIEW_TOKEN_SECRET: 'k'.repeat(32) };
  it('is on only with a valid host and a long enough secret; the host is normalised', () => {
    expect(previewSettings(ok)).toEqual({
      host: 'preview.sites.example.test',
      secrets: { current: 'k'.repeat(32) },
    });
    expect(previewSettings({ ...ok, PREVIEW_TOKEN_SECRET_PREVIOUS: 'o'.repeat(32) })?.secrets.previous).toBe(
      'o'.repeat(32),
    );
    expect(
      previewSettings({ ...ok, PREVIEW_TOKEN_SECRET_PREVIOUS: 'short' })?.secrets.previous,
    ).toBeUndefined();
  });
  it('is off when anything is missing, too short or malformed', () => {
    expect(previewSettings({})).toBeNull();
    expect(previewSettings({ ...ok, PREVIEW_TOKEN_SECRET: 'short' })).toBeNull();
    expect(previewSettings({ ...ok, PREVIEW_TOKEN_SECRET: undefined })).toBeNull();
    expect(previewSettings({ ...ok, PREVIEW_HOST: undefined })).toBeNull();
    expect(previewSettings({ ...ok, PREVIEW_HOST: 'not a host!' })).toBeNull();
  });
});

describe('revoked links (P2 S8b)', () => {
  const LID = '01920000-0000-7000-8000-0000000000b1';
  afterEach(() => vi.useRealTimers());

  it('a link that carries an id and was revoked is 410 "withdrawn", with no template read', async () => {
    revoked.add(LID);
    const { get } = setup();
    const res = await get(`/p/${mint('gym-bold', { linkId: LID })}`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('This preview link was withdrawn');
    expect(html).not.toContain('Iron Pulse');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(calls).toEqual([]);
  });

  it('an active link with an id is served and asked about once, then the answer is cached', async () => {
    const { get } = setup();
    const token = mint('gym-bold', { linkId: LID });
    expect((await get(`/p/${token}`)).status).toBe(200);
    expect((await get(`/p/${token}/about`)).status).toBe(404); // another path of the same link
    expect(revocationChecks).toEqual([LID]);
  });

  it('a revocation reaches a warm instance within the cache window (30 s), and a revoked answer sticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const { get } = setup();
    const token = mint('gym-bold', { linkId: LID });
    expect((await get(`/p/${token}`)).status).toBe(200);
    revoked.add(LID);
    expect((await get(`/p/${token}`)).status).toBe(200); // still inside the window
    vi.setSystemTime(new Date('2026-11-05T12:00:31Z'));
    expect((await get(`/p/${token}`)).status).toBe(410);
    revoked.delete(LID); // cannot happen in the database (trigger); the answer is kept anyway
    vi.setSystemTime(new Date('2026-11-05T12:01:00Z'));
    expect((await get(`/p/${token}`)).status).toBe(410);
  });

  it('fails closed: if the revocation check cannot be answered the link is a 503, never served', async () => {
    const { get } = setup({
      preview: {
        isRevoked: async () => {
          throw new Error('db down');
        },
      },
    });
    const res = await get(`/p/${mint('gym-bold', { linkId: LID })}`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('Iron Pulse');
  });

  it('links without an id (made before S8b or by the operator script) are never looked up', async () => {
    const { get } = setup();
    expect((await get(`/p/${mint('gym-bold')}`)).status).toBe(200);
    expect(revocationChecks).toEqual([]);
  });

  it('the longest possible link (id, version, 60-character prospect name) still renders', async () => {
    const { get } = setup();
    const token = mint('gym-bold', { linkId: LID, version: 1, prospectName: 'ए'.repeat(60) });
    expect(token.length).toBeLessThanOrEqual(700);
    expect((await get(`/p/${token}`)).status).toBe(200);
  });

  it('forged, tampered and expired links never cause a revocation lookup', async () => {
    const { get } = setup();
    const good = mint('gym-bold', { linkId: LID });
    await get(`/p/${good.slice(0, -1)}X`);
    await get(`/p/${mint('gym-bold', { linkId: LID }, 'x'.repeat(40))}`);
    now = new Date('2026-11-20T12:00:00Z');
    await get(`/p/${good}`);
    expect(revocationChecks).toEqual([]);
  });
});

describe('personalising with a long name', () => {
  it('a 60-character name never makes the preview invalid (texts are cut to the schema limits), emoji included', async () => {
    const { get } = setup();
    for (const name of ['W'.repeat(60), '😀'.repeat(30), 'ए'.repeat(60)]) {
      const res = await get(`/p/${mint('wedding-royal', { prospectName: name })}`);
      expect(res.status, name.slice(0, 4)).toBe(200);
    }
    expect(logs.filter((l) => l.message === 'sites.preview.render_failed')).toEqual([]);
  });
});

describe('making the demo the prospect’s (P2 S10, acceptance run 2)', () => {
  it('uses the prospect’s city everywhere and drops the demo street, state, postcode and map position', async () => {
    const { get } = setup();
    const res = await get(
      `/p/${mint('taxi-quick', { prospectName: 'City Cabs Indore', prospectCity: 'Indore' })}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('City Cabs Indore');
    expect(html).toContain('Indore');
    expect(html).not.toContain('Jaipur');
    expect(html).not.toContain('Station Road');
  });
  it('the banner names the prospect, and demo social accounts are never linked', async () => {
    const { get } = setup();
    const html = await (
      await get(`/p/${mint('wedding-royal', { prospectName: 'Royal Vivah Events' })}`)
    ).text();
    expect(html).toContain('Website preview for "Royal Vivah Events"');
    expect(html).not.toMatch(/instagram\.com|facebook\.com/);
  });
  it('reviews and team members are marked as samples in a preview', async () => {
    const { get } = setup();
    const html = await (await get(`/p/${mint('gym-bold')}`)).text();
    expect(html).toContain('class="pb-sample"');
  });
  it('a city that would push a text over its limit still renders (the careful fallback is used)', async () => {
    const { get } = setup();
    const res = await get(
      `/p/${mint('gym-bold', { prospectName: 'W'.repeat(60), prospectCity: 'X'.repeat(40) })}`,
    );
    expect(res.status).toBe(200);
  });
});
