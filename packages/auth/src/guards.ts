/**
 * Server-side guards on top of a resolved session. UI hiding is not authorization (module 01): every server
 * action and route handler calls these with the session it resolved itself, never with client input.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled?: boolean | null;
}

export interface ResolvedSession {
  user: SessionUser;
  session: { id: string; createdAt: Date; expiresAt: Date };
}

export class AuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';
  constructor() {
    super('authentication required');
    this.name = 'AuthRequiredError';
  }
}

export class MfaRequiredError extends Error {
  readonly code = 'MFA_REQUIRED';
  constructor() {
    super('two-factor authentication must be enabled for this action');
    this.name = 'MfaRequiredError';
  }
}

export class FreshSessionRequiredError extends Error {
  readonly code = 'FRESH_SESSION_REQUIRED';
  constructor() {
    super('sign in again to continue');
    this.name = 'FreshSessionRequiredError';
  }
}

export function requireSession(session: ResolvedSession | null | undefined): ResolvedSession {
  if (!session?.user?.id || !session.user.emailVerified) throw new AuthRequiredError();
  return session;
}

/**
 * FR-AUTH-03: TOTP is required before a Workspace Owner enables payouts (P6) or white-label (P7A). The guard
 * ships in S4; its call sites arrive with those features. `maxAgeSeconds` additionally demands a recent sign-in.
 */
export function requireMfa(
  session: ResolvedSession | null | undefined,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): ResolvedSession {
  const resolved = requireSession(session);
  if (resolved.user.twoFactorEnabled !== true) throw new MfaRequiredError();
  if (options.maxAgeSeconds !== undefined) {
    const now = options.now ?? new Date();
    const ageSeconds = (now.getTime() - new Date(resolved.session.createdAt).getTime()) / 1000;
    if (ageSeconds > options.maxAgeSeconds) throw new FreshSessionRequiredError();
  }
  return resolved;
}
