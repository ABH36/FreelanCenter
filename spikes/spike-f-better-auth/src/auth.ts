/**
 * SPIKE F (DG-05) - Better Auth configured the way the product would need it (SRS 6.1, ADR-006).
 * Disposable: the real implementation lands in packages/auth (or apps/dashboard) after ADR-006 is accepted.
 */
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { PrismaClient } from './generated/client';

// Throwaway values for the local Docker stack only (allow-listed in .gitleaks.toml).
export const URL_SUPERUSER = 'postgresql://postgres:postgres@localhost:55433/spike_f'; // assertions only
export const URL_AUTH = 'postgresql://app_auth:auth_pw@localhost:56433/spike_f'; // via PgBouncer (transaction mode)
export const URL_APP = 'postgresql://app_user:app_pw@localhost:56433/spike_f'; // via PgBouncer (transaction mode)
export const TEST_SECRET = 'spike-f-local-only-secret-0123456789abcdefghijklmnop';

/** RFC 9562 UUID v7 (SRS 5.1: ids are uuid v7). */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Spike B finding B-3: pool size and transaction options are explicit, never Prisma defaults. */
export function makePrisma(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 10 }),
    transactionOptions: { maxWait: 20_000, timeout: 20_000 },
  });
}
export type Db = ReturnType<typeof makePrisma>;

export interface SentMail {
  kind: 'verify-email' | 'reset-password';
  to: string;
  url: string;
  token: string;
}

export interface AuditEvent {
  action: string;
  userId?: string;
  sessionId?: string;
}

export interface AuthDeps {
  prisma: Db;
  mail: SentMail[];
  audit: AuditEvent[];
  baseURL?: string;
  google?: { clientId: string; clientSecret: string };
}

export function makeAuth({ prisma, mail, audit, baseURL = 'http://localhost:3000', google }: AuthDeps) {
  return betterAuth({
    appName: 'Platform',
    baseURL,
    basePath: '/api/auth',
    secret: TEST_SECRET,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    // Outbound telemetry stays off (privacy inventory: no undeclared processors).
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        mail.push({ kind: 'reset-password', to: user.email, url, token });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url, token }) => {
        mail.push({ kind: 'verify-email', to: user.email, url, token });
      },
    },
    socialProviders: {
      google: google ?? {
        clientId: 'spike-f-fake-client.apps.googleusercontent.com',
        clientSecret: 'spike-f-fake-client-secret',
      },
    },
    // FR-AUTH-04 / SEC-11: single-use tokens are hashed at rest (Better Auth default is "plain").
    verification: { storeIdentifier: 'hashed' },
    // SEC-05: provider access/id tokens are encrypted at rest (default false stores them in plain text, F-10).
    account: { encryptOAuthTokens: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 30 },
      },
    },
    advanced: {
      // Better Auth defaults this to TRUE when it detects a test runner, which silently disables origin/CSRF
      // checks in every automated test. Pin it so tests exercise production behaviour (spike finding F-2).
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      database: { generateId: () => uuidv7() },
      useSecureCookies: baseURL.startsWith('https://'),
    },
    plugins: [
      twoFactor({
        issuer: 'Platform',
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
    ],
    // Audit integration point (FR-AUD-01): the product writes an AuditLog row here.
    databaseHooks: {
      user: {
        create: { after: async (user) => void audit.push({ action: 'auth.user.created', userId: user.id }) },
      },
      session: {
        create: {
          after: async (s) =>
            void audit.push({ action: 'auth.session.created', userId: s.userId, sessionId: s.id }),
        },
        delete: {
          after: async (s) =>
            void audit.push({ action: 'auth.session.revoked', userId: s.userId, sessionId: s.id }),
        },
      },
    },
  });
}
export type Auth = ReturnType<typeof makeAuth>;
