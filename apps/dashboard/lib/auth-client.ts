'use client';
/**
 * Browser auth client. It only calls /api/auth on the same origin; every decision is made on the server.
 */
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.assign('/two-factor');
      },
    }),
  ],
});

/** Generic, non-enumerating copy for every Better Auth error code the UI can meet. */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'Email or password is incorrect.',
  EMAIL_NOT_VERIFIED: 'Verify your email first. We have sent you a new link.',
  ACCOUNT_NOT_ACTIVE: 'This account is not active. Contact support.',
  PASSWORD_TOO_SHORT: 'Use at least 12 characters.',
  PASSWORD_TOO_LONG: 'Use at most 128 characters.',
  INVALID_TOKEN: 'This link is invalid or has expired. Request a new one.',
  INVALID_CODE: 'That code is not valid. Try again.',
  INVALID_TWO_FACTOR_COOKIE: 'Your sign-in expired. Start again.',
  INVALID_PASSWORD: 'Password is incorrect.',
  MISSING_RESPONSE: 'Complete the security check and try again.',
  VERIFICATION_FAILED: 'The security check failed. Try again.',
};

export function authErrorMessage(error: { code?: string; status?: number } | null | undefined): string {
  if (!error) return '';
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return (error.code && MESSAGES[error.code]) || 'Something went wrong. Try again.';
}
