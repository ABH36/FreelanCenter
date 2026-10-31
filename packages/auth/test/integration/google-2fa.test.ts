/**
 * DG-22 (S8-2), part of the product auth suite: a user with 2FA on gets a TOTP challenge after Google (callback and
 * ID-token sign-in) and after the e-mail-verification auto sign-in, with no session until a valid code. Google is
 * faked at the network edge: its token endpoint and JWKS are answered by a stub `fetch`, and the ID tokens are
 * signed with a throw-away key generated here (nothing secret is committed).
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  ORIGIN,
  PASSWORD,
  RUN,
  admin,
  auditRows,
  authPrisma,
  email,
  lastLink,
  makeAuth,
  q,
} from '../harness';
import { secretFromUri, totp } from '../totp';

const { auth, mail, flush } = makeAuth();
const browser = () => new Browser(auth);

const GOOGLE_AUDIENCE = 'suite-fake-client.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = `suite-${RUN}`;
const realFetch = globalThis.fetch;
/** The Google profile the next token exchange returns. */
let profile = { sub: '', email: '', name: 'Google Suite' };

function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = part({ alg: 'RS256', typ: 'JWT', kid: KID });
  const now = Math.floor(Date.now() / 1000);
  const body = part({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_AUDIENCE,
    iat: now,
    exp: now + 600,
    email_verified: true,
    ...claims,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const profileToken = () => jwt({ sub: profile.sub, email: profile.email, name: profile.name });

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'suite-access',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
        id_token: profileToken(),
      });
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs'))
      return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' }] });
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await authPrisma.$disconnect();
  await admin.end();
});

/** Sign up and verify through the real mailed link. */
async function verifiedUser(address: string): Promise<{ b: Browser; id: string }> {
  const b = browser();
  const r = await b.req('/sign-up/email', {
    body: { email: address, password: PASSWORD, name: 'Suite User' },
  });
  expect(r.status).toBe(200);
  await flush();
  const v = await b.req('/verify-email', {
    method: 'GET',
    query: { token: lastLink(mail, 'auth.verify_email', address).token },
  });
  expect(v.status).toBe(200);
  const [u] = await q<{ id: string }>('SELECT id FROM identity.users WHERE email = $1', [address]);
  return { b, id: u!.id };
}

/** A verified user with TOTP on; returns the secret and the backup codes. */
async function userWith2fa(label: string) {
  const address = email(label);
  const { b, id } = await verifiedUser(address);
  const enable = await b.req('/two-factor/enable', { body: { password: PASSWORD } });
  const { totpURI, backupCodes } = enable.json as { totpURI: string; backupCodes: string[] };
  const secret = secretFromUri(totpURI);
  expect((await b.req('/two-factor/verify-totp', { body: { code: totp(secret) } })).status).toBe(200);
  return { address, id, secret, backupCodes };
}

/** A full Google round trip up to the callback response. */
async function googleCallback(b: Browser, address: string, callbackURL = '/') {
  profile = { sub: `google-${RUN}-${address}`, email: address, name: 'Google Suite' };
  const start = await b.req('/sign-in/social', { body: { provider: 'google', callbackURL } });
  const state = new URL((start.json as { url: string }).url).searchParams.get('state')!;
  return b.req('/callback/google', { method: 'GET', query: { code: 'suite-code', state } });
}

const sessionCount = async (id: string) =>
  Number(
    (await q<{ n: string }>('SELECT count(*) AS n FROM identity.sessions WHERE user_id = $1', [id]))[0]!.n,
  );
const liveSessionCookies = (r: { setCookies: string[] }) =>
  r.setCookies.filter((c) => /session_token=[^;]+/.test(c) && !/max-age=0/i.test(c));
const hasChallengeCookie = (b: Browser) => [...b.cookies.keys()].some((k) => k.endsWith('two_factor'));

