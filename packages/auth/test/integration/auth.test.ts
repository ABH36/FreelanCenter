/**
 * Product auth suite (P1 S4): the successor of Spike F's suite, run against the product configuration, the
 * product schema (`identity` + `app.audit_logs`) and the product audit/mail wiring. Each `describe` names the
 * SRS ids it evidences. CI runs this file repeatedly (Spike F open flake).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toNextJsHandler } from 'better-auth/next-js';
import { MfaRequiredError, requireMfa } from '../../src/guards';
import { TURNSTILE_TEST_KEYS } from '../../src/config';
import {
  Browser,
  IP_HEADER,
  ORIGIN,
  PASSWORD,
  admin,
  auditRows,
  authPrisma,
  email,
  lastLink,
  makeAuth,
  nextIp,
  q,
} from '../harness';
import { secretFromUri, totp } from '../totp';

const started = new Date(Date.now() - 1000);
const { auth, mail, flush } = makeAuth();
const browser = () => new Browser(auth);

afterAll(async () => {
  await authPrisma.$disconnect();
  await admin.end();
});

async function userId(address: string): Promise<string> {
  const [u] = await q<{ id: string }>('SELECT id FROM identity.users WHERE email = $1', [address]);
  if (!u) throw new Error(`no user ${address}`);
  return u.id;
}

/** Sign up and verify through the real mailed link; returns a signed-in browser. */
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
  expect(b.sessionCookieName()).toBeDefined();
  return { b, id: await userId(address) };
}

describe('1. sign-up with verified email and Turnstile (FR-AUTH-01, SEC-09)', () => {
  const address = email('alice');

  it('without a Turnstile token sign-up is refused and no user exists', async () => {
    const r = await browser().req('/sign-up/email', {
      body: { email: address, password: PASSWORD, name: 'Alice' },
      captcha: null,
    });
    expect(r.status).toBe(400);
    expect((r.json as { code?: string }).code).toBe('MISSING_RESPONSE');
    expect(await q('SELECT 1 FROM identity.users WHERE email = $1', [address])).toHaveLength(0);
  });

  it('a token Cloudflare rejects (official always-fail test secret) is refused', async () => {
    const failing = makeAuth({ turnstileSecretKey: TURNSTILE_TEST_KEYS.secretFail });
    const r = await new Browser(failing.auth).req('/sign-up/email', {
      body: { email: address, password: PASSWORD, name: 'Alice' },
    });
    expect(r.status).toBe(403);
    expect((r.json as { code?: string }).code).toBe('VERIFICATION_FAILED');
    expect(await q('SELECT 1 FROM identity.users WHERE email = $1', [address])).toHaveLength(0);
  });

  it('with a valid token: unverified user, no session, one verification mail, hashed password, UUID v7', async () => {
    const b = browser();
    const r = await b.req('/sign-up/email', { body: { email: address, password: PASSWORD, name: 'Alice' } });
    expect(r.status).toBe(200);
    expect(b.sessionCookieName()).toBeUndefined();
    await flush();
    const [u] = await q<{ id: string; email_verified: boolean; status: string; locale: string }>(
      'SELECT id, email_verified, status, locale FROM identity.users WHERE email = $1',
      [address],
    );
    expect(u).toMatchObject({ email_verified: false, status: 'active', locale: 'en' });
    expect(u!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mail.sent.filter((m) => m.kind === 'auth.verify_email' && m.to === address)).toHaveLength(1);
    const [acc] = await q<{ password: string }>(
      "SELECT password FROM identity.accounts WHERE user_id = $1 AND provider_id = 'credential'",
      [u!.id],
    );
    expect(acc!.password).not.toContain(PASSWORD);
  });

  it('sign-up with an already-registered email is indistinguishable from a new one', async () => {
    const again = await browser().req('/sign-up/email', {
      body: { email: address, password: PASSWORD, name: 'Mallory' },
    });
    const fresh = await browser().req('/sign-up/email', {
      body: { email: email('alice-fresh'), password: PASSWORD, name: 'Fresh' },
    });
    expect(again.status).toBe(fresh.status);
    expect(Object.keys(again.json as object).sort()).toEqual(Object.keys(fresh.json as object).sort());
  });

  it('sign-in before verification is refused and re-sends the verification mail', async () => {
    await flush();
    const before = mail.sent.length;
    const r = await browser().req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect(r.status).toBe(403);
    expect((r.json as { code?: string }).code).toBe('EMAIL_NOT_VERIFIED');
    await flush();
    expect(mail.sent.slice(before).map((m) => [m.kind, m.to])).toEqual([['auth.verify_email', address]]);
  });

  it('a tampered verification token is refused; the real link verifies and signs in', async () => {
    const { token, url } = lastLink(mail, 'auth.verify_email', address);
    expect(url.origin).toBe(ORIGIN);
    const bad = await browser().req('/verify-email', { method: 'GET', query: { token: `${token}x` } });
    expect(bad.status).toBe(401);
    const b = browser();
    const ok = await b.req('/verify-email', { method: 'GET', query: { token } });
    expect(ok.status).toBe(200);
    expect(b.sessionCookieName()).toBeDefined();
    const id = await userId(address);
    const actions = auditRows({ actorId: id }).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['auth.user.created', 'auth.email.verified', 'auth.session.created']),
    );
  });

  it('the mail is sent through the provider with an idempotency key and without the password', async () => {
    const m = mail.sent.find((x) => x.to === address)!;
    expect(m.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(m.text).not.toContain(PASSWORD);
    expect(m.subject).toContain('Verify');
  });
});

