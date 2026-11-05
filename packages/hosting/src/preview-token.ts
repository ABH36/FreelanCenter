/**
 * Preview links (FR-TPL-09, P2 S6): a public, login-free, shareable, expiring link to a template with demo data.
 * The link carries a signed claim set; nothing is stored, so a link needs no database and the sites app can verify
 * it with a shared secret alone.
 *
 *   v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256 over "v1." + the first two parts)>
 *
 * Claims: `tpl` the template id, `ver` an optional template version (otherwise the latest), `name` an optional
 * prospect business name to personalise the demo, `iat` and `exp` (epoch seconds). The token is part of a URL path
 * (`/p/<token>`), so every internal link of the preview carries it and the link keeps working while someone browses.
 *
 * Security properties (each has a test): the signature is checked in constant time before anything is parsed or
 * trusted; a token is accepted only if `exp` is in the future, `exp - iat` is at most 30 days and `iat` is not from
 * the future (5 minutes of clock skew); secrets shorter than 32 characters are refused; the previous secret is still
 * accepted while a new one rolls out; the claim set is closed (unknown keys refuse the token); the token is length
 * bounded before any work. A link cannot be revoked individually: rotating the secret revokes all of them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TOKEN = {
  version: 'v1',
  /** The longest lifetime a link may be minted with and verified for. */
  maxLifetimeSeconds: 30 * 24 * 3600,
  defaultLifetimeSeconds: 7 * 24 * 3600,
  clockSkewSeconds: 300,
  maxLength: 700,
  maxNameLength: 60,
  minSecretLength: 32,
} as const;

export interface PreviewClaims {
  /** Template id (UUID). */
  tpl: string;
  /** Template version, or omitted for the latest. */
  ver?: number;
  /** The prospect's business name, shown instead of the demo name. Plain text, 1 to 60 characters. */
  name?: string;
  iat: number;
  exp: number;
}

export type PreviewVerdict =
  { ok: true; claims: PreviewClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
// Markup characters and control characters never belong in a business name (the schema rejects them too).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME = /[<>\u0000-\u001F\u007F‪-‮⁦-⁩]/;

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < PREVIEW_TOKEN.minSecretLength) {
    throw new Error(`The preview token secret must be at least ${PREVIEW_TOKEN.minSecretLength} characters`);
  }
}

export function isValidProspectName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length >= 1 &&
    Array.from(trimmed).length <= PREVIEW_TOKEN.maxNameLength &&
    !FORBIDDEN_NAME.test(trimmed)
  );
}

const sign = (secret: string, signingInput: string) =>
  createHmac('sha256', secret).update(signingInput).digest();

export interface MintOptions {
  templateId: string;
  version?: number;
  prospectName?: string;
  /** Lifetime in seconds. Default 7 days, at most 30. */
  lifetimeSeconds?: number;
  now?: Date;
}

/** Signs a preview link. Throws on any invalid input: a link that cannot be verified must never be issued. */
export function mintPreviewToken(secret: string, options: MintOptions): string {
  assertSecret(secret);
  if (!UUID.test(options.templateId)) throw new Error('templateId must be a lowercase UUID');
  if (
    options.version !== undefined &&
    !(Number.isInteger(options.version) && options.version >= 1 && options.version <= 10_000)
  ) {
    throw new Error('version must be an integer from 1 to 10000');
  }
  const name = options.prospectName?.trim();
  if (options.prospectName !== undefined && !(name && isValidProspectName(name))) {
    throw new Error('The prospect name must be 1 to 60 characters of plain text');
  }
  const lifetime = options.lifetimeSeconds ?? PREVIEW_TOKEN.defaultLifetimeSeconds;
  if (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > PREVIEW_TOKEN.maxLifetimeSeconds) {
    throw new Error('The lifetime must be between 60 seconds and 30 days');
  }
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const claims: PreviewClaims = {
    tpl: options.templateId,
    ...(options.version !== undefined ? { ver: options.version } : {}),
    ...(name ? { name } : {}),
    iat,
    exp: iat + lifetime,
  };
  const head = `${PREVIEW_TOKEN.version}.${b64(JSON.stringify(claims))}`;
  const token = `${head}.${b64(sign(secret, head))}`;
  if (token.length > PREVIEW_TOKEN.maxLength) throw new Error('The preview token would be too long');
  return token;
}

/**
 * Verifies a token against the current secret and, while one is rolling out, the previous one. Never throws: any
 * problem is a verdict. `expired` is only returned for a token whose signature was valid, so it never confirms
 * anything about a forged token.
 */
export function verifyPreviewToken(
  secrets: { current: string; previous?: string | undefined },
  token: string,
  now: Date = new Date(),
): PreviewVerdict {
  try {
    assertSecret(secrets.current);
    if (typeof token !== 'string' || token.length === 0 || token.length > PREVIEW_TOKEN.maxLength) {
      return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREVIEW_TOKEN.version) return { ok: false, reason: 'malformed' };
    const [, payload, signature] = parts as [string, string, string];
    if (!B64URL.test(payload) || !B64URL.test(signature)) return { ok: false, reason: 'malformed' };

    const head = `${parts[0]}.${payload}`;
    const given = Buffer.from(signature, 'base64url');
    const candidates = [secrets.current, ...(secrets.previous ? [secrets.previous] : [])];
    let valid = false;
    for (const secret of candidates) {
      if (secret.length < PREVIEW_TOKEN.minSecretLength) continue;
      const expected = sign(secret, head);
      if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
    }
    if (!valid) return { ok: false, reason: 'signature' };

    const claims = parseClaims(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims) return { ok: false, reason: 'malformed' };
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      claims.exp - claims.iat > PREVIEW_TOKEN.maxLifetimeSeconds ||
      claims.exp <= claims.iat ||
      claims.iat > nowSeconds + PREVIEW_TOKEN.clockSkewSeconds
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function parseClaims(json: string): PreviewClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!['tpl', 'ver', 'name', 'iat', 'exp'].includes(key)) return null;
  }
  if (typeof c['tpl'] !== 'string' || !UUID.test(c['tpl'])) return null;
  if (!Number.isInteger(c['iat']) || !Number.isInteger(c['exp'])) return null;
  if (
    c['ver'] !== undefined &&
    !(Number.isInteger(c['ver']) && (c['ver'] as number) >= 1 && (c['ver'] as number) <= 10_000)
  ) {
    return null;
  }
  if (c['name'] !== undefined && !(typeof c['name'] === 'string' && isValidProspectName(c['name'])))
    return null;
  return {
    tpl: c['tpl'],
    ...(c['ver'] !== undefined ? { ver: c['ver'] as number } : {}),
    ...(c['name'] !== undefined ? { name: (c['name'] as string).trim() } : {}),
    iat: c['iat'] as number,
    exp: c['exp'] as number,
  };
}
