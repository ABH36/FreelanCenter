/**
 * The dashboard's framed site previews (P3 S3 editor preview, P3 S7b version preview): a SiteConfig rendered by the
 * same renderer the sites app uses (`@platform/blocks`), answered with a strict policy. The response runs no script:
 * the renderer emits none and the policy allows none. It may be framed by the dashboard only
 * (`frame-ancestors 'self'`); next.config.ts excludes exactly these paths from the global `frame-ancestors 'none'`.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { renderDocument } from '@platform/blocks';
import type { SiteConfig } from '@platform/schema';

/** Fonts are copied into public/preview-fonts by scripts/copy-preview-fonts.mjs (same allow-list as the sites app). */
const PREVIEW_FONT_BASE = '/preview-fonts';

const styleSource = (css: string) => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;

function previewPolicy(inlineStyles: readonly string[], assetOrigin: string | null): string {
  return [
    "default-src 'none'",
    `style-src ${inlineStyles.map(styleSource).join(' ')}`,
    // P3 S6: the asset domain serves the image variants (R2; S3Mock locally).
    `img-src 'self' data:${assetOrigin ? ` ${assetOrigin}` : ''}`,
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** The origin of ASSET_PUBLIC_URL, or null while uploads are not configured. */
export function assetOrigin(): string | null {
  const url = process.env.ASSET_PUBLIC_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const previewText = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** Only path segments the renderer can route ("/about", "/services/gym"). */
export const previewPath = (path: string[] | undefined) =>
  `/${(path ?? []).filter((s) => /^[a-z0-9-]{1,40}$/.test(s)).join('/')}`;

export function previewResponse(input: {
  config: SiteConfig;
  path: string;
  origin: string;
  /** At most three segments: the renderer accepts at most three in a base path. */
  basePath: string;
  banner: string;
  assetUrl: (assetId: string, width: 400 | 800 | 1200 | 1600) => string | null;
}): Response {
  const doc = renderDocument({
    config: input.config,
    path: input.path,
    origin: input.origin,
    mode: 'draft',
    noindex: true,
    basePath: input.basePath,
    fontBase: PREVIEW_FONT_BASE,
    banner: input.banner,
    assetUrl: input.assetUrl,
  });
  if (doc.kind !== 'page') return previewText('This site cannot be shown.', 422);
  return new Response(doc.html, {
    status: doc.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': previewPolicy(doc.inlineStyles, assetOrigin()),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    },
  });
}
