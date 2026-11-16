/**
 * Client review on a staging link (P3 S8a, FR-PUB-05; plan approved by the Owner 2026-11-16).
 *
 *   GET  /s/<token>/_review            the review panel: approve form, comment form, the link's comments + replies
 *   POST /s/<token>/_review/comment    a client comment, pinned to a page/section of the version the link shows
 *   POST /s/<token>/_review/approve    the client's approval of that version
 *
 * No script anywhere (same CSP stance as every tenant page): plain HTML forms, POST then 303 redirect back to the
 * panel with `?done=<code>` (post/redirect/get). The CSP allows `form-action 'self'` on the panel only.
 *
 * Trust: the link was verified by staging.ts (signature, expiry, app.get_staging_site) before anything here runs,
 * and the database functions check the link again. A POST must come from this origin (Origin, or
 * Sec-Fetch-Site: same-origin when a browser sends no Origin); the page sets no cookie, so there is no session to
 * ride, but a cross-site form must still not be able to approve in a visitor's name. Bodies are capped at 16 KB.
 * Abuse: 30 posts per link per hour and 10 per IP per minute (Upstash; per instance when no store is configured),
 * a honeypot field, and the database cap of 300 comments per version. The visitor's IP is kept only as a keyed
 * hash (HMAC, domain-separated from the link tokens).
 */
import { createHash, createHmac } from 'node:crypto';
import type { PublicDatabase, ReviewThreadEntry, ReviewWriteResult } from '@platform/db/public';
import type { Logger } from '@platform/logger';
import { type SiteConfig, parseSiteConfig } from '@platform/schema';
import { DONE_CODES, type DoneCode, type ReviewLocale, rt } from './review-strings';

export const REVIEW_LIMITS = {
  perLinkPerHour: 30,
  perIpPerMinute: 10,
  bodyBytes: 16_384,
} as const;

