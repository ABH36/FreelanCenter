/**
 * HTTP side of a rendered site: the Content-Security-Policy (SEC-03), headers and response bodies for pages,
 * sitemap.xml and robots.txt. The policy is built per response from the exact inline style text, so there is no
 * `'unsafe-inline'` and no script source at all: tenant pages run no JavaScript.
 */
import { createHash } from 'node:crypto';
import type { DocumentResult } from '@platform/blocks';

const hashCache = new Map<string, string>();

/** CSP source for one inline style. The static stylesheet is hashed once per process. */
export function styleHash(css: string): string {
  let h = hashCache.get(css);
  if (!h) {
    h = `'sha256-${createHash('sha256').update(css).digest('base64')}'`;
    if (hashCache.size > 500) hashCache.clear();
    hashCache.set(css, h);
  }
  return h;
}

const ORIGIN_SOURCE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
/** Local development only (`secure: false`): the S3Mock asset origin is plain http on this machine. */
const LOCAL_ORIGIN_SOURCE = /^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9.-]+\.localhost)(:\d{1,5})?$/;

export function contentSecurityPolicy(options: {
  inlineStyles: readonly string[];
  /** `https://assets.example.test`: where pre-generated images live. Anything that is not a plain https origin is ignored. */
  assetOrigin?: string | null;
  leadForm?: boolean;
  secure: boolean;
}): string {
  const images = ["'self'", 'data:'];
  const origin = options.assetOrigin;
  if (origin && (ORIGIN_SOURCE.test(origin) || (!options.secure && LOCAL_ORIGIN_SOURCE.test(origin)))) {
    images.push(origin);
  }
  return [
    "default-src 'none'",
    `style-src ${options.inlineStyles.map(styleHash).join(' ')}`,
    `img-src ${images.join(' ')}`,
    "font-src 'self'",
    `form-action ${options.leadForm ? "'self'" : "'none'"}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(options.secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

interface Common {
  head: boolean;
  correlationId: string | undefined;
  /** Default `no-store`. Live published pages: `LIVE_CACHE_CONTROL` (decision 5). */
  cacheControl?: string;
}

/**
 * P3 S7a, approved decision 5: a live page may be kept by a shared cache (the CDN) for 60 seconds, never by the
 * browser. Publishing and rollback change what the host resolves to at once (host-cache invalidation); the 60 s bound
 * what a CDN copy can lag until the CDN purge arrives with the sites domain (DG-33).
 */
export const LIVE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

function baseHeaders(contentType: string, c: Common, csp: string, indexable: boolean): Headers {
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': c.cacheControl ?? 'no-store',
    'content-security-policy': csp,
  });
  if (!indexable) headers.set('x-robots-tag', 'noindex, nofollow');
  if (c.correlationId) headers.set('x-correlation-id', c.correlationId);
  return headers;
}

export function documentResponse(
  doc: Extract<DocumentResult, { kind: 'page' }>,
  options: Common & {
    assetOrigin?: string | null;
    leadForm?: boolean;
    secure: boolean;
    /** Extra response headers (previews: `referrer-policy: no-referrer`, so the token never leaves in a Referer). */
    extraHeaders?: Record<string, string>;
  },
): Response {
  const csp = contentSecurityPolicy({
    inlineStyles: doc.inlineStyles,
    assetOrigin: options.assetOrigin ?? null,
    leadForm: options.leadForm ?? false,
    secure: options.secure,
  });
  const headers = baseHeaders('text/html; charset=utf-8', options, csp, doc.indexable);
  for (const [k, v] of Object.entries(options.extraHeaders ?? {})) headers.set(k, v);
  return new Response(options.head ? null : doc.html, { status: doc.status, headers });
}

/** sitemap.xml and robots.txt: plain documents that load nothing. */
export function textResponse(
  body: string,
  contentType: 'application/xml; charset=utf-8' | 'text/plain; charset=utf-8',
  options: Common & { indexable: boolean },
): Response {
  return new Response(options.head ? null : body, {
    status: 200,
    headers: baseHeaders(contentType, options, "default-src 'none'", options.indexable),
  });
}
