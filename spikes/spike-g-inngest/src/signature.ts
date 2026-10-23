import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Independent implementation of the Inngest request-signature scheme, written from the observed wire
 * format so the SDK is not verified with itself (same approach as Spike F's TOTP):
 *
 *   X-Inngest-Signature: t=<unix seconds>&s=<hex HMAC-SHA256(key, canonicalJson(body) + t)>
 *
 * where `key` is the signing key with its `signkey-<env>-` prefix removed, used as UTF-8 text (not
 * hex-decoded), and canonicalJson is RFC 8785 (JCS). For the plain JSON values used here JCS equals
 * JSON.stringify with recursively sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hmacHex(signingKey: string, payload: string): string {
  const key = signingKey.replace(/^signkey-\w+-/, '');
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function sign(body: unknown, signingKey: string, unixSeconds: number): string {
  const payload = (typeof body === 'string' ? body : canonicalJson(body)) + String(unixSeconds);
  return `t=${unixSeconds}&s=${hmacHex(signingKey, payload)}`;
}

export function verify(header: string, body: unknown, signingKey: string, nowMs = Date.now()) {
  const params = new URLSearchParams(header);
  const t = Number(params.get('t'));
  const s = params.get('s') ?? '';
  if (!Number.isFinite(t) || !s) return { ok: false, reason: 'malformed' } as const;
  const expected = sign(body, signingKey, t).split('&s=')[1]!;
  const a = Buffer.from(expected);
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' } as const;
  return { ok: true, ageSeconds: Math.round(nowMs / 1000 - t) } as const;
}