describe('2. sessions: cookies, rotation, fixation, log out all devices (FR-AUTH-02)', () => {
  const address = email('bob');
  let first: Browser;
  let id = '';

  beforeAll(async () => {
    ({ b: first, id } = await verifiedUser(address));
  });

  it('the session cookie is HttpOnly, SameSite=Lax, Path=/ and host-only', async () => {
    const r = await browser().req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    const cookie = r.setCookies.find((c) => /session_token=/.test(c))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('on an https origin the cookie is Secure and __Secure- prefixed', async () => {
    const https = makeAuth({ baseURL: 'https://app.example.test' });
    const b = new Browser(https.auth, nextIp(), 'https://app.example.test');
    const r = await b.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect(r.status).toBe(200);
    const cookie = r.setCookies.find((c) => /session_token=/.test(c))!;
    expect(cookie).toMatch(/^__Secure-/);
    expect(cookie).toMatch(/; Secure/i);
  });

  it('every sign-in issues a new token and a planted cookie is not adopted', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const b = browser();
      await b.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
      tokens.add(b.cookies.get(b.sessionCookieName()!)!);
    }
    expect(tokens.size).toBe(3);
    const victim = browser();
    victim.cookies.set('better-auth.session_token', 'attacker-chosen-value');
    await victim.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect(victim.cookies.get('better-auth.session_token')).not.toBe('attacker-chosen-value');
  });

  it('"log out all devices" revokes every session and is audited', async () => {
    const other = browser();
    await other.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect((await other.req('/get-session', { method: 'GET' })).json).not.toBeNull();
    const r = await first.req('/revoke-sessions', { body: {} });
    expect(r.status).toBe(200);
    expect((await other.req('/get-session', { method: 'GET' })).json).toBeNull();
    const [n] = await q<{ n: number }>('SELECT count(*)::int n FROM identity.sessions WHERE user_id = $1', [
      id,
    ]);
    expect(n!.n).toBe(0);
    const rows = auditRows({ actorId: id, action: 'auth.sessions.revoked_all' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip).toBe(first.ip);
  });
});

describe('3. generic failures and password reset (FR-AUTH-04, SEC-11)', () => {
  const address = email('carol');

  beforeAll(async () => {
    await verifiedUser(address);
  });

  it('wrong password and unknown account give identical responses; the failure is audited without the email', async () => {
    const wrong = await browser().req('/sign-in/email', {
      body: { email: address, password: 'wrong-password-123' },
    });
    const unknown = await browser().req('/sign-in/email', {
      body: { email: email('nobody'), password: 'wrong-password-123' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body).toBe(unknown.body);
    const failures = auditRows({ action: 'auth.sign_in.failed' });
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(
      failures.every((f) => f.actorUserId === undefined && !JSON.stringify(f.metadata).includes('@')),
    ).toBe(true);
  });

  it('reset request needs Turnstile, is identical for known/unknown emails and mails only the known one', async () => {
    const noCaptcha = await browser().req('/request-password-reset', {
      body: { email: address, redirectTo: '/reset-password' },
      captcha: null,
    });
    expect(noCaptcha.status).toBe(400);
    await flush();
    const before = mail.sent.length;
    const known = await browser().req('/request-password-reset', {
      body: { email: address, redirectTo: '/reset-password' },
    });
    const unknown = await browser().req('/request-password-reset', {
      body: { email: email('ghost'), redirectTo: '/reset-password' },
    });
    await flush();
    expect(known.status).toBe(200);
    expect(known.status).toBe(unknown.status);
    expect(known.body).toBe(unknown.body);
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual([address]);
  });

  it('the reset token is hashed at rest', async () => {
    const { token } = lastLink(mail, 'auth.reset_password', address);
    const rows = await q<{ identifier: string; value: string }>(
      'SELECT identifier, value FROM identity.verifications WHERE created_at >= $1',
      [started],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.identifier.includes(token) || r.value.includes(token))).toBe(false);
  });

  it('reset works once, revokes sessions and is audited; the token cannot be reused', async () => {
    const holder = browser();
    await holder.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    const { token } = lastLink(mail, 'auth.reset_password', address);
    const newPassword = 'new-correct-horse-2';
    expect((await browser().req('/reset-password', { body: { token, newPassword } })).status).toBe(200);
    expect((await holder.req('/get-session', { method: 'GET' })).json).toBeNull();
    expect(
      (await browser().req('/sign-in/email', { body: { email: address, password: PASSWORD } })).status,
    ).toBe(401);
    expect(
      (await browser().req('/sign-in/email', { body: { email: address, password: newPassword } })).status,
    ).toBe(200);
    expect(
      (await browser().req('/reset-password', { body: { token, newPassword: 'third-pass-333' } })).status,
    ).toBe(400);
    const id = await userId(address);
    expect(auditRows({ actorId: id, action: 'auth.password.reset' })).toHaveLength(1);
  });

  it('an expired reset token is refused', async () => {
    await browser().req('/request-password-reset', {
      body: { email: address, redirectTo: '/reset-password' },
    });
    await flush();
    const { token } = lastLink(mail, 'auth.reset_password', address);
    await q(
      "UPDATE identity.verifications SET expires_at = now() - interval '1 minute' WHERE created_at >= now() - interval '1 minute'",
    );
    const r = await browser().req('/reset-password', { body: { token, newPassword: 'expired-token-pw-4' } });
    expect(r.status).toBe(400);
  });
});

describe('4. TOTP enrolment, challenge, lockout and the requireMfa guard (FR-AUTH-03)', () => {
  const address = email('dave');
  let b: Browser;
  let id = '';
  let secret = '';

  beforeAll(async () => {
    ({ b, id } = await verifiedUser(address));
  });

  it('before enrolment the requireMfa guard refuses the session', async () => {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: b.cookieHeader() }) });
    expect(() => requireMfa(session)).toThrow(MfaRequiredError);
  });

  it('enable needs the password; secret and backup codes are encrypted at rest', async () => {
    expect((await b.req('/two-factor/enable', { body: { password: 'not-the-password-9' } })).status).toBe(
      400,
    );
    const r = await b.req('/two-factor/enable', { body: { password: PASSWORD } });
    expect(r.status).toBe(200);
    const body = r.json as { totpURI: string; backupCodes: string[] };
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\/Platform/);
    secret = secretFromUri(body.totpURI);
    const [row] = await q<{ secret: string; backup_codes: string }>(
      'SELECT secret, backup_codes FROM identity.two_factors WHERE user_id = $1',
      [id],
    );
    expect(row!.secret).not.toContain(secret);
    expect(body.backupCodes.some((c) => row!.backup_codes.includes(c))).toBe(false);
  });

  it('2FA activates only after a valid code; enrolment is audited and the guard then passes', async () => {
    const [u] = await q<{ two_factor_enabled: boolean }>(
      'SELECT two_factor_enabled FROM identity.users WHERE id = $1',
      [id],
    );
    expect(u!.two_factor_enabled).toBe(false);
    expect((await b.req('/two-factor/verify-totp', { body: { code: totp(secret) } })).status).toBe(200);
    const [v] = await q<{ two_factor_enabled: boolean }>(
      'SELECT two_factor_enabled FROM identity.users WHERE id = $1',
      [id],
    );
    expect(v!.two_factor_enabled).toBe(true);
    expect(auditRows({ actorId: id, action: 'auth.mfa.enabled' })).toHaveLength(1);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: b.cookieHeader() }) });
    expect(requireMfa(session).user.id).toBe(id);
  });

  it('password sign-in yields a challenge, not a session; a valid code completes it', async () => {
    const c = browser();
    const r = await c.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect(r.status).toBe(200);
    expect((r.json as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(c.sessionCookieName()).toBeUndefined();
    expect((await c.req('/two-factor/verify-totp', { body: { code: totp(secret) } })).status).toBe(200);
    expect(c.sessionCookieName()).toBeDefined();
  });

  it('five wrong codes lock the factor; a correct code is then refused; failures are audited', async () => {
    const c = browser();
    await c.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    for (let i = 0; i < 5; i++) await c.req('/two-factor/verify-totp', { body: { code: '000000' } });
    const locked = await c.req('/two-factor/verify-totp', { body: { code: totp(secret) } });
    expect(locked.status).not.toBe(200);
    expect(c.sessionCookieName()).toBeUndefined();
    const [row] = await q<{ locked_until: Date | null }>(
      'SELECT locked_until FROM identity.two_factors WHERE user_id = $1',
      [id],
    );
    expect(row!.locked_until).not.toBeNull();
    const failures = auditRows({ action: 'auth.mfa.challenge_failed' });
    expect(failures.length).toBeGreaterThanOrEqual(5);
  });
});

