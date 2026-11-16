/**
 * Staging links (FR-PUB-01, P3 S7a; approved decision 1): `https://<preview host>/s/<token>[/<page>]` shows a
 * project's current staging version to the freelancer's client. Served on the preview host only (a reserved label no
 * tenant can own), `noindex`, no analytics, `no-store`, `no-referrer`.
 *
 * Trust: the token is verified (constant-time HMAC, expiry, closed claims) before anything else; a forged or expired
 * token never reaches the database (an expired one, whose signature is genuine, is looked up only to name its sender
 * on the page). Then `app.get_staging_site` (app_public) says what the link may show now:
 * revoked, expired, unavailable (paused project, suspended workspace, nothing on staging yet) or the version. The
 * stored config is re-validated by the renderer like any config. A database failure throws: the route fails closed
 * (503) rather than serving a link that may have been withdrawn.
 *
 * P3 S8a (FR-PUB-05): with review configured, every shown section ends with a "Comment on this section" link and
 * the banner links to the review panel (`/s/<token>/_review`, review.ts), where the client comments and approves.
 */
import { renderDocument, t } from '@platform/blocks';
import type { StagingSite } from '@platform/db/public';
import { verifyStagingToken } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { pageResponse } from './pages';
import {
  REVIEW_PANEL,
  type ReviewDeps,
  type ReviewTarget,
  handlePost,
  localeOf,
  reviewAction,
  reviewLinks,
  servePanel,
} from './review';
import { documentResponse } from './site-response';
import { versionAssets } from './site-source';

export interface StagingDeps {
  secrets: { current: string; previous?: string | undefined };
  stagingSite: (linkId: string) => Promise<StagingSite>;
  logger: Logger;
  now?: () => Date;
  /** P3 S8a: client review (comments and approval); absent = the link only shows the site. */
  review?: ReviewDeps;
}

export const STAGING_PATH = /^\/s\/([A-Za-z0-9._-]{1,300})(\/.*)?$/;
const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/;

type Common = { head: boolean; correlationId: string | undefined };

type Opened =
  | { kind: 'response'; response: Response }
  | {
      kind: 'ok';
      token: string;
      linkId: string;
      rest: string;
      site: Extract<StagingSite, { status: 'ok' }>;
      origin: string;
      local: boolean;
    };

/** Verify the token and ask the database what the link may show now. */
async function openLink(
  request: Request,
  hostname: string,
  deps: StagingDeps,
  common: Common,
): Promise<Opened> {
  const page = (response: Response): Opened => ({ kind: 'response', response });
  const match = STAGING_PATH.exec(new URL(request.url).pathname);
  if (!match) return page(pageResponse('staging_invalid', common));
  const token = match[1] as string;
  const rest = match[2] ?? '/';

  const verdict = verifyStagingToken(deps.secrets, token, deps.now?.());
  if (!verdict.ok) {
    if (verdict.reason !== 'expired') return page(pageResponse('staging_invalid', common));
  }
  const linkId = verdict.ok ? verdict.claims.lid : verdict.reason === 'expired' ? verdict.claims.lid : null;
  if (!linkId) return page(pageResponse('staging_invalid', common));
  const site = await deps.stagingSite(linkId);
  if (site.status === 'unknown') return page(pageResponse('staging_invalid', common));
  if (!verdict.ok || site.status === 'expired')
    return page(pageResponse('staging_expired', { ...common, sender: site.sender }));
  if (site.status === 'revoked')
    return page(pageResponse('staging_revoked', { ...common, sender: site.sender }));
  if (site.status !== 'ok')
    return page(pageResponse('staging_unavailable', { ...common, sender: site.sender }));

  const local = hostname.endsWith('localhost');
  const rawHost = request.headers.get('host')?.toLowerCase() ?? '';
  const authority = local && HOST_HEADER.test(rawHost) ? rawHost : hostname;
  return {
    kind: 'ok',
    token,
    linkId,
    rest,
    site,
    origin: `${local ? 'http' : 'https'}://${authority}`,
    local,
  };
}

function reviewTarget(opened: Extract<Opened, { kind: 'ok' }>): ReviewTarget {
  return {
    token: opened.token,
    linkId: opened.linkId,
    siteVersionId: opened.site.siteVersionId,
    config: opened.site.config,
    publishedAt: opened.site.publishedAt,
    sender: opened.site.sender,
    origin: opened.origin,
  };
}

export async function serveStaging(
  request: Request,
  hostname: string,
  deps: StagingDeps,
  common: Common,
): Promise<Response> {
  const opened = await openLink(request, hostname, deps, common);
  if (opened.kind === 'response') return opened.response;
  const { token, rest, site, origin, local } = opened;

  if (rest === REVIEW_PANEL && deps.review) {
    const panel = await servePanel(request, reviewTarget(opened), deps.review, { ...common, secure: !local });
    if (panel) return panel;
    deps.logger.warn('sites.staging.render_failed', { kind: 'invalid', siteVersionId: site.siteVersionId });
    return pageResponse('unavailable', common);
  }

  const config = site.config as { business?: { name?: unknown } } | null;
  const name = typeof config?.business?.name === 'string' ? config.business.name : 'this website';
  const locale = localeOf(site.config);
  const assets = versionAssets(site.assets);
  const doc = renderDocument({
    config: site.config,
    path: rest,
    origin,
    mode: 'preview',
    basePath: `/s/${token}`,
    noindex: true,
    banner: t(locale, 'stagingBanner', { name }),
    ...(deps.review ? { review: reviewLinks(token, locale) } : {}),
    ...(assets.assetUrl ? { assetUrl: assets.assetUrl } : {}),
    onBlockError: (info) => deps.logger.warn('sites.staging.block_error', { ...info }),
  });
  if (doc.kind !== 'page') {
    deps.logger.warn('sites.staging.render_failed', { kind: doc.kind, siteVersionId: site.siteVersionId });
    return pageResponse('unavailable', common);
  }
  return documentResponse(doc, {
    ...common,
    assetOrigin: assets.assetOrigin ?? null,
    leadForm: false,
    secure: !local,
    extraHeaders: { 'referrer-policy': 'no-referrer' },
  });
}

/** POST on a staging link: only the two review actions; anything else is 405. */
export async function serveStagingPost(
  request: Request,
  hostname: string,
  deps: StagingDeps,
  common: Common,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const rest = STAGING_PATH.exec(path)?.[2] ?? '/';
  const action = reviewAction(rest);
  if (!action || !deps.review) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }
  const opened = await openLink(request, hostname, deps, common);
  if (opened.kind === 'response') return opened.response;
  const outcome = await handlePost(request, action, reviewTarget(opened), deps.review, common);
  if (outcome.kind === 'response') return outcome.response;
  // The link was turned off (or the project paused) between the check and the write: show why.
  const again = await openLink(request, hostname, deps, common);
  return again.kind === 'response' ? again.response : pageResponse('staging_unavailable', common);
}
