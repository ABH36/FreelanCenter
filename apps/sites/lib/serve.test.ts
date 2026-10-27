/**
 * P1 S7 header and response tests (SEC-03; FR-DOM-07; FR-WS-04 sites part). The handler runs with the real
 * resolver and an in-memory cache; only the database lookup is a stub. The database side of the lookup is
 * covered by @platform/db (resolve_host) and the end-to-end invalidation by @platform/workspaces (host-routing).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type HostResolution, createHostResolver } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import config from '../next.config';
import { PAGE_CSP, pageResponse } from './pages';
import { SECURITY_HEADERS } from './security-headers';
import { serveHost } from './serve';

const W = '01920000-0000-7000-8000-000000000001';
const P = '01920000-0000-7000-8000-000000000002';
const silent = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never;

function setup(answers: Record<string, HostResolution | Error>) {
  const cache = createMemoryStore();
  const lookups: string[] = [];
  const resolver = createHostResolver({
    cache,
    lookup: async (host) => {
      lookups.push(host);
      const answer = answers[host] ?? { outcome: 'unknown' };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const serve = (host: string | null, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (host !== null) headers.set('host', host);
    return serveHost(new Request('http://internal/any/path?q=1', { ...init, headers }), {
      resolver: async () => resolver,
      logger: silent,
    });
  };
  return { serve, cache, lookups };
}

describe('serveHost', () => {
  it('placeholder: 200, generic text without tenant data, strict CSP, noindex, no-store', async () => {
    const { serve } = setup({
      'sharma-taxi.sites.localhost': { outcome: 'placeholder', workspaceId: W, projectId: P },
    });
    const res = await serve('Sharma-Taxi.sites.localhost:3001');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const html = await res.text();
    expect(html).toContain('coming soon');
    expect(html).not.toMatch(/sharma|<script|01920000/i);
  });

  it('maintenance (suspended workspace or paused project): 503 with Retry-After', async () => {
    const { serve } = setup({
      'down.sites.localhost': { outcome: 'maintenance', workspaceId: W, projectId: P },
    });
    const res = await serve('down.sites.localhost');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(await res.text()).toContain('temporarily unavailable');
  });

  it('unknown and invalid hosts: 404 not found; an invalid Host header is never looked up', async () => {
    const { serve, lookups } = setup({});
    expect((await serve('nobody.sites.localhost')).status).toBe(404);
    for (const bad of [null, '', '[::1]:3001', 'a..b', 'evil.com/x']) {
      const res = await serve(bad);
      expect([bad, res.status]).toEqual([bad, 404]);
      expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
    }
    expect(lookups).toEqual(['nobody.sites.localhost']);
  });

  it('cache: miss then hit for a site; the negative answer is cached too', async () => {
    const { serve, cache, lookups } = setup({
      'a.sites.localhost': { outcome: 'placeholder', workspaceId: W, projectId: P },
    });
    for (let i = 0; i < 3; i++) expect((await serve('a.sites.localhost')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await serve('gone.sites.localhost')).status).toBe(404);
    expect(lookups).toEqual(['a.sites.localhost', 'gone.sites.localhost']);
    expect(cache.calls.set).toBe(2);
  });

  it('a database failure is a 503 that is not cached; the next request looks up again', async () => {
    const answers: Record<string, HostResolution | Error> = { 'a.sites.localhost': new Error('db down') };
    const { serve, lookups } = setup(answers);
    const res = await serve('a.sites.localhost');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).not.toContain('db down');
    answers['a.sites.localhost'] = { outcome: 'placeholder', workspaceId: W, projectId: P };
    expect((await serve('a.sites.localhost')).status).toBe(200);
    expect(lookups).toHaveLength(2);
  });

  it('a runtime that cannot start (missing configuration, role check failed) is a 503', async () => {
    const res = await serveHost(new Request('http://internal/', { headers: { host: 'a.sites.localhost' } }), {
      resolver: async () => {
        throw new Error('DATABASE_URL_PUBLIC is not set');
      },
      logger: silent,
    });
    expect(res.status).toBe(503);
  });

  it('HEAD gets the same status and headers without a body; a client correlation id is kept', async () => {
    const { serve } = setup({});
    const res = await serve('nobody.sites.localhost', {
      method: 'HEAD',
      headers: { 'x-correlation-id': 'corr-abc-123' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc-123');
    expect(await res.text()).toBe('');
  });
});

describe('Content-Security-Policy of the host pages (SEC-03)', () => {
  it('allows no script, no connection, no framing and exactly the inline stylesheet by hash', async () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(PAGE_CSP).toContain("base-uri 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_CSP).not.toMatch(/script-src|unsafe-inline|unsafe-eval|\*/);
    for (const kind of ['placeholder', 'maintenance', 'not_found', 'unavailable'] as const) {
      const html = await pageResponse(kind).text();
      const style = /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? '';
      const hash = createHash('sha256').update(style).digest('base64');
      expect(PAGE_CSP).toContain(`'sha256-${hash}'`);
      expect(html).not.toContain('<script');
      expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    }
  });
});

describe('next.config security headers (SEC-03)', () => {
  it('applies the baseline to every path and hides the framework banner', async () => {
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    expect(rules).toEqual([{ source: '/:path*', headers: [...SECURITY_HEADERS] }]);
    const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    expect(byKey['Permissions-Policy']).toContain('camera=()');
  });
});