describe('5. rate limits keyed on the trusted client-IP header only (FR-AUTH-07, Spike F F-5)', () => {
  it('the 6th sign-in from one client IP gets 429; another client IP is unaffected', async () => {
    const attacker = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await attacker.req('/sign-in/email', { body: { email: email('eve'), password: 'guess-guess-123' } }))
          .status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    const other = await browser().req('/sign-in/email', {
      body: { email: email('eve'), password: 'guess-guess-123' },
    });
    expect(other.status).toBe(401);
  });

  it('rotating a client-settable X-Forwarded-For does not reset the limit', async () => {
    const attacker = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await attacker.req('/sign-in/email', {
        body: { email: email('eve2'), password: 'guess-guess-123' },
        headers: { 'x-forwarded-for': nextIp(), 'x-real-ip': nextIp() },
      });
      statuses.push(r.status);
    }
    expect(statuses[5]).toBe(429);
  });

  it('a request without the trusted header falls into the shared fail-closed bucket, not a fresh one', async () => {
    const noHeader = async () =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
          body: JSON.stringify({ email: email('eve3'), password: 'guess-guess-123' }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await noHeader()).status);
    expect(statuses).toContain(429);
  });
});

describe('6. Google OAuth start and callback validation (FR-AUTH-01)', () => {
  it('sign-in/social returns a Google authorization URL with state and PKCE S256 and the exact redirect URI', async () => {
    const r = await browser().req('/sign-in/social', { body: { provider: 'google', callbackURL: '/' } });
    expect(r.status).toBe(200);
    const u = new URL((r.json as { url: string }).url);
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(u.searchParams.get('prompt')).toBe('select_account');
  });

  it('a callback with a forged state is rejected and creates no user', async () => {
    const [before] = await q<{ n: number }>('SELECT count(*)::int n FROM identity.users');
    const b = browser();
    await b.req('/sign-in/social', { body: { provider: 'google', callbackURL: '/' } });
    const r = await b.req('/callback/google', {
      method: 'GET',
      query: { code: 'fake-code', state: 'forged-state' },
    });
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(r.headers.get('location') ?? '').toMatch(/error/i);
    const [after] = await q<{ n: number }>('SELECT count(*)::int n FROM identity.users');
    expect(after!.n).toBe(before!.n);
  });

  it('an off-origin callbackURL is refused (open redirect)', async () => {
    const r = await browser().req('/sign-in/social', {
      body: { provider: 'google', callbackURL: 'https://evil.example/x' },
    });
    expect(r.status).toBe(403);
  });
});

