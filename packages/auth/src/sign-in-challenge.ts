/**
 * TOTP challenge for sign-ins that do not go through the two-factor plugin's own hook (DG-22, ADR-006, S8-2).
 *
 * Better Auth 1.7.12's plugin challenges only `/sign-in/email|username|phone-number`. Google (`/callback/:id`,
 * the ID-token form of `/sign-in/social`) and the auto sign-in after `/verify-email` create a full session for a
 * user whose 2FA is on. This module is the plugin's own hold, applied to those paths: the new session is deleted
 * before the response leaves, its cookies are stripped, and the same challenge state the plugin uses (signed
 * `two_factor` cookie, `2fa-<id>` row, `2fa-attempts-<id>` counter) is issued. `/two-factor/verify-totp` and
 * `/verify-backup-code` then finish it with the plugin's lockout, attempt counter and rate limit, and the session
 * exists only after a valid code. Re-check the path list on every Better Auth upgrade.
 */
import { type createAuthMiddleware, isAPIError } from 'better-auth/api';
import { generateRandomString } from 'better-auth/crypto';
import { deleteSessionCookie } from 'better-auth/cookies';

/** Same value as the plugin's `TWO_FACTOR_COOKIE_NAME` (not exported by the package). */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';
const CHALLENGE_MAX_AGE_SECONDS = 600;
export const CHALLENGE_PAGE = '/two-factor';

type MiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** Paths that can create a session for a user without the plugin's hook seeing it. */
export function createsSessionOutsidePluginHook(path: string | undefined): boolean {
  return !!path && (path.startsWith('/callback/') || path === '/sign-in/social' || path === '/verify-email');
}

/** Only a path on our own origin survives; anything else lands on the home page. */
export function safeReturnTo(location: string | null, baseURL: string): string {
  if (!location) return '/';
  try {
    const url = new URL(location, baseURL);
    if (url.origin !== new URL(baseURL).origin || url.pathname.startsWith(CHALLENGE_PAGE)) return '/';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/**
 * When the request just created a session for a user with 2FA on, hold it behind a TOTP challenge and replace the
 * response; `onIssued` records the audit event. Redirect responses (browser navigations) are re-pointed at the
 * challenge page (thrown, as Better Auth's own redirects are); JSON responses carry `twoFactorRedirect`, the shape
 * the plugin uses for password sign-in. Returns undefined when nothing applied.
 */
export async function holdSessionForTotp(
  ctx: MiddlewareContext,
  baseURL: string,
  onIssued: (userId: string) => Promise<void>,
) {
  const created = ctx.context.newSession;
  if (!created || (created.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled !== true) {
    return undefined;
  }
  const returned = ctx.context.returned;
  const location = isAPIError(returned) ? new Headers(returned.headers).get('location') : null;

  // The callback already queued Set-Cookie for the session; none of it may reach the browser.
  const queued = (ctx.context as { responseHeaders?: Headers }).responseHeaders;
  if (queued) {
    const cookies = queued.getSetCookie();
    const { sessionToken, sessionData, accountData, dontRememberToken } = ctx.context.authCookies;
    const dropped = [sessionToken, sessionData, accountData, dontRememberToken].map((c) => `${c.name}=`);
    queued.delete('set-cookie');
    for (const cookie of cookies)
      if (!dropped.some((prefix) => cookie.startsWith(prefix))) queued.append('set-cookie', cookie);
  }
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  ctx.context.setNewSession(null);

  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge: CHALLENGE_MAX_AGE_SECONDS });
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000);
  await ctx.context.internalAdapter.createVerificationValue({
    value: created.user.id,
    identifier,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: '0',
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);

  await onIssued(created.user.id);

  if (isAPIError(returned) && location !== null) {
    const returnTo = safeReturnTo(location, baseURL);
    throw ctx.redirect(`${CHALLENGE_PAGE}?${new URLSearchParams({ callbackURL: returnTo })}`);
  }
  // Defensive: a redirect-less response is the JSON form, which tells the client to show the challenge.
  return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
}

/** The user a pending challenge belongs to (from the signed challenge cookie), for audit rows written before any session exists. */
export async function pendingChallengeUserId(ctx: MiddlewareContext): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return row?.value ?? null;
}
