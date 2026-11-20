/**
 * P3 S8a: client review on a staging link. Real token verification and renderer; the app_public functions are
 * stubs that record what they were asked. Covers the per-section links on the site, the review panel (pins,
 * thread, approval, results, CSP), and the POST path: same-origin rule, body limits, honeypot, rate limits,
 * pin parsing, result mapping, and a link that stops being valid between the check and the write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ReviewCommentInput,
  ReviewThreadEntry,
  ReviewWriteResult,
  StagingSite,
} from '@platform/db/public';
import { createHostResolver, mintStagingToken } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import { createRateLimiter } from './rate-limit';
import { REVIEW_CSP, clientIp, ipHash, pinOptions, sameOrigin, sectionName } from './review';
import { serveHost, servePost } from './serve';
import { parseSiteConfig, type SiteConfig } from '@platform/schema';
import { followLink } from './link-session.testing';

const SECRET = 's'.repeat(40);
const HOST = 'preview.sites.example.test';
const ORIGIN = `https://${HOST}`;
const LID = '01920000-0000-7000-8000-0000000000c1';
const V = '01920000-0000-7000-8000-000000000003';
const NOW = new Date('2026-11-16T12:00:00Z');

const seed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../packages/templates/seed/builtin-templates.json', import.meta.url)),
    'utf8',
  ),
) as { templates: { slug: string; config: SiteConfig }[] };
const gym = seed.templates.find((t) => t.slug === 'gym-bold')!.config;
const parsed = parseSiteConfig(gym);
if (!parsed.ok) throw new Error('seed config invalid');
const config = parsed.config;
const home = config.pages.find((p) => p.path === '/')!;
const firstSection = home.sections.find((s) => s.visible)!;

const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never;

const ok: StagingSite = {
  status: 'ok',
  siteVersionId: V,
  config: gym,
  assets: {},
  publishedAt: NOW,
  sender: 'Pixelstack',
};

interface Options {
  site?: StagingSite;
  /** What the second lookup (after a write) answers. */
  siteAfter?: StagingSite;
  result?: ReviewWriteResult;
  thread?: ReviewThreadEntry[];
  approval?: { name: string; approvedAt: Date } | null;
  limit?: boolean;
  review?: boolean;
}

function setup(o: Options = {}) {
  const comments: ReviewCommentInput[] = [];
  const approvals: unknown[] = [];
  let lookups = 0;
  const resolver = createHostResolver({
    cache: createMemoryStore(),
    lookup: async () => ({ outcome: 'unknown' }),
  });
  const limiter = o.limit ? { allow: async () => false } : createRateLimiter(createMemoryStore(), logger);
  const deps = {
    resolver: async () => resolver,
    logger,
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
      stagingSite: async () => {
        lookups++;
        return lookups > 1 && o.siteAfter ? o.siteAfter : (o.site ?? ok);
      },
      ...(o.review === false
        ? {}
        : {
            review: {
              addComment: async (input: ReviewCommentInput) => {
                comments.push(input);
                return o.result ?? 'ok';
              },
              approve: async (input: unknown) => {
                approvals.push(input);
                return o.result ?? 'ok';
              },
              thread: async () => o.thread ?? [],
              approval: async () => o.approval ?? null,
              limiter,
              ipKey: SECRET,
              logger,
            },
          }),
    }),
  };
  // P3 S9b: a browser follows the token exchange (303 + link cookie) to the clean path.
  const get = (path: string) =>
    followLink((request) => serveHost(request, deps), `${ORIGIN}${path}`, { headers: { host: HOST } });
  const post = (path: string, body: Record<string, string> | string, headers: Record<string, string> = {}) =>
    servePost(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          host: HOST,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '203.0.113.7, 10.0.0.1',
          ...headers,
        },
        body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
      }),
      deps,
    );
  return { get, post, comments, approvals };
}

