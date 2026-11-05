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

export function contentSecurityPolicy(options: {
  inlineStyles: readonly string[];
  /** `https://assets.example.test`: where pre-generated images live. Anything that is not a plain https origin is ignored. */
  assetOrigin?: string | null;
  leadForm?: boolean;
  secure: boolean;
}): string {
  const images = ["'self'", 'data:'];
  if (options.assetOrigin && ORIGIN_SOURCE.test(options.assetOrigin)) images.push(options.assetOrigin);
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
}

function baseHeaders(contentType: string, c: Common, csp: string, indexable: boolean): Headers {
  const headers = new Headers({
    'content-type': contentType,
    // Versioned, tag-purged caching arrives with published versions (P3, NFR-PERF-02).
    'cache-control': 'no-store',
    'content-security-policy': csp,
  });
  if (!indexable) headers.set('x-robots-tag', 'noindex, nofollow');
  if (c.correlationId) headers.set('x-correlation-id', c.correlationId);
  return headers;
}

export function documentResponse(
  doc: Extract<DocumentResult, { kind: 'page' }>,
  options: Common & { assetOrigin?: string | null; leadForm?: boolean; secure: boolean },
): Response {
  const csp = contentSecurityPolicy({
    inlineStyles: doc.inlineStyles,
    assetOrigin: options.assetOrigin ?? null,
    leadForm: options.leadForm ?? false,
    secure: options.secure,
  });
  return new Response(options.head ? null : doc.html, {
    status: doc.status,
    headers: baseHeaders('text/html; charset=utf-8', options, csp, doc.indexable),
  });
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
