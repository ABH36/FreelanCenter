/**
 * Server-only auth singleton for the dashboard (ADR-006). Created lazily on the first request so `next build`
 * needs no secrets, and validated up front: a missing or unsafe setting fails the first request loudly.
 */
import 'server-only';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { cache } from 'react';
import { type Auth, type AuthPrismaClient, createAuth, loadAuthConfig } from '@platform/auth';
import { assertConnectionRole, assertUrlRole, createAuthPrismaClient } from '@platform/db';
import { createLogger } from '@platform/logger';
import {
  type CaptureEmailProvider,
  type EmailProvider,
  createCaptureProvider,
  createResendProvider,
} from '@platform/providers';

export const logger = createLogger({ app: 'dashboard' });

interface AuthRuntime {
  auth: Auth;
  /** Local development only: mail captured in memory and shown at /dev/mailbox. */
  mailbox: CaptureEmailProvider | null;
  ready: Promise<void>;
}

const globalForAuth = globalThis as unknown as { __platformAuth?: AuthRuntime };

function build(): AuthRuntime {
  const config = loadAuthConfig();
  const url = process.env.DATABASE_URL_AUTH;
  if (!url) throw new Error('DATABASE_URL_AUTH is not set');
  assertUrlRole('auth', url);
  const prisma = createAuthPrismaClient({ connectionString: url, poolMax: 5 });

  let email: EmailProvider;
  let mailbox: CaptureEmailProvider | null = null;
  if (config.email.transport === 'resend') {
    email = createResendProvider({ apiKey: config.email.apiKey, from: config.email.from });
  } else {
    mailbox = createCaptureProvider((m) =>
      logger.info('auth.mail.captured', { kind: m.kind, hint: 'open /dev/mailbox' }),
    );
    email = mailbox;
  }

  const auth = createAuth({
    config,
    prisma: prisma as unknown as AuthPrismaClient,
    email,
    logger,
    // Mail leaves after the response, so response time does not reveal whether an account exists.
    defer: (task) => after(task),
  });
  // One role check per process: the auth route must never run as a tenant, owner or BYPASSRLS role.
  const ready = assertConnectionRole(prisma, 'app_auth');
  ready.catch((error: unknown) => logger.fatal('auth.db.role_check_failed', error));
  return { auth, mailbox, ready };
}

export function authRuntime(): AuthRuntime {
  // Survives Next dev hot reloads, so the in-memory dev mailbox and DB pool are not recreated per edit.
  globalForAuth.__platformAuth ??= build();
  return globalForAuth.__platformAuth;
}

export async function getAuth(): Promise<Auth> {
  const runtime = authRuntime();
  await runtime.ready;
  return runtime.auth;
}

/** The verified session for this request, or null. Deduplicated per request by React `cache`. */
export const getSession = cache(async () => {
  // Read the request first: it marks the route dynamic, so nothing here runs during `next build`.
  const requestHeaders = await headers();
  const auth = await getAuth();
  return auth.api.getSession({ headers: requestHeaders });
});
