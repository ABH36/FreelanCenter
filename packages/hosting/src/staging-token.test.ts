import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintPreviewToken } from './preview-token';
import { STAGING_TOKEN, mintStagingToken, verifyStagingToken } from './staging-token';

const SECRET = 'a'.repeat(32) + 'secret-for-tests-only';
const OTHER = 'b'.repeat(32) + 'another-secret-for-tests';
const LID = '01920000-0000-7000-8000-0000000000bb';
const T0 = new Date('2026-11-15T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const DAY = 86_400;
const mint = (lifetime = 14 * DAY, secret = SECRET) =>
  mintStagingToken(secret, { linkId: LID, expiresAt: at(lifetime), now: T0 });
const forge = (payload: object, secret = SECRET, prefix = 's1') => {
  const head = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
};
const iat = T0.getTime() / 1000;

describe('staging tokens', () => {
  it('round-trips the closed claim set and stays short', () => {
    const t = mint();
    expect(verifyStagingToken({ current: SECRET }, t, at(60))).toEqual({
      ok: true,
      claims: { lid: LID, iat, exp: iat + 14 * DAY },
    });
    expect(t.length).toBeLessThan(STAGING_TOKEN.maxLength);
    expect(t.startsWith('s1.')).toBe(true);
  });

  it('expires, and reports expiry only for a genuine token', () => {
    const v = verifyStagingToken({ current: SECRET }, mint(DAY), at(DAY + 1));
    expect(v).toEqual({ ok: false, reason: 'expired', claims: { lid: LID, iat, exp: iat + DAY } });
    expect(verifyStagingToken({ current: SECRET }, mint(DAY, OTHER), at(DAY + 1))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuses more than 14 days, at minting and at verification', () => {
    expect(() => mint(14 * DAY + 1)).toThrow();
    expect(() => mint(30)).toThrow();
    const long = forge({ lid: LID, iat, exp: iat + 15 * DAY });
    expect(verifyStagingToken({ current: SECRET }, long, at(1))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts the previous secret during a rotation, not a random one', () => {
    expect(verifyStagingToken({ current: OTHER, previous: SECRET }, mint(), at(1)).ok).toBe(true);
    expect(verifyStagingToken({ current: OTHER }, mint(), at(1))).toEqual({ ok: false, reason: 'signature' });
  });

  it('is domain-separated from preview tokens in both directions', () => {
    const preview = mintPreviewToken(SECRET, { templateId: LID, now: T0 });
    expect(verifyStagingToken({ current: SECRET }, preview, at(1)).ok).toBe(false);
    // The same claims signed under the preview prefix, relabelled: the signature no longer matches.
    const relabelled = forge({ lid: LID, iat, exp: iat + DAY }, SECRET, 'v1').replace(/^v1\./, 's1.');
    expect(verifyStagingToken({ current: SECRET }, relabelled, at(1))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuses extra or malformed claims, future iat, tampering and junk', () => {
    const extra = forge({ lid: LID, iat, exp: iat + DAY, ws: LID });
    const badId = forge({ lid: 'not-a-uuid', iat, exp: iat + DAY });
    const future = forge({ lid: LID, iat: iat + 3600, exp: iat + DAY });
    for (const t of [extra, badId, future]) {
      expect(verifyStagingToken({ current: SECRET }, t, at(1))).toEqual({ ok: false, reason: 'malformed' });
    }
    const t = mint();
    const tampered = `${t.slice(0, -2)}${t.endsWith('A') ? 'B' : 'A'}${t.slice(-1)}`;
    expect(verifyStagingToken({ current: SECRET }, tampered, at(1)).ok).toBe(false);
    for (const junk of ['', 's1', 's1..', 'x'.repeat(400), `${t}.x`]) {
      expect(verifyStagingToken({ current: SECRET }, junk, at(1)).ok).toBe(false);
    }
  });

  it('refuses short secrets and bad link ids when minting', () => {
    expect(() => mintStagingToken('short', { linkId: LID, expiresAt: at(DAY), now: T0 })).toThrow();
    expect(() => mintStagingToken(SECRET, { linkId: 'X', expiresAt: at(DAY), now: T0 })).toThrow();
  });
});
