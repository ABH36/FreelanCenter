/**
 * TOTP check for the admin console step-up (P1 S8, SEC-17). Uses Better Auth's own verifier (it decrypts the
 * stored secret) through a server-side `auth.api` call, which the S8-1 hook in `auth.ts` allows while the same
 * endpoint over HTTP is refused once 2FA is on. The caller owns the attempt counting and lockout.
 */
import { APIError } from 'better-auth/api';
import type { Auth } from './auth';

/** true for a valid current code of the session's user, false for a wrong one; anything else throws. */
export async function verifySessionTotp(auth: Auth, headers: Headers, code: string): Promise<boolean> {
  try {
    await auth.api.verifyTOTP({ headers, body: { code } });
    return true;
  } catch (error) {
    if (error instanceof APIError && error.body?.code === 'INVALID_CODE') return false;
    throw error;
  }
}
