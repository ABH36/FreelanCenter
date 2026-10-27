/**
 * Product auth (ADR-006): Better Auth 1.7.12 on the `identity` schema through the `app_auth` role.
 *
 * Every setting in the ADR-006 "mandatory configuration" table is pinned here and asserted by
 * `test/integration/config.test.ts`; Spike F found two unsafe library defaults (F-1, F-2) that were only visible
 * by testing, so a Better Auth upgrade must re-run the product suite before merge.
 *
 * Plugins are imported by subpath only (Spike F F-8: the barrel takes minutes to load).
 */
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from 'better-auth/api';
import { captcha } from 'better-auth/plugins/captcha';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { uuidv7 } from '@platform/db';
import { getCorrelationIdFromHeaders, getLogContext, type Logger } from '@platform/logger';
import type { EmailProvider } from '@platform/providers';
import { type AuditWriter, type AuthAuditEvent, type RawQueryClient, createAuditWriter } from './audit';
import type { AuthConfig } from './config';
import { type Defer, createAuthMailer, inlineDefer } from './mail';

/** The `app_auth` Prisma client (`createAuthPrismaClient` from @platform/db). */
export type AuthPrismaClient = Parameters<typeof prismaAdapter>[0] &
  RawQueryClient & {
    user: {
      findUnique(args: {
        where: { id: string };
        select: { status: true };
      }): Promise<{ status: string } | null>;
    };
  };

export interface AuthDeps {
  config: AuthConfig;
  prisma: AuthPrismaClient;
  email: EmailProvider;
  logger?: Logger;
  /** Runs mail delivery after the response (Next `after`). Default: fire-and-forget in-process. */
  defer?: Defer;
  /** Test hook: replace the audit writer (default writes `app.audit_logs` through the definer function). */
  audit?: AuditWriter;
  /** Test hook: point Turnstile verification somewhere else. Never set in an app. */
  turnstileSiteVerifyUrl?: string;
}

/** Explicit limits (Spike F F-6). Windows in seconds; counters persist in `identity.rate_limits`. */
export const RATE_LIMIT_RULES = {
  '/sign-in/email': { window: 60, max: 5 },
  '/sign-up/email': { window: 60, max: 5 },
  '/request-password-reset': { window: 60, max: 3 },
  '/reset-password': { window: 60, max: 5 },
  '/send-verification-email': { window: 60, max: 3 },
  '/verify-email': { window: 60, max: 10 },
  '/change-password': { window: 60, max: 5 },
  '/two-factor/*': { window: 60, max: 10 },
  '/sign-in/social': { window: 60, max: 10 },
} as const;

/** Endpoints that need a Turnstile token in `x-captcha-response` (SEC-09: abuse-resistant sign-up). */
export const CAPTCHA_ENDPOINTS = ['/sign-up/email', '/request-password-reset', '/send-verification-email'];

export const SESSION_POLICY = {
  expiresIn: 60 * 60 * 24 * 7,
  updateAge: 60 * 60 * 24,
  /** Sensitive actions (enable/disable MFA, change password) need a session younger than this. */
  freshAge: 60 * 10,
} as const;

export const TOTP_LOCKOUT = { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 } as const;

const MFA_VERIFY_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

type HookContext = {
  path?: string;
  headers?: Headers;
  request?: Request;
  context: { returned?: unknown; session?: { user: { id: string } } | null; options: object };
} | null;

