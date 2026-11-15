/**
 * Staging links (FR-PUB-01, P3 S7a; approved decision 1): `https://<preview host>/s/<token>[/<page>]` shows a
 * project's current staging version to the freelancer's client, without an account. 14 days at most, revocable one
 * by one (the token names a `staging_links` row), `noindex`, no analytics.
 *
 *   s1.<base64url(JSON claims)>.<base64url(HMAC-SHA256 over "s1." + the claims part)>
 *
 * Claims (closed set): `lid` the link row id, `iat` and `exp` (epoch seconds). Nothing else: what the link shows is
 * decided by the database at request time (the project's staging pointer), so a token never carries a tenant id.
 *
 * It reuses the preview-link secret (PREVIEW_TOKEN_SECRET, with rotation), domain-separated by the `s1.` prefix: a
 * preview token (`v1.`) can never verify as a staging token or the other way round, because the prefix is part of
 * the signed input. Same verification order and properties as preview tokens: length bound, constant-time
 * signature check before parsing, canonical base64url only, `iat` not from the future, lifetime cap.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STAGING_TOKEN = {
  version: 's1',
  /** Approved decision 1: 14 days. */
  maxLifetimeSeconds: 14 * 24 * 3600,
  clockSkewSeconds: 300,
  maxLength: 300,
  minSecretLength: 32,
} as const;

export interface StagingClaims {
  /** The staging_links row id (UUID). */
  lid: string;
  iat: number;
  exp: number;
}

export type StagingVerdict =
  | { ok: true; claims: StagingClaims }
  | { ok: false; reason: 'malformed' | 'signature' }
  /** The signature was valid, so the claims are genuine; only the time has run out. */
  | { ok: false; reason: 'expired'; claims: StagingClaims };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const sign = (secret: string, input: string) => createHmac('sha256', secret).update(input).digest();

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < STAGING_TOKEN.minSecretLength) {
    throw new Error(`The staging token secret must be at least ${STAGING_TOKEN.minSecretLength} characters`);
  }
}

/** Signs a staging link. Throws on invalid input: a link that cannot be verified must never be issued. */
export function mintStagingToken(
  secret: string,
  options: { linkId: string; expiresAt: Date; now?: Date },
): string {
  assertSecret(secret);
  if (!UUID.test(options.linkId)) throw new Error('linkId must be a lowercase UUID');
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const exp = Math.floor(options.expiresAt.getTime() / 1000);
  if (!Number.isInteger(exp) || exp - iat < 60 || exp - iat > STAGING_TOKEN.maxLifetimeSeconds) {
    throw new Error('The lifetime must be between 60 seconds and 14 days');
  }
  const claims: StagingClaims = { lid: options.linkId, iat, exp };
  const head = `${STAGING_TOKEN.version}.${b64(JSON.stringify(claims))}`;
  return `${head}.${b64(sign(secret, head))}`;
}

function parseClaims(json: string): StagingClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['exp', 'iat', 'lid'])) return null;
  if (typeof r['lid'] !== 'string' || !UUID.test(r['lid'])) return null;
  if (!Number.isSafeInteger(r['iat']) || !Number.isSafeInteger(r['exp'])) return null;
  return { lid: r['lid'], iat: r['iat'] as number, exp: r['exp'] as number };
}

/** Verifies against the current secret and, during a rotation, the previous one. Never throws. */
export function verifyStagingToken(
  secrets: { current: string; previous?: string | undefined },
  token: string,
  now: Date = new Date(),
): StagingVerdict {
  try {
    assertSecret(secrets.current);
    if (typeof token !== 'string' || token.length === 0 || token.length > STAGING_TOKEN.maxLength) {
      return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== STAGING_TOKEN.version) return { ok: false, reason: 'malformed' };
    const [, payload, signature] = parts as [string, string, string];
    if (!B64URL.test(payload) || !B64URL.test(signature)) return { ok: false, reason: 'malformed' };

    const head = `${STAGING_TOKEN.version}.${payload}`;
    const given = Buffer.from(signature, 'base64url');
    let valid = false;
    for (const secret of [secrets.current, ...(secrets.previous ? [secrets.previous] : [])]) {
      if (secret.length < STAGING_TOKEN.minSecretLength) continue;
      const expected = sign(secret, head);
      if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
    }
    if (!valid) return { ok: false, reason: 'signature' };
    if (b64(given) !== signature || b64(Buffer.from(payload, 'base64url')) !== payload) {
      return { ok: false, reason: 'malformed' };
    }
    const claims = parseClaims(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims) return { ok: false, reason: 'malformed' };
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (
      claims.exp - claims.iat > STAGING_TOKEN.maxLifetimeSeconds ||
      claims.exp <= claims.iat ||
      claims.iat > nowSeconds + STAGING_TOKEN.clockSkewSeconds
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired', claims };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
