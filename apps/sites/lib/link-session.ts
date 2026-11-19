/**
 * P3 S9b (DG-37 (h); plan approved by the Owner 2026-11-19): link tokens out of the request path.
 *
 * Vercel's runtime log records every request path. Review links (`/s/<token>`) and preview links (`/p/<token>`) used to
 * carry their bearer token in every path (each page, each review form), so the token sat in the log for every request.
 * Now the first request of a visit exchanges it:
 *
 *   GET /s/<token>/<page>   → 303 /review/<key>/<page>   + cookie (the same token), Path=/review/<key>
 *   GET /p/<token>/<page>   → 303 /preview/<key>/<page>  + cookie (the same token), Path=/preview/<key>
 *
 * and every later request (pages, the review panel, comment and approval POSTs) uses the clean path, with the token in
 * a cookie the runtime log does not record. The cookie holds exactly the signed token, so every request verifies it as
 * before (HMAC, expiry, revocation in the database); nothing new is trusted. The key in the path is the link id (a
 * review link; a preview link that has one) or, for a preview link without an id, a SHA-256 digest of the token: it
 * names the link but opens nothing by itself. A clean path without a matching cookie (someone shared the address bar,
 * or cookies are blocked) shows "Open the link you were sent".
 *
 * Cookie: HttpOnly; Secure (except on a local http host); SameSite=Lax, so a cross-site POST never carries it (the
 * review POST also keeps its own same-origin check); Path limited to that one link; Max-Age until the token expires.
 * Residual (accepted by the Owner): the first request of each visit still has the token in its path.
 */
import { createHash } from 'node:crypto';

export type LinkKind = 'review' | 'preview';

/** The old, token-carrying paths. */
export const TOKEN_PATH: Record<LinkKind, RegExp> = {
  review: /^\/s\/([A-Za-z0-9._-]{1,300})(\/.*)?$/,
  preview: /^\/p\/([A-Za-z0-9._-]{1,700})(\/.*)?$/,
};

/** The clean paths: `/review/<key>[/<page>]`, `/preview/<key>[/<page>]`. */
export const CLEAN_PATH: Record<LinkKind, RegExp> = {
  review: /^\/review\/([A-Za-z0-9_-]{8,64})(\/.*)?$/,
  preview: /^\/preview\/([A-Za-z0-9_-]{8,64})(\/.*)?$/,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The path key of a link: its id, or (a preview link without one) a digest of the token. */
export function linkKey(token: string, linkId?: string): string {
  if (linkId && UUID.test(linkId)) return linkId;
  return `t${createHash('sha256').update(token).digest('base64url').slice(0, 43)}`;
}

export const cleanBase = (kind: LinkKind, key: string) => `/${kind}/${key}`;

const cookieName = (secure: boolean) => (secure ? '__Secure-link' : 'link');

/** The `Set-Cookie` value that carries the token for one link. */
export function linkCookie(input: {
  kind: LinkKind;
  key: string;
  token: string;
  expiresAt: number;
  now: number;
  secure: boolean;
}): string {
  const maxAge = Math.max(1, Math.floor(input.expiresAt - input.now));
  return [
    `${cookieName(input.secure)}=${input.token}`,
    `Path=${cleanBase(input.kind, input.key)}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    ...(input.secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}

/** The token from the request's cookie, if any (the browser sends only the one whose path matches this link). */
export function cookieToken(request: Request, secure: boolean): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const name = cookieName(secure);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9._-]{1,700}$/.test(value) ? value : null;
  }
  return null;
}

/** The 303 that moves a verified token from the path into the cookie. */
export function exchangeResponse(input: {
  kind: LinkKind;
  key: string;
  token: string;
  rest: string;
  search: string;
  expiresAt: number;
  now: number;
  secure: boolean;
  correlationId: string | undefined;
}): Response {
  const location = `${cleanBase(input.kind, input.key)}${input.rest === '/' ? '' : input.rest}${input.search}`;
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'set-cookie': linkCookie(input),
  });
  if (input.correlationId) headers.set('x-correlation-id', input.correlationId);
  return new Response(null, { status: 303, headers });
}
