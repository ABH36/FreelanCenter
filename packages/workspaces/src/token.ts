/**
 * Invitation tokens (FR-AUTH-06, SEC-11). Only the SHA-256 of a token is stored (`invitations.token_hash`).
 *
 * The token is derived, not stored: token = HMAC-SHA256(K, invitation id), with K derived by HKDF from the
 * deployment secret under its own label. That lets the e-mail job rebuild the link from ids alone (ADR-007 rule
 * 3: no secret in an event payload) and lets a manager copy the link while no real e-mail is sent (DG-10), while
 * the database alone still cannot produce a working token. Rotating the secret invalidates open invitations.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto';

const LABEL = 'platform.workspace-invitation-token.v1';

export type InvitationKey = Buffer & { readonly __invitationKey: unique symbol };

export function deriveInvitationKey(secret: string): InvitationKey {
  if (secret.length < 32) throw new RangeError('the invitation key secret must be at least 32 characters');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), LABEL, 32)) as InvitationKey;
}

/** 256-bit, URL-safe. */
export function invitationToken(key: InvitationKey, invitationId: string): string {
  return createHmac('sha256', key).update(`invitation:${invitationId}`).digest('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shape check before any lookup: 43 base64url characters. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
