/**
 * Event contracts (cross-module contracts: namespaced, versioned, ids only). Inngest stores payloads outside
 * India (privacy inventory), so an event never carries an address, a name or a token: consumers reload state
 * through RLS. Payloads are validated at the sender and again inside the function (Spike G).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const EVENTS = {
  /** An invitation was created (or re-issued): send its e-mail (FR-AUTH-06, FR-NOT-01). */
  invitationCreated: 'workspace.invitation.created.v1',
  /** See NotificationEmailRequested. */
  notificationEmailRequested: 'notification.email.requested.v1',
} as const;

export interface InvitationCreated {
  workspaceId: string;
  invitationId: string;
}

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

/** Exactly the given keys, each a lower-case UUID; anything else is rejected. */
export function parseIds<K extends string>(data: unknown, keys: readonly K[]): Record<K, string> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidPayloadError('payload must be an object');
  }
  const actual = Object.keys(data).sort();
  const expected = [...keys].sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new InvalidPayloadError(`payload must contain exactly {${expected.join(', ')}}`);
  }
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !UUID.test(value))
      throw new InvalidPayloadError(`${key} must be a UUID`);
  }
  return data as Record<K, string>;
}

export const parseInvitationCreated = (data: unknown): InvitationCreated =>
  parseIds(data, ['workspaceId', 'invitationId'] as const);

/** A notification wants an e-mail (FR-NOT-01). Emitted from the outbox; the event id is the outbox id. */
export interface NotificationEmailRequested {
  workspaceId: string;
  notificationId: string;
}

export const parseNotificationEmailRequested = (data: unknown): NotificationEmailRequested =>
  parseIds(data, ['workspaceId', 'notificationId'] as const);
