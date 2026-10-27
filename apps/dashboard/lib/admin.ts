/**
 * Server-only admin console runtime (P1 S8; FR-ADM-01, FR-ADM-02, SEC-17): the app_admin client and the admin
 * service. Built lazily on first use like the other runtimes, so `next build` needs no secrets and a missing
 * DATABASE_URL_ADMIN fails only the console.
 *
 * The guard is layered: a verified session with TOTP enabled (Better Auth), then the database check
 * (`app.admin_console_state`: active platform admin, TOTP enrolled, live session); every page and action below the
 * step-up page additionally needs a step-up of this session within 15 minutes, which every admin function
 * re-checks in the database. Anyone who is not a platform admin gets 404, so the console's existence is not
 * confirmed.
 */
import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { verifySessionTotp } from '@platform/auth';
import { type AdminConsoleState, createAdminDatabase } from '@platform/db/admin';
import { type AdminPrincipal, type AdminService, createAdminService } from '@platform/workspaces';
import { getAuth, getSession, logger } from './auth';
import { workspaceOutbox } from './workspaces';

interface AdminRuntime {
  service: Promise<AdminService>;
}

const globalForAdmin = globalThis as unknown as { __platformAdmin?: AdminRuntime };

function build(): AdminRuntime {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) throw new Error('DATABASE_URL_ADMIN is not set');
  const db = createAdminDatabase({ connectionString: url });
  const service = (async () => {
    // One role check per process: the console must never run as an owner, tenant or BYPASSRLS role.
    await db.verifyRole();
    return createAdminService({ db, outbox: await workspaceOutbox(), logger });
  })();
  service.catch((error: unknown) => logger.fatal('admin.db.role_check_failed', error));
  return { service };
}

export function adminService(): Promise<AdminService> {
  globalForAdmin.__platformAdmin ??= build();
  return globalForAdmin.__platformAdmin.service;
}

export interface AdminContext {
  principal: AdminPrincipal;
  state: AdminConsoleState;
}

/** The console guard without the step-up (layout, step-up page). 404 for everyone who is not a platform admin. */
export const adminContext = cache(async (): Promise<AdminContext> => {
  const session = await getSession();
  if (!session?.user?.id || !session.user.emailVerified || session.user.twoFactorEnabled !== true) notFound();
  const principal = { userId: session.user.id, sessionId: session.session.id };
  const state = await (await adminService()).state(principal);
  if (!state.isAdmin) notFound();
  return { principal, state };
});

/** Every console page and action: a stepped-up admin session, or the step-up page. */
export async function requireAdmin(): Promise<AdminPrincipal> {
  const { principal, state } = await adminContext();
  if (!state.stepUpUntil) redirect('/admin/step-up');
  return principal;
}

/** Better Auth's TOTP check for this request's session (server-side call; S8-1). */
export async function totpVerifier(): Promise<(code: string) => Promise<boolean>> {
  const [auth, requestHeaders] = await Promise.all([getAuth(), headers()]);
  return (code) => verifySessionTotp(auth, requestHeaders, code);
}
