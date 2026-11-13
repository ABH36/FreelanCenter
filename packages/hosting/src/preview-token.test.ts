import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PREVIEW_TOKEN, isValidProspectName, mintPreviewToken, verifyPreviewToken } from './preview-token';

const SECRET = 'a'.repeat(32) + 'secret-for-tests-only';
const OTHER = 'b'.repeat(32) + 'another-secret-for-tests';
const TPL = '01920000-0000-7000-8000-0000000000aa';
const T0 = new Date('2026-11-05T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const mint = (o: Partial<Parameters<typeof mintPreviewToken>[1]> = {}) =>
  mintPreviewToken(SECRET, { templateId: TPL, now: T0, ...o });
const forge = (payload: object, secret = SECRET) => {
  const head = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
};

describe('mint and verify', () => {
  it('round-trips the claims, with the default 7-day lifetime', () => {
    const v = verifyPreviewToken(
      { current: SECRET },
      mint({ version: 2, prospectName: '  Sharma Taxi  ' }),
      at(60),
    );
    expect(v).toEqual({
      ok: true,
      claims: {
        tpl: TPL,
        ver: 2,
        name: 'Sharma Taxi',
        iat: T0.getTime() / 1000,
        exp: T0.getTime() / 1000 + 7 * 86400,
      },
    });
  });

  it('omits optional claims and stays short enough for a URL path', () => {
    const t = mint();
    const v = verifyPreviewToken({ current: SECRET }, t, at(1));
    expect(v.ok && 'name' in v.claims).toBe(false);
    expect(t.length).toBeLessThan(250);
    expect(mint({ prospectName: 'ए'.repeat(60) }).length).toBeLessThanOrEqual(PREVIEW_TOKEN.maxLength);
  });

  it('is deterministic for the same input and time', () => {
    expect(mint({ prospectName: 'X' })).toBe(mint({ prospectName: 'X' }));
  });
});

describe('expiry and lifetime', () => {
  it('expires exactly at exp and reports "expired" only for a validly signed token', () => {
    const t = mint({ lifetimeSeconds: 3600 });
    expect(verifyPreviewToken({ current: SECRET }, t, at(3599)).ok).toBe(true);
    // An expired verdict carries the (genuinely signed) claims, so the page can name who sent the link.
    expect(verifyPreviewToken({ current: SECRET }, t, at(3600))).toMatchObject({
      ok: false,
      reason: 'expired',
      claims: { tpl: TPL },
    });
    expect(verifyPreviewToken({ current: OTHER }, t, at(99999))).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses lifetimes under a minute or over 30 days, at minting and at verification', () => {
    for (const lifetimeSeconds of [0, 59, 30 * 86400 + 1, -5, 1.5, NaN]) {
      expect(() => mint({ lifetimeSeconds }), String(lifetimeSeconds)).toThrow();
    }
    expect(() => mint({ lifetimeSeconds: 30 * 86400 })).not.toThrow();
    const iat = T0.getTime() / 1000;
    const longLived = forge({ tpl: TPL, iat, exp: iat + 31 * 86400 });
    expect(verifyPreviewToken({ current: SECRET }, longLived, at(1))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a token from the future beyond the clock-skew allowance, and exp before iat', () => {
    const iat = T0.getTime() / 1000;
    const future = forge({ tpl: TPL, iat: iat + 3600, exp: iat + 7200 });
    expect(verifyPreviewToken({ current: SECRET }, future, T0).ok).toBe(false);
    const skewed = forge({ tpl: TPL, iat: iat + 200, exp: iat + 4000 });
    expect(verifyPreviewToken({ current: SECRET }, skewed, T0).ok).toBe(true);
    expect(verifyPreviewToken({ current: SECRET }, forge({ tpl: TPL, iat, exp: iat - 10 }), T0).ok).toBe(
      false,
    );
  });
});

describe('tampering', () => {
  const t = mint({ prospectName: 'Sharma Taxi' });
  const [h, p, s] = t.split('.') as [string, string, string];

  it('any change to the payload or the signature is a signature failure', () => {
    const flipped = (x: string) => (x.startsWith('A') ? 'B' : 'A') + x.slice(1);
    expect(verifyPreviewToken({ current: SECRET }, `${h}.${flipped(p)}.${s}`, at(1))).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyPreviewToken({ current: SECRET }, `${h}.${p}.${flipped(s)}`, at(1))).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verifyPreviewToken({ current: SECRET }, `${h}.${p}.${s.slice(0, -2)}`, at(1)).ok).toBe(false);
  });

  it('a token signed with another secret, or with an empty or short secret, never verifies', () => {
    expect(
      verifyPreviewToken({ current: SECRET }, forge({ tpl: TPL, iat: 1, exp: 2 }, OTHER), at(0)).ok,
    ).toBe(false);
    expect(() => mintPreviewToken('short', { templateId: TPL })).toThrow(/at least 32/);
    expect(() => mintPreviewToken('', { templateId: TPL })).toThrow();
    expect(verifyPreviewToken({ current: 'short' }, t, at(1))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses malformed input without throwing', () => {
    const bad = [
      '',
      'x',
      'v1',
      'v1.a',
      'v1.a.b.c',
      `v2.${p}.${s}`,
      `${h}.${p}!.${s}`,
      `${h}.${p}.${s}=`,
      'a'.repeat(701),
      ` ${t}`,
      `${t}\n`,
      null,
      undefined,
      42,
      {},
    ];
    for (const x of bad)
      expect(verifyPreviewToken({ current: SECRET }, x as never, at(1)).ok, String(x)).toBe(false);
  });

  it('a correctly signed token with extra keys, wrong types or bad values is refused (closed claim set)', () => {
    const iat = T0.getTime() / 1000;
    const base = { tpl: TPL, iat, exp: iat + 3600 };
    for (const claims of [
      { ...base, admin: true },
      { ...base, tpl: 'not-a-uuid' },
      { ...base, tpl: TPL.toUpperCase() },
      { ...base, ver: 0 },
      { ...base, ver: 1.5 },
      { ...base, ver: '2' },
      { ...base, name: '' },
      { ...base, name: '<script>x</script>' },
      { ...base, name: 'x'.repeat(61) },
      { ...base, name: 5 },
      { ...base, iat: '1' },
      [],
      null,
    ]) {
      expect(
        verifyPreviewToken({ current: SECRET }, forge(claims as object), at(1)),
        JSON.stringify(claims),
      ).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('secret rotation', () => {
  it('a token minted with the previous secret still verifies while it is configured, then stops', () => {
    const old = mintPreviewToken(OTHER, { templateId: TPL, now: T0 });
    expect(verifyPreviewToken({ current: SECRET, previous: OTHER }, old, at(1)).ok).toBe(true);
    expect(verifyPreviewToken({ current: SECRET }, old, at(1)).ok).toBe(false);
    expect(verifyPreviewToken({ current: SECRET, previous: 'short' }, old, at(1)).ok).toBe(false);
  });
});

describe('inputs', () => {
  it('requires a lowercase UUID, a sane version and a plain-text name', () => {
    for (const templateId of ['', 'x', TPL.toUpperCase(), `${TPL}x`])
      expect(() => mint({ templateId })).toThrow();
    for (const version of [0, -1, 1.2, 10001, NaN]) expect(() => mint({ version })).toThrow();
    for (const prospectName of ['', '   ', '<b>x</b>', 'a\u0000b', 'x‮y', 'x'.repeat(61)]) {
      expect(() => mint({ prospectName }), prospectName).toThrow();
    }
    expect(isValidProspectName('शर्मा टैक्सी सर्विस')).toBe(true);
    expect(isValidProspectName('Tom & Jerry "Gym" it\'s')).toBe(true);
  });
});

describe('link id (P2 S8b)', () => {
  const LID = '01920000-0000-7000-8000-0000000000bb';
  it('round-trips the link id and keeps the token inside the length bound with every claim at its maximum', () => {
    const token = mint({
      linkId: LID,
      version: 10_000,
      prospectName: 'ए'.repeat(PREVIEW_TOKEN.maxNameLength),
    });
    expect(token.length).toBeLessThanOrEqual(PREVIEW_TOKEN.maxLength);
    const v = verifyPreviewToken({ current: SECRET }, token, at(60));
    expect(v.ok && v.claims.lid).toBe(LID);
  });
  it('a token without an id is still valid (links made before S8b)', () => {
    const v = verifyPreviewToken({ current: SECRET }, mint(), at(60));
    expect(v.ok && v.claims.lid).toBeUndefined();
  });
  it('refuses to mint with a malformed id', () => {
    expect(() => mint({ linkId: 'not-a-uuid' })).toThrow(/linkId/);
    expect(() => mint({ linkId: LID.toUpperCase() })).toThrow(/linkId/);
  });
  it('a validly signed token with a malformed or non-string id is refused (closed claims)', () => {
    const base = { tpl: TPL, iat: T0.getTime() / 1000, exp: T0.getTime() / 1000 + 3600 };
    for (const lid of ['x', 5, null, ['a']]) {
      expect(verifyPreviewToken({ current: SECRET }, forge({ ...base, lid }), at(60))).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('prospect city and canonical encoding (P2 S10)', () => {
  it('round-trips the city and refuses markup or over-long cities', () => {
    const v = verifyPreviewToken({ current: SECRET }, mint({ prospectCity: '  Indore ' }), at(60));
    expect(v.ok && v.claims.city).toBe('Indore');
    expect(() => mint({ prospectCity: '<b>x</b>' })).toThrow(/city/);
    expect(() => mint({ prospectCity: 'x'.repeat(41) })).toThrow(/city/);
    const base = { tpl: TPL, iat: T0.getTime() / 1000, exp: T0.getTime() / 1000 + 3600 };
    expect(verifyPreviewToken({ current: SECRET }, forge({ ...base, city: 7 }), at(60)).ok).toBe(false);
  });
  it('a different spelling of the same signature bytes (the spare bits of the last character) is refused', () => {
    const token = mint();
    const last = token.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = alphabet.indexOf(last);
    // Same top bits, different spare bits: decodes to identical bytes.
    const sibling = alphabet[(i & ~3) | ((i + 1) & 3)]!;
    const variant = token.slice(0, -1) + sibling;
    expect(Buffer.from(variant.split('.')[2]!, 'base64url')).toEqual(
      Buffer.from(token.split('.')[2]!, 'base64url'),
    );
    expect(verifyPreviewToken({ current: SECRET }, token, at(60)).ok).toBe(true);
    expect(verifyPreviewToken({ current: SECRET }, variant, at(60))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