export function createAuth(deps: AuthDeps) {
  const { config, prisma, logger } = deps;
  const audit = deps.audit ?? createAuditWriter(prisma, logger);
  const sendMail = createAuthMailer({
    provider: deps.email,
    appName: config.appName,
    defer: deps.defer ?? inlineDefer,
    logger,
  });

  function requestMeta(ctx: HookContext): Pick<AuthAuditEvent, 'ip' | 'userAgent' | 'correlationId'> {
    const headers = ctx?.headers ?? ctx?.request?.headers;
    return {
      ip: headers && ctx ? getIP(headers, ctx.context.options as Parameters<typeof getIP>[1]) : null,
      userAgent: headers?.get('user-agent') ?? null,
      correlationId:
        getLogContext()?.correlationId ?? (headers ? getCorrelationIdFromHeaders(headers) : null),
    };
  }

  return betterAuth({
    appName: config.appName,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 15 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url, token }) =>
        sendMail({ kind: 'auth.reset_password', to: user.email, name: user.name, url, token }),
      onPasswordReset: async ({ user }) => {
        await audit.record({
          action: 'auth.password.reset',
          result: 'success',
          actorUserId: user.id,
          targetId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      // Stateless JWT, not single-use (Spike F F-4): keep it short.
      expiresIn: 60 * 60,
      sendVerificationEmail: ({ user, url, token }) =>
        sendMail({ kind: 'auth.verify_email', to: user.email, name: user.name, url, token }),
    },
    socialProviders: config.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            prompt: 'select_account',
          },
        }
      : {},
    // F-1: reset tokens and OAuth state are hashed at rest (library default is plain text).
    verification: { storeIdentifier: 'hashed' },
    account: {
      // F-10: provider tokens encrypted at rest.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // A pre-registered, unverified password account at someone's address never absorbs their Google login.
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        trustedProviders: ['google'],
      },
    },
    session: { ...SESSION_POLICY },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { ...RATE_LIMIT_RULES },
    },
    advanced: {
      // F-2: Better Auth turns origin/CSRF checks off when it detects a test runner. Never.
      disableOriginCheck: false,
      // F-5: only the deployment's trusted header identifies the client.
      ipAddress: { ipAddressHeaders: [config.clientIpHeader] },
      database: { generateId: () => uuidv7() },
      useSecureCookies: config.baseURL.startsWith('https://'),
    },
    plugins: [
      twoFactor({ issuer: config.appName, accountLockout: { ...TOTP_LOCKOUT } }),
      captcha({
        provider: 'cloudflare-turnstile',
        secretKey: config.turnstileSecretKey,
        endpoints: CAPTCHA_ENDPOINTS,
        siteVerifyURLOverride: deps.turnstileSiteVerifyUrl,
      }),
    ],
    hooks: {
      // S8-1: with a signed-in session, Better Auth 1.7.12's verify-totp / verify-backup-code have no lockout and
      // no attempt limit (only the 10/min rate limit), so for a user who already has 2FA they would be an
      // online oracle for the current code, which also unlocks the admin console's step-up. Over HTTP they
      // only serve enrolment (session, 2FA not yet on) and the sign-in challenge (no session). The admin
      // step-up calls `auth.api.verifyTOTP` server-side (no request object) behind its own database lockout.
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.request || !MFA_VERIFY_PATHS.has(ctx.path ?? '')) return;
        const session = await getSessionFromCtx(ctx);
        if (
          session?.user &&
          (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true
        ) {
          throw new APIError('FORBIDDEN', {
            message: 'Two-factor authentication is already enabled',
            code: 'TWO_FACTOR_ALREADY_ENABLED',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        const actor = ctx.context.session?.user.id ?? null;
        const meta = requestMeta(ctx as unknown as HookContext);
        const code = failed ? ((ctx.context.returned as APIError).body?.code ?? 'UNKNOWN') : null;
        switch (ctx.path) {
          case '/sign-in/email':
            if (failed) {
              // No actor and no e-mail: recording who was targeted would make the audit log an oracle.
              await audit.record({
                action: 'auth.sign_in.failed',
                result: 'failure',
                metadata: { code },
                ...meta,
              });
            }
            break;
          case '/two-factor/verify-totp':
          case '/two-factor/verify-backup-code':
            if (failed) {
              await audit.record({
                action: 'auth.mfa.challenge_failed',
                result: 'failure',
                actorUserId: actor,
                metadata: { code, method: ctx.path.endsWith('totp') ? 'totp' : 'backup_code' },
                ...meta,
              });
            }
            break;
          case '/revoke-sessions':
            if (!failed && actor) {
              await audit.record({
                action: 'auth.sessions.revoked_all',
                result: 'success',
                actorUserId: actor,
                targetId: actor,
                ...meta,
              });
            }
            break;
          case '/request-password-reset':
            await audit.record({
              action: 'auth.password.reset_requested',
              result: failed ? 'failure' : 'success',
              metadata: { code },
              ...meta,
            });
            break;
          case '/change-password':
            if (!failed && actor) {
              await audit.record({
                action: 'auth.password.changed',
                result: 'success',
                actorUserId: actor,
                targetId: actor,
                ...meta,
              });
            }
            break;
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            await audit.record({
              action: 'auth.user.created',
              result: 'success',
              actorUserId: user.id,
              targetId: user.id,
              metadata: { method: ctx?.path?.startsWith('/callback') ? 'oauth' : 'email' },
              ...requestMeta(ctx as unknown as HookContext),
            });
          },
        },
        update: {
          after: async (user, ctx) => {
            const path = ctx?.path ?? '';
            const meta = requestMeta(ctx as unknown as HookContext);
            if (path === '/verify-email' && user.emailVerified) {
              await audit.record({
                action: 'auth.email.verified',
                result: 'success',
                actorUserId: user.id,
                targetId: user.id,
                ...meta,
              });
            } else if (MFA_VERIFY_PATHS.has(path) && user.twoFactorEnabled) {
              await audit.record({
                action: 'auth.mfa.enabled',
                result: 'success',
                actorUserId: user.id,
                targetId: user.id,
                ...meta,
              });
            } else if (path === '/two-factor/disable') {
              await audit.record({
                action: 'auth.mfa.disabled',
                result: 'success',
                actorUserId: user.id,
                targetId: user.id,
                ...meta,
              });
            }
          },
        },
      },
      account: {
        // S4-6: `encryptOAuthTokens` encrypts access/refresh tokens but Better Auth 1.7.12 stores the provider
        // `id_token` (a signed JWT with e-mail and name) in plain text. The product never reads it after the
        // callback, so it is never persisted.
        create: {
          before: async (account) => ({ data: { ...account, idToken: null } }),
          after: async (account, ctx) => {
            if (account.providerId === 'credential') return;
            await audit.record({
              action: 'auth.oauth.linked',
              result: 'success',
              actorUserId: account.userId,
              targetId: account.userId,
              metadata: { provider: account.providerId },
              ...requestMeta(ctx as unknown as HookContext),
            });
          },
        },
        update: {
          before: async (account) =>
            'idToken' in account ? { data: { ...account, idToken: null } } : undefined,
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // Suspended or deactivated people cannot start a session (FR-ADM-02 user suspension, SRS 6.1).
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (user?.status !== 'active') {
              await audit.record({
                action: 'auth.sign_in.blocked',
                result: 'denied',
                actorUserId: session.userId,
                targetId: session.userId,
                metadata: { status: user?.status ?? 'missing' },
                ...requestMeta(ctx as unknown as HookContext),
              });
              throw new APIError('FORBIDDEN', {
                message: 'Account is not active',
                code: 'ACCOUNT_NOT_ACTIVE',
              });
            }
          },
          after: async (session, ctx) => {
            await audit.record({
              action: 'auth.session.created',
              result: 'success',
              actorUserId: session.userId,
              targetType: 'session',
              targetId: session.id,
              ...requestMeta(ctx as unknown as HookContext),
              ip: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
            });
          },
        },
        delete: {
          after: async (session, ctx) => {
            await audit.record({
              action: 'auth.session.revoked',
              result: 'success',
              actorUserId: session.userId,
              targetType: 'session',
              targetId: session.id,
              ...requestMeta(ctx as unknown as HookContext),
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
