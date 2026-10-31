import { describe, expect, it } from 'vitest';
import { createCaptureProvider } from '@platform/providers';
import { AuthConfigError, TURNSTILE_TEST_KEYS, loadAuthConfig } from './config';
import {
  AuthRequiredError,
  FreshSessionRequiredError,
  MfaRequiredError,
  requireMfa,
  requireSession,
} from './guards';
import { createAuthMailer, renderAuthMail } from './mail';

const base = {
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretPass,
};

describe('loadAuthConfig', () => {
  it('local defaults: capture mail, x-forwarded-for, no Google', () => {
    const c = loadAuthConfig(base);
    expect(c).toMatchObject({
      baseURL: 'http://localhost:3000',
      clientIpHeader: 'x-forwarded-for',
      google: null,
      email: { transport: 'capture' },
    });
  });

  it('on Vercel the client IP header defaults to x-vercel-forwarded-for', () => {
    expect(loadAuthConfig({ ...base, VERCEL: '1' }).clientIpHeader).toBe('x-vercel-forwarded-for');
  });

  it.each([
    [{ BETTER_AUTH_URL: undefined }, /BETTER_AUTH_URL is not set/],
    [{ BETTER_AUTH_URL: 'not a url' }, /not a valid URL/],
    [{ BETTER_AUTH_URL: 'https://app.example.com/dash' }, /without a path/],
    [{ BETTER_AUTH_URL: 'http://app.example.com' }, /https/],
    [{ BETTER_AUTH_SECRET: 'short' }, /at least 32/],
    [{ TURNSTILE_SECRET_KEY: '' }, /TURNSTILE_SECRET_KEY/],
    [{ GOOGLE_CLIENT_ID: 'only-id' }, /set together/],
    [{ EMAIL_TRANSPORT: 'smtp' }, /resend or capture/],
    [{ EMAIL_TRANSPORT: 'resend' }, /EMAIL_PROVIDER_API_KEY/],
  ])('rejects %o', (patch, message) => {
    expect(() => loadAuthConfig({ ...base, ...patch })).toThrow(message);
  });

  it('production refuses capture mail and the Turnstile test secret', () => {
    const prod = {
      ...base,
      BETTER_AUTH_URL: 'https://app.example.com',
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
    };
    expect(() => loadAuthConfig(prod)).toThrow(AuthConfigError);
    expect(() => loadAuthConfig({ ...prod, EMAIL_PROVIDER_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' })).toThrow(
      /test secret/,
    );
    const ok = loadAuthConfig({
      ...prod,
      EMAIL_PROVIDER_API_KEY: 're_x',
      EMAIL_FROM: 'Platform <no-reply@mail.example.com>',
      TURNSTILE_SECRET_KEY: '0x4AAAAAAA-real',
    });
    expect(ok.email.transport).toBe('resend');
  });

  it('Google needs both id and secret', () => {
    const c = loadAuthConfig({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(c.google).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });
});

const session = (
  overrides: { twoFactorEnabled?: boolean; emailVerified?: boolean; createdAt?: Date } = {},
) => ({
  user: {
    id: '0192f000-0000-7000-8000-000000000001',
    email: 'a@example.test',
    name: 'A',
    emailVerified: overrides.emailVerified ?? true,
    twoFactorEnabled: overrides.twoFactorEnabled ?? false,
  },
  session: { id: 's', createdAt: overrides.createdAt ?? new Date(), expiresAt: new Date(Date.now() + 1e6) },
});

describe('guards', () => {
  it('requireSession refuses no session and unverified users', () => {
    expect(() => requireSession(null)).toThrow(AuthRequiredError);
    expect(() => requireSession(session({ emailVerified: false }))).toThrow(AuthRequiredError);
    expect(requireSession(session()).user.id).toBeTruthy();
  });

  it('requireMfa refuses users without TOTP and stale sessions when asked', () => {
    expect(() => requireMfa(session())).toThrow(MfaRequiredError);
    expect(requireMfa(session({ twoFactorEnabled: true })).user.twoFactorEnabled).toBe(true);
    const old = session({ twoFactorEnabled: true, createdAt: new Date(Date.now() - 20 * 60_000) });
    expect(() => requireMfa(old, { maxAgeSeconds: 600 })).toThrow(FreshSessionRequiredError);
    expect(requireMfa(old, { maxAgeSeconds: 3600 })).toBe(old);
  });
});

describe('auth mail', () => {
  const mail = {
    kind: 'auth.verify_email' as const,
    to: 'a@example.test',
    name: '<b>Eve</b>',
    url: 'http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F',
    token: 'abc',
  };

  it('escapes the name in HTML and includes the link in both parts', () => {
    const r = renderAuthMail(mail, 'Platform');
    expect(r.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(r.html).toContain('token=abc&amp;callbackURL');
    expect(r.text).toContain(mail.url);
    expect(r.subject).toBe('Verify your email address - Platform');
  });

  it('defers delivery, derives a stable idempotency key and never throws on provider failure', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const sink = createCaptureProvider();
    const send = createAuthMailer({ provider: sink, appName: 'P', defer: (t) => void tasks.push(t) });
    await send(mail);
    expect(sink.sent).toHaveLength(0);
    await Promise.all(tasks.map((t) => t()));
    await Promise.all(tasks.map((t) => t()));
    expect(sink.sent[0]!.idempotencyKey).toBe(sink.sent[1]!.idempotencyKey);

    const errors: unknown[] = [];
    const failing = createAuthMailer({
      provider: { name: 'x', send: () => Promise.reject(new Error('down')) },
      appName: 'P',
      defer: (t) => void tasks.push(t),
      logger: { error: (_m: string, e: unknown) => errors.push(e) } as never,
    });
    tasks.length = 0;
    await failing(mail);
    await Promise.all(tasks.map((t) => t()));
    expect(errors).toHaveLength(1);
  });
});

describe('sign-in challenge helpers (DG-22)', () => {
  const base = 'https://app.example.test';

  it('only the paths that bypass the plugin hook are matched', async () => {
    const { createsSessionOutsidePluginHook: matches } = await import('./sign-in-challenge');
    expect(['/callback/:id', '/callback/google', '/sign-in/social', '/verify-email'].every(matches)).toBe(
      true,
    );
    expect(
      ['/sign-in/email', '/two-factor/verify-totp', '/get-session', '/sign-up/email', undefined].some(
        matches,
      ),
    ).toBe(false);
  });

  it('safeReturnTo keeps same-origin paths and sends everything else home', async () => {
    const { safeReturnTo } = await import('./sign-in-challenge');
    expect(safeReturnTo(`${base}/w/acme?tab=sites`, base)).toBe('/w/acme?tab=sites');
    expect(safeReturnTo('/after', base)).toBe('/after');
    expect(safeReturnTo('https://evil.example/x', base)).toBe('/');
    expect(safeReturnTo('//evil.example/x', base)).toBe('/');
    expect(safeReturnTo('/two-factor?callbackURL=/', base)).toBe('/');
    expect(safeReturnTo(null, base)).toBe('/');
    expect(safeReturnTo('http://[bad', base)).toBe('/');
  });
});
