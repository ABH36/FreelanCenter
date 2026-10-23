/**
 * ADR-006 mandatory configuration, asserted on the options the product actually builds (not on a copy).
 * A change to any of these values must fail here first.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { assertConnectionRole } from '@platform/db';
import { admin, authPrisma, makeAuth } from '../harness';

afterAll(async () => {
  await authPrisma.$disconnect();
  await admin.end();
});

describe('ADR-006 mandatory configuration', () => {
  const { auth } = makeAuth();
  const o = auth.options;

  it('Better Auth is the exact version Spike F verified', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../node_modules/better-auth/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('1.7.12');
  });

  it('pins every setting from the ADR-006 table', () => {
    expect(o.verification?.storeIdentifier).toBe('hashed'); // F-1
    expect(o.advanced?.disableOriginCheck).toBe(false); // F-2
    expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-vercel-forwarded-for']); // F-5
    expect(o.rateLimit?.enabled).toBe(true);
    expect(o.rateLimit?.storage).toBe('database');
    expect(o.rateLimit?.customRules?.['/sign-in/email']).toEqual({ window: 60, max: 5 }); // F-6
    expect(o.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(o.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(o.account?.encryptOAuthTokens).toBe(true); // F-10
    expect(o.account?.accountLinking?.requireLocalEmailVerified).toBe(true);
    expect(o.telemetry?.enabled).toBe(false);
    expect(o.emailVerification?.expiresIn).toBe(3600); // F-4
  });

  it('the two-factor lockout is explicit (F-6)', () => {
    const tf = o.plugins?.find((p) => p.id === 'two-factor') as
      { options?: { accountLockout?: unknown } } | undefined;
    expect(tf?.options?.accountLockout).toEqual({
      enabled: true,
      maxFailedAttempts: 5,
      durationSeconds: 900,
    });
  });

  it('Turnstile guards sign-up, password reset and verification resend (SEC-09)', () => {
    const cap = o.plugins?.find((p) => p.id === 'captcha') as
      { options?: { provider: string; endpoints: string[] } } | undefined;
    expect(cap?.options?.provider).toBe('cloudflare-turnstile');
    expect(cap?.options?.endpoints).toEqual([
      '/sign-up/email',
      '/request-password-reset',
      '/send-verification-email',
    ]);
  });

  it('the auth client connects as app_auth, which is neither superuser nor BYPASSRLS', async () => {
    await expect(assertConnectionRole(authPrisma, 'app_auth')).resolves.toBeUndefined();
  });
});
