/**
 * P3 S7a: staging links (`/s/<token>` on the preview host) and the live version source. Real token verification,
 * resolver and renderer; the two app_public functions are stubs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StagingSite } from '@platform/db/public';
import { type HostResolution, createHostResolver, mintStagingToken } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import { serveHost } from './serve';
import { createVersionSiteSource, versionAssets } from './site-source';

const SECRET = 's'.repeat(40);
const HOST = 'preview.sites.example.test';
const LID = '01920000-0000-7000-8000-0000000000c1';
const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';
const V = '01920000-0000-7000-8000-000000000003';
const NOW = new Date('2026-11-15T12:00:00Z');

const seed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../packages/templates/seed/builtin-templates.json', import.meta.url)),
    'utf8',
  ),
) as { templates: { slug: string; config: { business: { name: string } } }[] };
const gym = seed.templates.find((t) => t.slug === 'gym-bold')!.config;

const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never;

function setup(site: StagingSite | Error, resolution: HostResolution = { outcome: 'unknown' }) {
  const lookups: string[] = [];
  const resolver = createHostResolver({ cache: createMemoryStore(), lookup: async () => resolution });
  const deps = {
    resolver: async () => resolver,
    logger,
    source: createVersionSiteSource(async (id) => {
      lookups.push(id);
      return { config: gym, assets: {}, publishedAt: NOW };
    }),
    preview: async () => ({
      host: HOST,
      secrets: { current: SECRET },
      logger,
      catalog: async () => null,
      isRevoked: async () => false,
    }),
    staging: async () => ({
      secrets: { current: SECRET },
      logger,
      now: () => NOW,
      stagingSite: async (id: string) => {
        lookups.push(id);
        if (site instanceof Error) throw site;
        return site;
      },
    }),
  };
  const get = (path: string, host = HOST) =>
    serveHost(new Request(`https://${host}${path}`, { headers: { host } }), deps);
  return { get, lookups };
}

const token = (lifetimeDays = 14, linkId = LID) =>
  mintStagingToken(SECRET, {
    linkId,
    expiresAt: new Date(NOW.getTime() + lifetimeDays * 86_400_000 - 3_600_000),
    now: new Date(NOW.getTime() - 3_600_000),
  });
const ok: StagingSite = {
  status: 'ok',
  siteVersionId: V,
  config: gym,
  assets: {},
  publishedAt: NOW,
  sender: 'Pixelstack',
};

describe('staging links', () => {
  it('renders the staging version: banner, noindex, no-store, no-referrer, internal links keep the token', async () => {
    const t = token();
    const res = await setup(ok).get(`/s/${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain(
      `Staging version of ${gym.business.name} for review. This is not the live website.`,
    );
    expect(html).toContain('noindex');
    expect(html).toContain(`href="/s/${t}"`);
    expect(html).not.toContain('<script');
  });

  it('a forged token never reaches the database; junk paths are invalid', async () => {
    const forged = mintStagingToken('x'.repeat(40), {
      linkId: LID,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });
    const s = setup(ok);
    for (const path of [`/s/${forged}`, '/s/', '/s/not-a-token', '/s/v1.abc.def']) {
      const res = await s.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain('This review link is not valid');
    }
    expect(s.lookups).toEqual([]);
  });

  it('revoked, expired and unavailable each have their own page naming the sender', async () => {
    const revoked = await setup({ status: 'revoked', sender: 'Pixelstack' }).get(`/s/${token()}`);
    expect(revoked.status).toBe(410);
    expect(await revoked.text()).toContain('Ask Pixelstack for a new link.');
    const expired = await setup(ok).get(`/s/${token(0.01)}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('This review link has expired');
    const paused = await setup({ status: 'unavailable', sender: 'Pixelstack' }).get(`/s/${token()}`);
    expect(paused.status).toBe(404);
    expect(await paused.text()).toContain('Ask Pixelstack.');
    const unknown = await setup({ status: 'unknown' }).get(`/s/${token()}`);
    expect(unknown.status).toBe(404);
  });

  it('a database failure fails closed (503), never serving a link that may be withdrawn', async () => {
    expect((await setup(new Error('db down')).get(`/s/${token()}`)).status).toBe(503);
  });

  it('staging paths exist only on the preview host', async () => {
    const res = await setup(ok).get(`/s/${token()}`, 'gym.sites.example.test');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('There is no website at this address');
  });
});

describe('live versions (resolve_host live)', () => {
  it('a live host renders its version with the live cache policy; the version is read once', async () => {
    const s = setup(ok, { outcome: 'live', workspaceId: W, projectId: P, siteVersionId: V });
    const first = await s.get('/', 'gym.sites.example.test');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expect(first.headers.get('x-robots-tag')).toBeNull();
    await s.get('/', 'gym.sites.example.test');
    expect(s.lookups).toEqual([V]);
  });

  it('a placeholder host never reads a version', async () => {
    const s = setup(ok, { outcome: 'placeholder', workspaceId: W, projectId: P });
    expect(await (await s.get('/', 'gym.sites.example.test')).text()).toContain('coming soon');
    expect(s.lookups).toEqual([]);
  });
});

describe('versionAssets', () => {
  it('keeps URLs of one https origin only and offers that origin for the CSP', () => {
    const a = versionAssets({
      a1: { 400: 'https://assets.example.test/a1-400.webp', 800: 'https://assets.example.test/a1-800.webp' },
      a2: { 400: 'https://evil.example.test/x.webp' },
      a3: { 400: 'javascript:alert(1)', 800: 'http://assets.example.test/x.webp' },
      'bad id!': { 400: 'https://assets.example.test/z.webp' },
    });
    expect(a.assetOrigin).toBe('https://assets.example.test');
    expect(a.assetUrl!('a1', 800)).toBe('https://assets.example.test/a1-800.webp');
    expect(a.assetUrl!('a2', 400)).toBeNull();
    expect(a.assetUrl!('a3', 400)).toBeNull();
    expect(a.assetUrl!('bad id!', 400)).toBeNull();
    expect(versionAssets(null)).toEqual({});
    expect(versionAssets([1, 2])).toEqual({});
    // Local development storage (S3Mock) is http on localhost.
    expect(versionAssets({ a: { 400: 'http://localhost:59090/assets/a.webp' } }).assetOrigin).toBe(
      'http://localhost:59090',
    );
  });
});

describe('CSP image origin', () => {
  it('allows a plain-http asset origin only on local development responses', async () => {
    const { contentSecurityPolicy } = await import('./site-response');
    const local = contentSecurityPolicy({
      inlineStyles: [],
      assetOrigin: 'http://127.0.0.1:59090',
      secure: false,
    });
    expect(local).toContain("img-src 'self' data: http://127.0.0.1:59090");
    const prod = contentSecurityPolicy({
      inlineStyles: [],
      assetOrigin: 'http://127.0.0.1:59090',
      secure: true,
    });
    expect(prod).toContain("img-src 'self' data:;");
    const evil = contentSecurityPolicy({
      inlineStyles: [],
      assetOrigin: 'http://evil.example',
      secure: false,
    });
    expect(evil).not.toContain('evil');
  });
});