describe('7. CSRF/origin protection through the Next route handler (SEC-03, Spike F F-2)', () => {
  const address = email('frank');
  const { POST } = toNextJsHandler(auth);
  const signIn = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
    POST(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [IP_HEADER]: nextIp(), ...headers },
        body: JSON.stringify({ email: address, password: PASSWORD, ...body }),
      }),
    );

  beforeAll(async () => {
    await verifiedUser(address);
  });

  it('untrusted origins, cross-site navigations and off-origin callbacks are refused even under the test runner', async () => {
    const statuses = {
      untrustedOriginNoCookie: (await signIn({ origin: 'https://evil.example' })).status,
      untrustedOriginWithCookie: (await signIn({ origin: 'https://evil.example', cookie: 'x=1' })).status,
      crossSiteNavigation: (
        await signIn({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        })
      ).status,
      openRedirectCallback: (await signIn({ origin: ORIGIN }, { callbackURL: 'https://evil.example/x' }))
        .status,
      trustedOrigin: (await signIn({ origin: ORIGIN })).status,
    };
    expect(statuses).toEqual({
      untrustedOriginNoCookie: 403,
      untrustedOriginWithCookie: 403,
      crossSiteNavigation: 403,
      openRedirectCallback: 403,
      trustedOrigin: 200,
    });
  });
});

