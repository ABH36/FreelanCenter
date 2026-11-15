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
 */
import { renderDocument, t } from '@platform/blocks';
import type { StagingSite } from '@platform/db/public';
import { verifyStagingToken } from '@platform/hosting';
import type { Logger } from '@platform/logger';
import { pageResponse } from './pages';
import { documentResponse } from './site-response';
import { versionAssets } from './site-source';

export interface StagingDeps {
  secrets: { current: string; previous?: string | undefined };
  stagingSite: (linkId: string) => Promise<StagingSite>;
  logger: Logger;
  now?: () => Date;
}

export const STAGING_PATH = /^\/s\/([A-Za-z0-9._-]{1,300})(\/.*)?$/;
const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/;

export async function serveStaging(
  request: Request,
  hostname: string,
  deps: StagingDeps,
  common: { head: boolean; correlationId: string | undefined },
): Promise<Response> {
  const match = STAGING_PATH.exec(new URL(request.url).pathname);
  if (!match) return pageResponse('staging_invalid', common);
  const token = match[1] as string;
  const rest = match[2] ?? '/';

  const verdict = verifyStagingToken(deps.secrets, token, deps.now?.());
  if (!verdict.ok) {
    if (verdict.reason !== 'expired') return pageResponse('staging_invalid', common);
  }
  const linkId = verdict.ok ? verdict.claims.lid : verdict.reason === 'expired' ? verdict.claims.lid : null;
  if (!linkId) return pageResponse('staging_invalid', common);
  const site = await deps.stagingSite(linkId);
  if (site.status === 'unknown') return pageResponse('staging_invalid', common);
  if (!verdict.ok || site.status === 'expired')
    return pageResponse('staging_expired', { ...common, sender: site.sender });
  if (site.status === 'revoked') return pageResponse('staging_revoked', { ...common, sender: site.sender });
  if (site.status !== 'ok') return pageResponse('staging_unavailable', { ...common, sender: site.sender });

  const config = site.config as { business?: { name?: unknown; language?: unknown } } | null;
  const name = typeof config?.business?.name === 'string' ? config.business.name : 'this website';
  const locale = config?.business?.language === 'hi' ? 'hi' : 'en';
  const local = hostname.endsWith('localhost');
  const rawHost = request.headers.get('host')?.toLowerCase() ?? '';
  const authority = local && HOST_HEADER.test(rawHost) ? rawHost : hostname;
  const assets = versionAssets(site.assets);
  const doc = renderDocument({
    config: site.config,
    path: rest,
    origin: `${local ? 'http' : 'https'}://${authority}`,
    mode: 'preview',
    basePath: `/s/${token}`,
    noindex: true,
    banner: t(locale, 'stagingBanner', { name }),
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