export interface RateLimiter {
  /** true while `key` has had at most `limit` hits in the current window of `windowSeconds`. */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface ReviewDeps {
  addComment: PublicDatabase['addReviewComment'];
  approve: PublicDatabase['approveReviewVersion'];
  thread: PublicDatabase['getReviewThread'];
  approval: PublicDatabase['getReviewApproval'];
  limiter: RateLimiter;
  /** Secret for the IP hash (the preview secret; the hash is domain-separated). */
  ipKey: string;
  logger: Logger;
}

/** What staging.ts hands over once the link may show its version. */
export interface ReviewTarget {
  token: string;
  linkId: string;
  siteVersionId: string;
  config: unknown;
  publishedAt: Date;
  sender: string | null;
  /** `https://<preview host>` (http locally). */
  origin: string;
}

interface Common {
  head: boolean;
  correlationId: string | undefined;
}

export const REVIEW_PANEL = '/_review';
const ACTIONS = { '/_review/comment': 'comment', '/_review/approve': 'approve' } as const;
export type ReviewAction = (typeof ACTIONS)[keyof typeof ACTIONS];

export function reviewAction(rest: string): ReviewAction | null {
  return (ACTIONS as Record<string, ReviewAction>)[rest] ?? null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function localeOf(config: unknown): ReviewLocale {
  const language = (config as { business?: { language?: unknown } } | null)?.business?.language;
  return language === 'hi' ? 'hi' : 'en';
}

function siteName(config: unknown): string {
  const name = (config as { business?: { name?: unknown } } | null)?.business?.name;
  return typeof name === 'string' && name.trim() ? name : 'this website';
}

const TYPE_NAMES: Record<string, string> = { 'cta-banner': 'Call-to-action banner' };

/** "Services" or "Services: Our packages" (heading or title of the section, when it has one). */
export function sectionName(section: { type: string; props?: unknown }): string {
  const base = TYPE_NAMES[section.type] ?? `${section.type.charAt(0).toUpperCase()}${section.type.slice(1)}`;
  const props = (section.props ?? {}) as Record<string, unknown>;
  const heading = [props.heading, props.title, props.headline].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  if (!heading) return base;
  const chars = Array.from(heading.trim());
  return `${base}: ${chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : chars.join('')}`;
}

/** The links the staging page shows after each section and in its banner. */
export function reviewLinks(token: string, locale: ReviewLocale) {
  const panel = `/s/${token}${REVIEW_PANEL}`;
  return {
    section: (pageId: string, sectionId: string, type: string) => ({
      href: `${panel}?page=${encodeURIComponent(pageId)}&section=${encodeURIComponent(sectionId)}#comment`,
      label: `${rt(locale, 'pinLink')} (${sectionName({ type })})`,
    }),
    panel: { href: panel, label: rt(locale, 'panelLink') },
  };
}

// ------------------------------------------------------------------------------------------- the panel page
const STYLE =
  'html{color-scheme:light dark}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif;' +
  'background:#f7f7f8;color:#1f2328}main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}' +
  'h1{font-size:1.6rem;margin:.5rem 0}h2{font-size:1.2rem;margin:0 0 .75rem}p{margin:.25rem 0}' +
  'a{color:#0b57d0}.muted{color:#57606a;font-size:.9rem}' +
  '.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}' +
  '.notice{border-radius:10px;padding:.75rem 1rem;margin:1rem 0;background:#dafbe1;color:#0f5323;border:1px solid #4ac26b}' +
  '.notice.err{background:#fff1e5;color:#7a2e0b;border-color:#d1814b}' +
  'label{display:block;font-weight:600;margin:.75rem 0 .25rem}.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}' +
  'input[type=text],input[type=email],select,textarea{box-sizing:border-box;width:100%;font:inherit;padding:.55rem .65rem;' +
  'border:1px solid #8c959f;border-radius:8px;background:#fff;color:inherit}textarea{min-height:7rem;resize:vertical}' +
  'button{margin-top:1rem;font:inherit;font-weight:700;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#1f6feb;color:#fff;cursor:pointer}' +
  '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}' +
  'ol{list-style:none;margin:0;padding:0}li.c{border-top:1px solid #d0d7de;padding:.75rem 0}li.c:first-child{border-top:0}' +
  '.pin{font-size:.85rem;font-weight:600;color:#57606a}.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:.35rem 0}' +
  '.reply{margin:.5rem 0 0 1rem;padding:.5rem .75rem;border-inline-start:3px solid #1f6feb;background:#f6f8fa;border-radius:0 8px 8px 0}' +
  '.badge{display:inline-block;margin-inline-start:.5rem;padding:0 .5rem;border-radius:999px;background:#dafbe1;color:#0f5323;font-size:.8rem}' +
  '@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}a{color:#7cb7ff}.muted,.pin{color:#9da7b3}' +
  '.card{background:#161b22;border-color:#30363d}input[type=text],input[type=email],select,textarea{background:#0d1117;border-color:#6e7681}' +
  '.reply{background:#161b22}li.c{border-color:#30363d}.notice{background:#033a16;color:#aff5b4}.notice.err{background:#3d1d00;color:#ffd8b5}' +
  '.badge{background:#033a16;color:#aff5b4}}';

const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export const REVIEW_CSP = [
  "default-src 'none'",
  `style-src '${STYLE_HASH}'`,
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function headers(common: Common, secure: boolean): Headers {
  const h = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': secure ? `${REVIEW_CSP}; upgrade-insecure-requests` : REVIEW_CSP,
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
  });
  if (common.correlationId) h.set('x-correlation-id', common.correlationId);
  return h;
}

interface Pin {
  value: string;
  label: string;
}

/** The places a comment can be pinned to: the whole site, each page, each shown section. */
export function pinOptions(config: SiteConfig, locale: ReviewLocale): Pin[] {
  const out: Pin[] = [{ value: '', label: rt(locale, 'wholeSite') }];
  for (const page of config.pages) {
    out.push({ value: `p:${page.id}`, label: rt(locale, 'wholePage', { page: page.title }) });
    for (const section of page.sections) {
      if (!section.visible) continue;
      out.push({ value: `s:${page.id}:${section.id}`, label: `${page.title} › ${sectionName(section)}` });
    }
  }
  return out;
}

function pinLabel(
  config: SiteConfig,
  entry: { pageId: string | null; sectionId: string | null },
  locale: ReviewLocale,
) {
  if (!entry.pageId) return rt(locale, 'wholeSite');
  const page = config.pages.find((p) => p.id === entry.pageId);
  if (!page) return entry.pageId;
  if (!entry.sectionId) return rt(locale, 'wholePage', { page: page.title });
  const section = page.sections.find((s) => s.id === entry.sectionId);
  return `${page.title} › ${section ? sectionName(section) : entry.sectionId}`;
}

function formatDate(date: Date, locale: ReviewLocale): string {
  return new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function renderPanel(input: {
  target: ReviewTarget;
  config: SiteConfig;
  thread: ReviewThreadEntry[];
  approval: { name: string; approvedAt: Date } | null;
  done: DoneCode | null;
  selected: string;
}): string {
  const { target, config, thread, approval, done } = input;
  const locale = localeOf(config);
  const e = escapeHtml;
  const name = siteName(config);
  const sender = target.sender ?? (locale === 'hi' ? 'आपके वेब डिज़ाइनर' : 'your web designer');
  const base = `/s/${target.token}`;
  const action = (a: ReviewAction) => `${base}/_review/${a}`;
  const okDone = done === 'comment' || done === 'approve';

  const notice = done
    ? `<p class="notice${okDone ? '' : ' err'}" role="${okDone ? 'status' : 'alert'}">${e(
        rt(locale, `done_${done}`),
      )}</p>`
    : '';

  const approveBox = approval
    ? `<p><strong>${e(rt(locale, 'approvedBy', { who: approval.name, date: formatDate(approval.approvedAt, locale) }))}</strong></p>`
    : `<p class="muted">${e(rt(locale, 'approveText', { sender }))}</p>
<form method="post" action="${e(action('approve'))}">
<input type="hidden" name="v" value="${e(target.siteVersionId)}">
<label for="a-name">${e(rt(locale, 'name'))}</label>
<input type="text" id="a-name" name="name" required maxlength="80" autocomplete="name">
<label for="a-email">${e(rt(locale, 'email'))}</label>
<input type="email" id="a-email" name="email" maxlength="254" autocomplete="email" aria-describedby="a-email-hint">
<p class="muted" id="a-email-hint">${e(rt(locale, 'emailHint', { sender }))}</p>
<div class="hp" aria-hidden="true"><label for="a-website">${e(rt(locale, 'honeypot'))}</label><input type="text" id="a-website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> ${e(rt(locale, 'approveCheck'))}</label>
<button type="submit">${e(rt(locale, 'approveButton'))}</button>
</form>`;

  const options = pinOptions(config, locale)
    .map(
      (p) =>
        `<option value="${e(p.value)}"${p.value === input.selected ? ' selected' : ''}>${e(p.label)}</option>`,
    )
    .join('');

  const tops = thread.filter((t) => t.parentId === null);
  const items = tops
    .map((c) => {
      const replies = thread
        .filter((r) => r.parentId === c.id)
        .map(
          (r) =>
            `<div class="reply"><p class="pin">${e(rt(locale, 'reply', { sender }))} · <time>${e(
              formatDate(r.createdAt, locale),
            )}</time></p><p class="body">${e(r.body)}</p></div>`,
        )
        .join('');
      return `<li class="c"><p class="pin">${e(pinLabel(config, c, locale))}${
        c.resolved ? `<span class="badge">${e(rt(locale, 'resolved'))}</span>` : ''
      }</p><p><strong>${e(c.authorName ?? '')}</strong> · <time class="muted">${e(
        formatDate(c.createdAt, locale),
      )}</time></p><p class="body">${e(c.body)}</p>${replies}</li>`;
    })
    .join('');

  const title = rt(locale, 'title', { name });
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${e(
    title,
  )}</title><style>${STYLE}</style></head><body><main>
<p><a href="${e(`${base}/`)}">← ${e(rt(locale, 'backToSite'))}</a></p>
<h1>${e(title)}</h1>
<p>${e(rt(locale, 'intro', { sender, name }))}</p>
<p class="muted">${e(rt(locale, 'publishedAt', { date: formatDate(target.publishedAt, locale) }))}</p>
${notice}
<section class="card" id="approve" aria-labelledby="h-approve"><h2 id="h-approve">${e(rt(locale, 'approveHeading'))}</h2>
${approveBox}
</section>
<section class="card" id="comment" aria-labelledby="h-comment"><h2 id="h-comment">${e(rt(locale, 'commentHeading'))}</h2>
<form method="post" action="${e(action('comment'))}">
<input type="hidden" name="v" value="${e(target.siteVersionId)}">
<label for="c-where">${e(rt(locale, 'where'))}</label>
<select id="c-where" name="where">${options}</select>
<label for="c-body">${e(rt(locale, 'comment'))}</label>
<textarea id="c-body" name="body" required maxlength="2000"></textarea>
<label for="c-name">${e(rt(locale, 'name'))}</label>
<input type="text" id="c-name" name="name" required maxlength="80" autocomplete="name">
<label for="c-email">${e(rt(locale, 'email'))}</label>
<input type="email" id="c-email" name="email" maxlength="254" autocomplete="email" aria-describedby="c-email-hint">
<p class="muted" id="c-email-hint">${e(rt(locale, 'emailHint', { sender }))}</p>
<div class="hp" aria-hidden="true"><label for="c-website">${e(rt(locale, 'honeypot'))}</label><input type="text" id="c-website" name="website" tabindex="-1" autocomplete="off"></div>
<button type="submit">${e(rt(locale, 'send'))}</button>
</form>
</section>
<section class="card" id="comments" aria-labelledby="h-comments"><h2 id="h-comments">${e(
    rt(locale, 'commentsHeading'),
  )} (${tops.length})</h2>
${tops.length ? `<ol>${items}</ol>` : `<p class="muted">${e(rt(locale, 'noComments'))}</p>`}
</section>
</main></body></html>`;
}

/** GET /s/<token>/_review */
export async function servePanel(
  request: Request,
  target: ReviewTarget,
  deps: ReviewDeps,
  common: Common & { secure: boolean },
): Promise<Response | null> {
  const parsed = parseSiteConfig(target.config);
  if (!parsed.ok) return null;
  const url = new URL(request.url);
  const doneParam = url.searchParams.get('done');
  const done = (DONE_CODES as readonly string[]).includes(doneParam ?? '') ? (doneParam as DoneCode) : null;
  const page = url.searchParams.get('page');
  const section = url.searchParams.get('section');
  const wanted = page ? (section ? `s:${page}:${section}` : `p:${page}`) : '';
  const options = pinOptions(parsed.config, localeOf(parsed.config));
  const selected = options.some((o) => o.value === wanted) ? wanted : '';
  const [thread, approval] = await Promise.all([
    deps.thread(target.linkId, target.siteVersionId),
    deps.approval(target.linkId, target.siteVersionId),
  ]);
  const html = renderPanel({ target, config: parsed.config, thread, approval, done, selected });
  return new Response(common.head ? null : html, { status: 200, headers: headers(common, common.secure) });
}

// ------------------------------------------------------------------------------------------- POST
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_VALUE = /^(?:p:([a-z0-9][a-z0-9-]{0,39})|s:([a-z0-9][a-z0-9-]{0,39}):([a-z0-9][a-z0-9-]{0,39}))$/;

/** The request comes from the review page itself (not a cross-site form). */
export function sameOrigin(request: Request, origin: string): boolean {
  const sent = request.headers.get('origin');
  if (sent !== null) return sent === origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip')?.trim() || '';
  return ip && ip.length <= 64 ? ip : null;
}

export function ipHash(key: string, ip: string | null): string | null {
  return ip ? createHmac('sha256', key).update(`review-ip:v1:${ip}`).digest('hex').slice(0, 32) : null;
}

function redirect(target: ReviewTarget, done: DoneCode, anchor: string, common: Common): Response {
  const h = new Headers({
    location: `/s/${target.token}${REVIEW_PANEL}?done=${done}#${anchor}`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (common.correlationId) h.set('x-correlation-id', common.correlationId);
  return new Response(null, { status: 303, headers: h });
}

const RESULT_TO_DONE: Record<ReviewWriteResult, DoneCode | 'link'> = {
  ok: 'comment',
  already: 'already',
  stale: 'stale',
  no_section: 'no_section',
  invalid: 'invalid',
  limit: 'limit',
  revoked: 'link',
  expired: 'link',
  unavailable: 'link',
  unknown: 'link',
};

export type PostOutcome =
  | { kind: 'response'; response: Response }
  /** The link stopped being valid between the check and the write: show its page again. */
  | { kind: 'link_changed' };

/** POST /s/<token>/_review/comment and /_review/approve. */
export async function handlePost(
  request: Request,
  action: ReviewAction,
  target: ReviewTarget,
  deps: ReviewDeps,
  common: Common,
): Promise<PostOutcome> {
  const respond = (done: DoneCode, anchor = action === 'approve' ? 'approve' : 'comment'): PostOutcome => ({
    kind: 'response',
    response: redirect(target, done, anchor, common),
  });
  if (!sameOrigin(request, target.origin)) {
    deps.logger.warn('sites.review.cross_origin', { action });
    return {
      kind: 'response',
      response: new Response('Forbidden', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      }),
    };
  }
  const type = request.headers.get('content-type') ?? '';
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!type.startsWith('application/x-www-form-urlencoded') || declared > REVIEW_LIMITS.bodyBytes) {
    return respond('invalid');
  }
  const raw = await request.text();
  if (raw.length > REVIEW_LIMITS.bodyBytes) return respond('invalid');
  const form = new URLSearchParams(raw);
  const field = (k: string) => form.get(k) ?? '';