describe('11. 2FA challenge on Google and auto sign-in (DG-22, FR-AUTH-03)', () => {
  let user: Awaited<ReturnType<typeof userWith2fa>>;
  beforeAll(async () => {
    user = await userWith2fa('google-2fa');
  });

  it('Google callback for a 2FA user: redirect to the challenge page, no session cookie, no session row', async () => {
    const before = await sessionCount(user.id);
    const c = browser();
    const r = await googleCallback(c, user.address, '/w/acme?tab=sites');
    expect(r.status).toBe(302);
    const location = new URL(r.headers.get('location')!, ORIGIN);
    expect(location.pathname).toBe('/two-factor');
    expect(location.searchParams.get('callbackURL')).toBe('/w/acme?tab=sites');
    expect(liveSessionCookies(r)).toHaveLength(0);
    expect(c.sessionCookieName()).toBeUndefined();
    expect(hasChallengeCookie(c)).toBe(true);
    expect(await sessionCount(user.id)).toBe(before);
    expect((await c.req('/get-session', { method: 'GET' })).json).toBeNull();
    const issued = auditRows({ actorId: user.id, action: 'auth.mfa.challenge_issued' });
    expect(issued.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(issued)).not.toContain(user.address);
  });

  it('a valid code completes the Google challenge and only then is there a session', async () => {
    const c = browser();
    await googleCallback(c, user.address);
    const ok = await c.req('/two-factor/verify-totp', { body: { code: totp(user.secret) } });
    expect(ok.status).toBe(200);
    expect(c.sessionCookieName()).toBeDefined();
    const me = (await c.req('/get-session', { method: 'GET' })).json as { user?: { id: string } } | null;
    expect(me?.user?.id).toBe(user.id);
    // The challenge cookie is gone: the same request from a browser without one gets nothing.
    const bare = browser();
    expect(
      (await bare.req('/two-factor/verify-totp', { body: { code: totp(user.secret) } })).status,
    ).not.toBe(200);
    expect(bare.sessionCookieName()).toBeUndefined();
  });

  it('S8-1 stays closed: a signed-in 2FA session is still refused over HTTP', async () => {
    const c = browser();
    await googleCallback(c, user.address);
    await c.req('/two-factor/verify-totp', { body: { code: totp(user.secret) } });
    expect((await c.req('/two-factor/verify-totp', { body: { code: totp(user.secret) } })).status).toBe(403);
    expect((await c.req('/two-factor/verify-backup-code', { body: { code: 'aaaaa-bbbbb' } })).status).toBe(
      403,
    );
  });

  it('wrong codes after Google are audited, five lock the factor, and a correct code is then refused', async () => {
    const locked = await userWith2fa('google-lock');
    const failuresBefore = auditRows({ actorId: locked.id, action: 'auth.mfa.challenge_failed' }).length;
    const c = browser();
    await googleCallback(c, locked.address);
    for (let i = 0; i < 5; i++) {
      expect((await c.req('/two-factor/verify-totp', { body: { code: '000000' } })).status).not.toBe(200);
    }
    expect(auditRows({ actorId: locked.id, action: 'auth.mfa.challenge_failed' }).length).toBe(
      failuresBefore + 5,
    );
    expect((await c.req('/two-factor/verify-totp', { body: { code: totp(locked.secret) } })).status).not.toBe(
      200,
    );
    expect(c.sessionCookieName()).toBeUndefined();
    // A fresh Google sign-in does not reset the lock.
    const again = browser();
    await googleCallback(again, locked.address);
    expect(
      (await again.req('/two-factor/verify-totp', { body: { code: totp(locked.secret) } })).status,
    ).not.toBe(200);
    expect(again.sessionCookieName()).toBeUndefined();
  });

  it('a backup code completes the challenge once and cannot be reused', async () => {
    const withCodes = await userWith2fa('google-backup');
    const code = withCodes.backupCodes[0]!;
    const c = browser();
    await googleCallback(c, withCodes.address);
    expect((await c.req('/two-factor/verify-backup-code', { body: { code } })).status).toBe(200);
    expect(c.sessionCookieName()).toBeDefined();
    const again = browser();
    await googleCallback(again, withCodes.address);
    expect((await again.req('/two-factor/verify-backup-code', { body: { code } })).status).not.toBe(200);
    expect(again.sessionCookieName()).toBeUndefined();
  });

  it('a user with 2FA off signs in with Google as before: callbackURL, session, no challenge; linking works', async () => {
    const plain = email('google-plain');
    const { id } = await verifiedUser(plain);
    const c = browser();
    const r = await googleCallback(c, plain, '/after');
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location')!, ORIGIN).pathname).toBe('/after');
    expect(liveSessionCookies(r)).toHaveLength(1);
    expect(hasChallengeCookie(c)).toBe(false);
    const [account] = await q<{ id_token: string | null }>(
      "SELECT id_token FROM identity.accounts WHERE user_id = $1 AND provider_id = 'google'",
      [id],
    );
    expect(account).toBeDefined();
    expect(account!.id_token).toBeNull(); // S4-6 still holds
    // A brand-new Google user (no password account) is created and signed in.
    const f = await googleCallback(browser(), email('google-new'));
    expect(new URL(f.headers.get('location')!, ORIGIN).pathname).toBe('/');
    expect(liveSessionCookies(f)).toHaveLength(1);
  });

  it('the ID-token form of /sign-in/social is challenged too (JSON twoFactorRedirect, no session)', async () => {
    const c = browser();
    profile = { sub: `google-${RUN}-${user.address}`, email: user.address, name: 'Google Suite' };
    const r = await c.req('/sign-in/social', {
      body: { provider: 'google', idToken: { token: profileToken() } },
    });
    expect(r.status).toBe(200);
    expect((r.json as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(liveSessionCookies(r)).toHaveLength(0);
    expect(c.sessionCookieName()).toBeUndefined();
    expect((await c.req('/two-factor/verify-totp', { body: { code: totp(user.secret) } })).status).toBe(200);
    expect(c.sessionCookieName()).toBeDefined();
  });

  it('the e-mail-verification auto sign-in is challenged for a 2FA user (JSON and redirect forms)', async () => {
    const mfa = await userWith2fa('verify-2fa');
    for (const withCallback of [false, true]) {
      await q('UPDATE identity.users SET email_verified = false WHERE id = $1', [mfa.id]);
      const c = browser();
      const blocked = await c.req('/sign-in/email', { body: { email: mfa.address, password: PASSWORD } });
      expect(blocked.status).toBe(403);
      await flush();
      const v = await c.req('/verify-email', {
        method: 'GET',
        query: {
          token: lastLink(mail, 'auth.verify_email', mfa.address).token,
          ...(withCallback ? { callbackURL: '/after-verify' } : {}),
        },
      });
      expect(liveSessionCookies(v)).toHaveLength(0);
      expect(c.sessionCookieName()).toBeUndefined();
      if (withCallback) {
        expect(v.status).toBe(302);
        const loc = new URL(v.headers.get('location')!, ORIGIN);
        expect(loc.pathname).toBe('/two-factor');
        expect(loc.searchParams.get('callbackURL')).toBe('/after-verify');
      } else {
        expect((v.json as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      }
      expect((await c.req('/two-factor/verify-totp', { body: { code: totp(mfa.secret) } })).status).toBe(200);
    }
  });
});
