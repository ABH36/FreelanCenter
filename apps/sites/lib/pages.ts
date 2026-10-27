/**
 * The four documents a host can get in P1 (S7): placeholder, maintenance, not found and unavailable. Static HTML
 * with no script and no tenant data at all (not even the project name: a draft is not public), so the CSP can be
 * `default-src 'none'` with one hashed stylesheet. P2/P3 replace the placeholder with the rendered site.
 *
 * Caching: `no-store` everywhere. The host decision is cached per host in Upstash (lib/runtime.ts); a CDN copy of
 * these documents could not be invalidated when a project changes. P3 adds versioned, tag-purged caching.
 */
import { createHash } from 'node:crypto';

export type PageKind = 'placeholder' | 'maintenance' | 'not_found' | 'unavailable';

const STYLE =
  'html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;' +
  'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f7f7f8;color:#1f2328}' +
  'main{max-width:32rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}' +
  'p{margin:0;color:#57606a}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}' +
  'p{color:#9da7b3}}';

const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export const PAGE_CSP = [
  "default-src 'none'",
  `style-src '${STYLE_HASH}'`,
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface PageSpec {
  status: number;
  title: string;
  heading: string;
  message: string;
  /** Seconds, for 503 only. */
  retryAfter?: number;
}

const PAGES: Record<PageKind, PageSpec> = {
  placeholder: {
    status: 200,
    title: 'Coming soon',
    heading: 'This website is coming soon',
    message: 'It is still being prepared. Please check back later.',
  },
  maintenance: {
    status: 503,
    title: 'Temporarily unavailable',
    heading: 'This website is temporarily unavailable',
    message: 'Please try again later.',
    retryAfter: 3600,
  },
  not_found: {
    status: 404,
    title: 'Site not found',
    heading: 'There is no website at this address',
    message: 'Check the address and try again.',
  },
  unavailable: {
    status: 503,
    title: 'Temporarily unavailable',
    heading: 'Something went wrong on our side',
    message: 'Please try again in a moment.',
    retryAfter: 30,
  },
};

function documentFor(spec: PageSpec): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="robots" content="noindex,nofollow"><title>${spec.title}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${spec.heading}</h1><p>${spec.message}</p></main></body></html>`
  );
}

const DOCUMENTS = Object.fromEntries(
  Object.entries(PAGES).map(([kind, spec]) => [kind, documentFor(spec)]),
) as Record<PageKind, string>;

export function pageResponse(
  kind: PageKind,
  options: { head?: boolean; correlationId?: string } = {},
): Response {
  const spec = PAGES[kind];
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'x-robots-tag': 'noindex, nofollow',
  });
  if (spec.retryAfter) headers.set('retry-after', String(spec.retryAfter));
  if (options.correlationId) headers.set('x-correlation-id', options.correlationId);
  return new Response(options.head ? null : DOCUMENTS[kind], { status: spec.status, headers });
}
