import { randomBytes } from 'node:crypto';

/** Any RFC 9562 UUID (versions 1-8, RFC variant), lower or upper case. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * RFC 9562 UUID v7 (SRS 5.1): 48-bit Unix milliseconds, then random bits. Used for identity rows that
 * Better Auth inserts; tenant tables default to the equivalent SQL function `app.uuid_generate_v7()`.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