const token = () =>
  mintStagingToken(SECRET, {
    linkId: LID,
    expiresAt: new Date(NOW.getTime() + 13 * 86_400_000),
    now: new Date(NOW.getTime() - 3_600_000),
  });

describe('review links on the staging site', () => {
  it('every shown section ends with a comment link to the panel, and the banner links the panel', async () => {
    const t = token();
    const res = await setup().get(`/s/${t}`);
    const html = await res.text();
    const shown = home.sections.filter((s) => s.visible);
    expect(html.match(/class="pb-review-pin"/g)).toHaveLength(shown.length);
    expect(html).toContain(
      `href="/review/${LID}/_review?page=${home.id}&amp;section=${firstSection.id}#comment"`,
    );
    expect(html).toContain(`<a href="/review/${LID}/_review">Comments and approval</a>`);
    expect(html).not.toContain(t);
    // The CSP still has no script source and allows no form on the site itself.
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("form-action 'none'");
  });

  it('without review configured, the staging site has no review links', async () => {
    const html = await (await setup({ review: false }).get(`/s/${token()}`)).text();
    expect(html).not.toContain('pb-review-pin');
    expect(html).not.toContain('/_review');
  });
});

describe('review panel', () => {
  it('shows the forms, the pin choices, the thread with replies, and its own strict CSP', async () => {
    const t = token();
    const thread: ReviewThreadEntry[] = [
      {
        id: 'c1',
        parentId: null,
        pageId: home.id,
        sectionId: firstSection.id,
        authorKind: 'client',
        authorName: 'Ramesh <b>',
        body: 'Bigger <script>alert(1)</script> phone',
        createdAt: NOW,
        resolved: true,
      },
      {
        id: 'r1',
        parentId: 'c1',
        pageId: home.id,
        sectionId: firstSection.id,
        authorKind: 'member',
        authorName: null,
        body: 'Done.',
        createdAt: NOW,
        resolved: false,
      },
    ];
    const res = await setup({ thread }).get(`/s/${t}/_review?page=${home.id}&section=${firstSection.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(`${REVIEW_CSP}; upgrade-insecure-requests`);
    expect(REVIEW_CSP).toContain("form-action 'self'");
    expect(REVIEW_CSP).not.toContain('script-src');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).toContain('Bigger &lt;script&gt;alert(1)&lt;/script&gt; phone');
    expect(html).toContain('Ramesh &lt;b&gt;');
    expect(html).toContain('Reply from Pixelstack');
    expect(html).toContain('<span class="badge">Done</span>');
    expect(html).toContain(`action="/review/${LID}/_review/comment"`);
    expect(html).toContain(`action="/review/${LID}/_review/approve"`);
    expect(html).not.toContain(t);
    expect(html).toContain(`<input type="hidden" name="v" value="${V}">`);
    // The section the client came from is preselected.
    expect(html).toContain(`<option value="s:${home.id}:${firstSection.id}" selected>`);
    expect(html).toContain('Comments (1)');
  });

  it('shows the approval instead of the form once given, and a result message from ?done', async () => {
    const t = token();
    const html = await (
      await setup({ approval: { name: 'Ramesh', approvedAt: NOW } }).get(`/s/${t}/_review?done=approve`)
    ).text();
    expect(html).toMatch(/Approved by Ramesh on /);
    expect(html).not.toContain('/_review/approve"');
    expect(html).toContain('role="status"');
    expect(html).toContain('your approval was recorded');
    const unknown = await (await setup().get(`/s/${t}/_review?done=<x>`)).text();
    expect(unknown).not.toContain('class="notice');
  });

  it('a revoked link shows the revoked page, not the panel', async () => {
    const res = await setup({ site: { status: 'revoked', sender: 'Pixelstack' } }).get(
      `/s/${token()}/_review`,
    );
    expect(res.status).toBe(410);
  });

  it('uses Hindi copy for a Hindi site', async () => {
    const hindi = { ...gym, business: { ...gym.business, language: 'hi' as const } };
    const html = await (await setup({ site: { ...ok, config: hindi } }).get(`/s/${token()}/_review`)).text();
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain('इस वर्ज़न को मंज़ूरी दें');
  });
});

describe('review POST', () => {
  const form = (over: Record<string, string> = {}) => ({
    v: V,
    where: `s:${home.id}:${firstSection.id}`,
    name: 'Ramesh',
    email: 'r@example.test',
    body: 'Please change the photo.',
    ...over,
  });

  it("accepts Chrome's own form POST from the panel, which carries Origin: null under no-referrer", async () => {
    const t = token();
    const s = setup();
    const res = await s.post(`/s/${t}/_review/comment`, form(), {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(303);
    expect(s.comments).toHaveLength(1);
  });

  it('records a pinned comment with a hashed IP and redirects back to the panel (303)', async () => {
    const t = token();
    const s = setup();
    const res = await s.post(`/s/${t}/_review/comment`, form());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/s/${t}/_review?done=comment#comments`);
    expect(s.comments).toEqual([
      {
        linkId: LID,
        versionId: V,
        pageId: home.id,
        sectionId: firstSection.id,
        name: 'Ramesh',
        email: 'r@example.test',
        body: 'Please change the photo.',
        ipHash: ipHash(SECRET, '203.0.113.7'),
      },
    ]);
    expect(s.comments[0]?.ipHash).toMatch(/^[0-9a-f]{32}$/);
  });

  // P3 S9b (DG-37 (h)): the panel posts to the clean path; the token comes from the link cookie.
  it('S9b: a post to the clean path with the link cookie is recorded and redirects back to the clean panel', async () => {
    const t = token();
    const s = setup();
    const res = await s.post(`/review/${LID}/_review/comment`, form(), { cookie: `__Secure-link=${t}` });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/review/${LID}/_review?done=comment#comments`);
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]?.linkId).toBe(LID);
    const approved = await s.post(
      `/review/${LID}/_review/approve`,
      { v: V, name: 'Ramesh', confirm: 'yes' },
      { cookie: `__Secure-link=${t}` },
    );
    expect(approved.status).toBe(303);
    expect(s.approvals).toHaveLength(1);
  });

  it('S9b: without the cookie, or with the cookie of another link, a clean-path post writes nothing', async () => {
    const s = setup();
    const bare = await s.post(`/review/${LID}/_review/comment`, form());
    expect(bare.status).toBe(401);
    expect(await bare.text()).toContain('Open the review link you were sent');
    const other = mintStagingToken(SECRET, {
      linkId: '01920000-0000-7000-8000-0000000000c2',
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });
    const wrong = await s.post(
      `/review/${LID}/_review/approve`,
      { v: V, name: 'x', confirm: 'yes' },
      {
        cookie: `__Secure-link=${other}`,
      },
    );
    expect(wrong.status).toBe(401);
    expect(s.comments).toEqual([]);
    expect(s.approvals).toEqual([]);
  });

  it('S9b: a cross-site post is still refused even if the browser were to send the cookie', async () => {
    const s = setup();
    const evil = await s.post(
      `/review/${LID}/_review/approve`,
      { v: V, name: 'x', confirm: 'yes' },
      {
        origin: 'https://evil.example',
        cookie: `__Secure-link=${token()}`,
      },
    );
    expect(evil.status).toBe(403);
    expect(s.approvals).toEqual([]);
  });

  it('parses whole-site and whole-page pins, and refuses a malformed one without a write', async () => {
    const t = token();
    const s = setup();
    await s.post(`/s/${t}/_review/comment`, form({ where: '' }));
    await s.post(`/s/${t}/_review/comment`, form({ where: `p:${home.id}` }));
    expect(s.comments.map((c) => [c.pageId, c.sectionId])).toEqual([
      [null, null],
      [home.id, null],
    ]);
    const bad = await s.post(`/s/${t}/_review/comment`, form({ where: 's:Bad Id' }));
    expect(bad.headers.get('location')).toContain('done=invalid');
    expect(s.comments).toHaveLength(2);
  });

  it('approves only with the confirmation box ticked', async () => {
    const t = token();
    const s = setup();
    const missing = await s.post(`/s/${t}/_review/approve`, { v: V, name: 'Ramesh' });
    expect(missing.headers.get('location')).toBe(`/s/${t}/_review?done=invalid#approve`);
    const res = await s.post(`/s/${t}/_review/approve`, { v: V, name: 'Ramesh', confirm: 'yes' });
    expect(res.headers.get('location')).toBe(`/s/${t}/_review?done=approve#approve`);
    expect(s.approvals).toHaveLength(1);
  });

  it('maps database answers to messages', async () => {
    const t = token();
    for (const [result, done] of [
      ['already', 'already'],
      ['stale', 'stale'],
      ['no_section', 'no_section'],
      ['invalid', 'invalid'],
      ['limit', 'limit'],
    ] as const) {
      const res = await setup({ result }).post(`/s/${t}/_review/comment`, form());
      expect(res.headers.get('location'), result).toContain(`done=${done}`);
    }
  });

  it('a link turned off between the check and the write shows the revoked page', async () => {
    const res = await setup({
      result: 'revoked',
      siteAfter: { status: 'revoked', sender: 'Pixelstack' },
    }).post(`/s/${token()}/_review/comment`, form());
    expect(res.status).toBe(410);
  });

  it('refuses a cross-site form (403) and accepts a same-origin one without an Origin header', async () => {
    const t = token();
    const s = setup();
    const evil = await s.post(
      `/s/${t}/_review/approve`,
      { v: V, name: 'x', confirm: 'yes' },
      {
        origin: 'https://evil.example',
      },
    );
    expect(evil.status).toBe(403);
    // P3 S8b (DG-37 g): a styled page with the way back instead of a bare "Forbidden"; still nothing stored.
    expect(evil.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(evil.headers.get('content-security-policy')).toContain(REVIEW_CSP);
    expect(evil.headers.get('cache-control')).toBe('no-store');
    const refused = await evil.text();
    expect(refused).toContain('This could not be sent');
    expect(refused).toContain(`href="/s/${t}/_review"`);
    expect(refused).not.toContain('<script');
    expect(s.approvals).toHaveLength(0);
    const noOrigin = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(sameOrigin(noOrigin, ORIGIN)).toBe(false);
    const sameSite = new Request(`${ORIGIN}/x`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(sameOrigin(sameSite, ORIGIN)).toBe(true);
    // Chrome under the panel's `no-referrer` sends `Origin: null` with its own form POST (production, 2026-11-18).
    const nullSame = (site: string) =>
      new Request(`${ORIGIN}/x`, { method: 'POST', headers: { origin: 'null', 'sec-fetch-site': site } });
    expect(sameOrigin(nullSame('same-origin'), ORIGIN)).toBe(true);
    expect(sameOrigin(nullSame('cross-site'), ORIGIN)).toBe(false);
    expect(sameOrigin(nullSame('same-site'), ORIGIN)).toBe(false);
    expect(
      sameOrigin(new Request(`${ORIGIN}/x`, { method: 'POST', headers: { origin: 'null' } }), ORIGIN),
    ).toBe(false);
    const nullEvil = await s.post(
      `/s/${t}/_review/approve`,
      { v: V, name: 'x', confirm: 'yes' },
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
    );
    expect(nullEvil.status).toBe(403);
    expect(s.approvals).toHaveLength(0);
  });

  it('refuses a body that is not a form or is too large, and keeps nothing from a bot (honeypot)', async () => {
    const t = token();
    const s = setup();
    const json = await s.post(`/s/${t}/_review/comment`, '{}', { 'content-type': 'application/json' });
    expect(json.headers.get('location')).toContain('done=invalid');
    const big = await s.post(`/s/${t}/_review/comment`, form({ body: 'x'.repeat(17_000) }));
    expect(big.headers.get('location')).toContain('done=invalid');
    const bot = await s.post(`/s/${t}/_review/comment`, form({ website: 'http://spam.example' }));
    expect(bot.headers.get('location')).toContain('done=comment');
    expect(s.comments).toHaveLength(0);
  });

  it('rate limits: 10 posts per IP per minute, then "slow" without a write', async () => {
    const t = token();
    const s = setup();
    for (let i = 0; i < 10; i++) {
      expect((await s.post(`/s/${t}/_review/comment`, form())).headers.get('location')).toContain(
        'done=comment',
      );
    }
    expect((await s.post(`/s/${t}/_review/comment`, form())).headers.get('location')).toContain('done=slow');
    expect(s.comments).toHaveLength(10);
    // Another IP still has its own budget (the link allows 30 an hour).
    const other = await s.post(`/s/${t}/_review/comment`, form(), { 'x-forwarded-for': '198.51.100.1' });
    expect(other.headers.get('location')).toContain('done=comment');
  });

  it('a limiter that refuses stops the write', async () => {
    const s = setup({ limit: true });
    const res = await s.post(`/s/${token()}/_review/comment`, form());
    expect(res.headers.get('location')).toContain('done=slow');
    expect(s.comments).toHaveLength(0);
  });

  it('POST anywhere else is 405: other paths, other hosts, and a site without review', async () => {
    const t = token();
    const s = setup();
    expect((await s.post(`/s/${t}`, form())).status).toBe(405);
    expect((await s.post(`/s/${t}/_review`, form())).status).toBe(405);
    expect((await s.post('/', form())).status).toBe(405);
    const otherHost = await servePost(
      new Request('https://shop.sites.example.test/s/x/_review/comment', {
        method: 'POST',
        headers: { host: 'shop.sites.example.test' },
      }),
      { logger },
    );
    expect(otherHost.status).toBe(405);
    expect((await setup({ review: false }).post(`/s/${t}/_review/comment`, form())).status).toBe(405);
  });

  it('a forged token is the invalid-link page, before any write', async () => {
    const s = setup();
    const res = await s.post('/s/not-a-token/_review/comment', form());
    expect(res.status).toBe(404);
    expect(s.comments).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('names sections by type and heading, and lists only shown sections as pins', () => {
    expect(sectionName({ type: 'cta-banner' })).toBe('Call-to-action banner');
    expect(sectionName({ type: 'services', props: { heading: 'Our packages' } })).toBe(
      'Services: Our packages',
    );
    expect(sectionName({ type: 'faq', props: { heading: 'x'.repeat(60) } })).toBe(`Faq: ${'x'.repeat(39)}…`);
    const pins = pinOptions(config, 'en');
    expect(pins[0]).toEqual({ value: '', label: 'The whole website' });
    const hidden = config.pages.flatMap((p) =>
      p.sections.filter((s) => !s.visible).map((s) => `s:${p.id}:${s.id}`),
    );
    for (const h of hidden) expect(pins.map((p) => p.value)).not.toContain(h);
  });

  it('takes the first forwarded IP, and hashes it with the key (never the raw address)', () => {
    const r = (h: Record<string, string>) => new Request('https://x.test/', { headers: h });
    expect(clientIp(r({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(r({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(r({}))).toBeNull();
    expect(ipHash('k', null)).toBeNull();
    expect(ipHash('k', '1.2.3.4')).not.toBe(ipHash('other', '1.2.3.4'));
    expect(ipHash('k', '1.2.3.4')).not.toContain('1.2.3.4');
  });

  it('the rate limiter fails open when its store is down', async () => {
    const broken = {
      name: 'broken',
      get: async () => null,
      set: async () => undefined,
      del: async () => 0,
      incr: async () => {
        throw new Error('down');
      },
    };
    expect(await createRateLimiter(broken, logger).allow('k', 1, 60)).toBe(true);
  });
});
