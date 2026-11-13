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
import { parseSiteConfig } from '@platform/schema';
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
  /** The name of the workspace that made a link; best effort (a failure just leaves the name out). */
  sender?: (linkId: string) => Promise<string | null>;
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
function personaliseName(config: PreviewConfig, name: string): void {
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

type Json = unknown;

/** Replaces `from` by `to` in every string of a JSON value (keys untouched). */
function replaceEverywhere(value: Json, from: string, to: string): Json {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => replaceEverywhere(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([k, v]) => [k, replaceEverywhere(v, from, to)]),
    );
  }
  return value;
}

interface Address {
  line1?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  geo?: unknown;
}

/**
 * The demo, made the prospect's (P2 S10, acceptance run 2: "City Cabs Indore" showed a Jaipur address). The demo name
 * and the demo city are replaced in every text of the site (headline, about, FAQ, reviews...); with a city, the demo
 * street, state, postcode and map position are dropped, because they belong to the demo city. Demo social accounts
 * are removed in every preview: they would point at real third-party pages. If replacing everywhere makes a text too
 * long for the schema, the careful version (name in the known fields only) is used instead, so a preview never breaks.
 */
function personalise(config: PreviewConfig, prospect: { name?: string; city?: string }): PreviewConfig {
  const business = (config.business ?? {}) as Record<string, unknown>;
  delete business['social'];
  const demoName = typeof business['name'] === 'string' ? (business['name'] as string) : '';
  const address = (business['address'] ?? undefined) as Address | undefined;
  const demoCity = typeof address?.city === 'string' ? address.city : '';

  let full = config as Json;
  if (prospect.name && demoName) full = replaceEverywhere(full, demoName, prospect.name);
  if (prospect.city && demoCity) full = replaceEverywhere(full, demoCity, prospect.city);
  const candidate = full as PreviewConfig & { business?: { address?: Address } };
  if (prospect.city && candidate.business) {
    candidate.business.address = { city: prospect.city };
  }
  if (parseSiteConfig(candidate).ok) return candidate;

  // Fallback: the name in the known fields only, and the city in the address only.
  const safe = structuredClone(config) as PreviewConfig & { business?: { address?: Address } };
  if (prospect.name) personaliseName(safe, prospect.name);
  if (prospect.city && safe.business) safe.business.address = { city: prospect.city };
  return safe;
}

/** Who sent a link (only for links whose signature was verified); never fails the page. */
async function senderOf(deps: PreviewDeps, linkId: string | undefined): Promise<string | null> {
  if (!linkId || !deps.sender) return null;
  try {
    return await deps.sender(linkId);
  } catch {
    return null;
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
  if (!verdict.ok) {
    if (verdict.reason === 'expired') {
      return pageResponse('preview_expired', { ...common, sender: await senderOf(deps, verdict.claims.lid) });
    }
    return pageResponse('preview_invalid', common);
  }

  // Only after the signature and the expiry: a forged or expired link never causes a revocation or catalogue lookup
  // (an expired one, whose signature is genuine, may ask who sent it, for its page).
  if (verdict.claims.lid && (await isRevoked(deps, verdict.claims.lid))) {
    return pageResponse('preview_revoked', { ...common, sender: await senderOf(deps, verdict.claims.lid) });
  }

  const template = await loadTemplate(deps, verdict.claims);
  if (!template) return pageResponse('preview_invalid', common);

  // Demo data, personalised with the prospect's business name when the link carries one.
  const config = personalise(structuredClone(template.config) as PreviewConfig, {
    ...(verdict.claims.name ? { name: verdict.claims.name } : {}),
    ...(verdict.claims.city ? { city: verdict.claims.city } : {}),
  });
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
    banner: verdict.claims.name
      ? t(locale, 'previewBannerFor', { prospect: verdict.claims.name, name: template.name })
      : t(locale, 'previewBanner', { name: template.name }),
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