  // A bot filled the field people never see: answer as if it worked and keep nothing.
  if (field('website').trim() !== '') {
    deps.logger.info('sites.review.honeypot', { action });
    return respond(action === 'approve' ? 'approve' : 'comment');
  }
  const versionId = field('v');
  if (!UUID.test(versionId)) return respond('invalid');

  const ip = clientIp(request);
  const hashed = ipHash(deps.ipKey, ip);
  const allowed =
    (await deps.limiter.allow(`link:${target.linkId}`, REVIEW_LIMITS.perLinkPerHour, 3600)) &&
    (await deps.limiter.allow(`ip:${hashed ?? 'unknown'}`, REVIEW_LIMITS.perIpPerMinute, 60));
  if (!allowed) {
    deps.logger.info('sites.review.rate_limited', { action });
    return respond('slow');
  }

  const email = field('email').trim() || null;
  let result: ReviewWriteResult;
  if (action === 'approve') {
    if (field('confirm') !== 'yes') return respond('invalid');
    result = await deps.approve({
      linkId: target.linkId,
      versionId,
      name: field('name'),
      email,
      ipHash: hashed,
    });
  } else {
    const where = field('where');
    const m = where === '' ? null : PIN_VALUE.exec(where);
    if (where !== '' && !m) return respond('invalid');
    const pageId = m ? (m[1] ?? m[2] ?? null) : null;
    const sectionId = m ? (m[3] ?? null) : null;
    result = await deps.addComment({
      linkId: target.linkId,
      versionId,
      pageId,
      sectionId,
      name: field('name'),
      email,
      body: field('body'),
      ipHash: hashed,
    });
  }
  const done = RESULT_TO_DONE[result];
  if (done === 'link') return { kind: 'link_changed' };
  deps.logger.info('sites.review.recorded', { action, result });
  if (result === 'ok')
    return respond(
      action === 'approve' ? 'approve' : 'comment',
      action === 'approve' ? 'approve' : 'comments',
    );
  return respond(done);
}