describe('8. suspended accounts cannot start a session (SRS 6.1, FR-ADM-02 user part)', () => {
  const address = email('grace');
  let id = '';

  beforeAll(async () => {
    ({ id } = await verifiedUser(address));
    await q("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [id]);
  });

  it('a correct password yields 403 ACCOUNT_NOT_ACTIVE, no session, and a denied audit row', async () => {
    const b = browser();
    const r = await b.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
    expect(r.status).toBe(403);
    expect((r.json as { code?: string }).code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(b.sessionCookieName()).toBeUndefined();
    const rows = auditRows({ actorId: id, action: 'auth.sign_in.blocked' });
    expect(rows.map((x) => x.result)).toEqual(['denied']);
  });
});

describe('9. audit trail quality (FR-AUD-01 auth)', () => {
  it('every auth audit row is a platform event that carries no e-mail address, token or password', async () => {
    await flush();
    const rows = auditRows();
    expect(rows.length).toBeGreaterThan(10);
    const tokens = mail.sent.map((m) =>
      /token=([^&\s]+)|reset-password\/([^?\s]+)/.exec(m.text)?.slice(1).find(Boolean),
    );
    for (const row of rows) {
      const blob = JSON.stringify(row.metadata ?? {});
      expect(blob).not.toContain('@');
      expect(blob).not.toContain(PASSWORD);
      for (const t of tokens) if (t) expect(blob).not.toContain(t);
    }
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      'auth.user.created',
      'auth.email.verified',
      'auth.session.created',
      'auth.session.revoked',
      'auth.sessions.revoked_all',
      'auth.sign_in.failed',
      'auth.password.reset_requested',
      'auth.password.reset',
      'auth.mfa.enabled',
      'auth.mfa.challenge_failed',
      'auth.sign_in.blocked',
    ]) {
      expect(actions, a).toContain(a);
    }
  });

  it('app_auth cannot read the audit log it writes (append-only through the definer function)', async () => {
    await expect(authPrisma.$queryRaw`SELECT 1 FROM app.audit_logs LIMIT 1`).rejects.toThrow();
  });
});

describe('10. concurrency through the transaction pooler', () => {
  it('30 concurrent sign-ins and 90 session reads: no errors, no cross-user sessions', async () => {
    const emails = [email('load0'), email('load1'), email('load2')];
    for (const e of emails) await verifiedUser(e);
    const signIns = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const address = emails[i % emails.length]!;
        const b = browser();
        const r = await b.req('/sign-in/email', { body: { email: address, password: PASSWORD } });
        return { r, b, address };
      }),
    );
    const reads = await Promise.all(
      Array.from({ length: 90 }, async (_, i) => {
        const s = signIns[i % signIns.length]!;
        const r = await s.b.req('/get-session', { method: 'GET' });
        return { expected: s.address, got: (r.json as { user?: { email: string } } | null)?.user?.email };
      }),
    );
    expect(signIns.filter((s) => s.r.status !== 200)).toHaveLength(0);
    expect(reads.filter((r) => r.expected !== r.got)).toHaveLength(0);
  });
});
