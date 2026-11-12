/**
 * Preview and pitch links (FR-TPL-09, P2 S6): `https://<preview host>/p/<token>[/<page>]`. Public, login-free,
 * shareable, expiring, `noindex`, with demo data (optionally the prospect's business name). It is served only on the
 * dedicated preview host (`PREVIEW_HOST`, a reserved label that no tenant can own), never on a tenant host, so no
 * tenant page path can ever collide with it.
 *
 * Trust: the token is verified (constant-time HMAC, expiry, closed claims) before anything else happens; a bad or
 * expired token never reaches the database. The template content comes from the read-only catalogue function and is
 * re-validated by the renderer on every request like any stored config. No tenant secret is embedded: the content is
 * platform demo data.
 */
import { renderDocument, t } from '@platform/blocks';
import type { CatalogTemplate } from '@platform/db/public';
import { type PreviewClaims, verifyPreviewToken } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { pageResponse } from './pages';
import { documentResponse, textResponse } from './site-response';

export interface PreviewDeps {
  /** The normalised preview host name, for example `preview.sites.example.com`. */
  host: string;
  secrets: { current: string; previous?: string | undefined };
  catalog: (templateId: string, version?: number) => Promise<CatalogTemplate | null>;
  /**
   * Whether the link with this id was revoked. A database failure must throw: the route then fails closed (503)
   * rather than serving a link that may have been withdrawn.
   */
  isRevoked: (linkId: string) => Promise<boolean>;
  logger: Logger;
  now?: () => Date;
}

const TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const MAX_ENTRIES = 50;

/** Templates are immutable per version, so a short in-process cache only saves database round trips. */
const cache = new Map<string, { at: number; value: CatalogTemplate | null }>();

/**
 * Revocation answers. A revoked link stays revoked (the row cannot change back), so a "revoked" answer is kept for
 * minutes; "not revoked" is kept briefly, which is also how long a new revocation can take to reach every instance.
 */
const REVOKED_TTL_MS = 300_000;
const ACTIVE_TTL_MS = 30_000;
const revocations = new Map<string, { at: number; revoked: boolean }>();

export function clearPreviewCache(): void {
  cache.clear();
  revocations.clear();
}

async function isRevoked(deps: PreviewDeps, linkId: string): Promise<boolean> {
  const now = Date.now();
  const hit = revocations.get(linkId);
  if (hit && now - hit.at < (hit.revoked ? REVOKED_TTL_MS : ACTIVE_TTL_MS)) return hit.revoked;
  const revoked = await deps.isRevoked(linkId);
  if (revocations.size >= 500) revocations.delete(revocations.keys().next().value as string);
  revocations.set(linkId, { at: now, revoked });
  return revoked;
}

async function loadTemplate(deps: PreviewDeps, claims: PreviewClaims): Promise<CatalogTemplate | null> {
  const key = `${claims.tpl}:${claims.ver ?? 'latest'}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < (hit.value ? TTL_MS : NEGATIVE_TTL_MS)) return hit.value;
  const value = await deps.catalog(claims.tpl, claims.ver);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, value });
  return value;
}

interface PreviewConfig {
  business?: { name?: unknown; language?: unknown; logo?: { alt?: unknown } };
  pages?: { seo?: { title?: unknown; description?: unknown } }[];
}

/** Cuts to `max` UTF-16 units (the schema counts those) without leaving half of a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Puts the prospect's name where the demo name appears: the business name, the logo's alt text and the pages' SEO
 * title and description (the tab title of the preview). Text only; the renderer validates the result like any config.
 */
function personalise(config: PreviewConfig, name: string): void {
  const demo = config.business?.name;
  if (!config.business || typeof demo !== 'string' || demo === '') return;
  config.business.name = name;
  // The prospect's name may be longer than the demo name, so each swapped text is cut to the schema limit (SEO title
  // 70, description 200, logo alt 120); without that a 60-character name would make the whole preview invalid.
  const swap = (v: unknown, max: number) => (typeof v === 'string' ? clip(v.split(demo).join(name), max) : v);
  if (config.business.logo) config.business.logo.alt = swap(config.business.logo.alt, 120);
  for (const page of config.pages ?? []) {
    if (page.seo) {
      page.seo.title = swap(page.seo.title, 70);
      page.seo.description = swap(page.seo.description, 200);
    }
  }
}

const TOKEN_PATH = /^\/p\/([A-Za-z0-9._-]{1,700})(\/.*)?$/;
const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/;

export async function servePreview(
  request: Request,
  hostname: string,
  deps: PreviewDeps,
  common: { head: boolean; correlationId: string | undefined },
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === '/robots.txt') {
    return textResponse('User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8', {
      ...common,
      indexable: false,
    });
  }
  const match = TOKEN_PATH.exec(path);
  if (!match) return pageResponse('preview_invalid', common);
  const token = match[1] as string;
  const rest = match[2] ?? '/';

  const verdict = verifyPreviewToken(deps.secrets, token, deps.now?.());
  if (!verdict.ok)
    return pageResponse(verdict.reason === 'expired' ? 'preview_expired' : 'preview_invalid', common);

  // Only after the signature and the expiry: a forged or expired link never causes a lookup.
  if (verdict.claims.lid && (await isRevoked(deps, verdict.claims.lid))) {
    return pageResponse('preview_revoked', common);
  }

  const template = await loadTemplate(deps, verdict.claims);
  if (!template) return pageResponse('preview_invalid', common);

  // Demo data, personalised with the prospect's business name when the link carries one.
  const config = structuredClone(template.config) as PreviewConfig;
  if (verdict.claims.name) personalise(config, verdict.claims.name);
  const locale = config.business?.language === 'hi' ? 'hi' : 'en';

  const local = hostname.endsWith('localhost');
  const rawHost = request.headers.get('host')?.toLowerCase() ?? '';
  const authority = local && HOST_HEADER.test(rawHost) ? rawHost : hostname;
  const doc = renderDocument({
    config,
    path: rest,
    origin: `${local ? 'http' : 'https'}://${authority}`,
    mode: 'preview',
    basePath: `/p/${token}`,
    banner: t(locale, 'previewBanner', { name: template.name }),
    onBlockError: (info) => deps.logger.warn('sites.preview.block_error', { ...info }),
  });
  if (doc.kind !== 'page') {
    deps.logger.warn('sites.preview.render_failed', {
      kind: doc.kind,
      template: template.slug,
      version: template.version,
    });
    return pageResponse('unavailable', common);
  }
  return documentResponse(doc, {
    ...common,
    assetOrigin: null,
    leadForm: false,
    secure: !local,
    extraHeaders: { 'referrer-policy': 'no-referrer' },
  });
}
