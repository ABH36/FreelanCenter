/**
 * Typed outcomes of workspace commands. Messages are safe to show; they never echo another tenant's data.
 * NOT_FOUND is deliberately the same for "does not exist" and "not yours" (IDOR, SEC-10).
 */
import { ForbiddenError } from '@platform/auth/rbac';

export type WorkspaceErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'SLUG_TAKEN'
  | 'SLUG_RESERVED'
  | 'LAST_OWNER'
  | 'NOT_WRITABLE'
  | 'ALREADY_MEMBER'
  | 'ALREADY_INVITED'
  | 'CONFIRMATION_MISMATCH'
  | 'RATE_LIMITED'
  | 'INVALID_TRANSITION'
  | 'STALE'
  | 'ARCHIVED'
  | 'NOT_LIVE_READY'
  | 'SUBDOMAINS_NOT_CONFIGURED'
  | 'SUBDOMAIN_UNAVAILABLE'
  | 'IDEMPOTENCY_MISMATCH';

const MESSAGES: Record<WorkspaceErrorCode, string> = {
  NOT_FOUND: 'Not found.',
  FORBIDDEN: 'You do not have permission to do that in this workspace.',
  INVALID_INPUT: 'Check the highlighted fields.',
  SLUG_TAKEN: 'That address is already taken. Try another one.',
  SLUG_RESERVED: 'That address is reserved. Try another one.',
  LAST_OWNER: 'A workspace must keep at least one owner. Make someone else an owner first.',
  NOT_WRITABLE: 'This workspace is suspended or scheduled for deletion, so it cannot be changed.',
  ALREADY_MEMBER: 'That person is already a member of this workspace.',
  ALREADY_INVITED: 'An invitation to that address is already open. Resend or revoke it instead.',
  CONFIRMATION_MISMATCH: 'The confirmation does not match the workspace address.',
  RATE_LIMITED: 'You have done this many times recently. Try again tomorrow.',
  INVALID_TRANSITION: 'That status change is not possible for this project.',
  STALE: 'This project was changed a moment ago. Reload the page and try again.',
  ARCHIVED: 'This project is archived. Restore it before changing it.',
  NOT_LIVE_READY: 'The project needs an active subdomain before it can go live.',
  SUBDOMAINS_NOT_CONFIGURED: 'Project addresses are not set up in this environment yet. Contact support.',
  SUBDOMAIN_UNAVAILABLE: 'No free address could be found for this project name. Try a different name.',
  IDEMPOTENCY_MISMATCH:
    'This form was already submitted with different values. Reload the page and try again.',
};

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(MESSAGES[code]);
    this.name = 'WorkspaceError';
  }
}

/** SQLSTATE raised by the deferred last-owner trigger (migration p1_s5_workspaces_rbac). */
export const LAST_OWNER_SQLSTATE = 'P5001';

/** SQLSTATEs of the project lifecycle and subdomain rules (migration p1_s6_projects_lifecycle). */
const PROJECT_SQLSTATES: Record<string, WorkspaceErrorCode> = {
  P5002: 'INVALID_TRANSITION',
  P5003: 'ARCHIVED',
  P5004: 'SUBDOMAINS_NOT_CONFIGURED',
  P5005: 'SUBDOMAIN_UNAVAILABLE',
  P5006: 'NOT_LIVE_READY',
};

/** Every SQLSTATE / Prisma code on an error, however deeply the driver adapter nests it. */
export function errorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found: string[] = [];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = (error as Record<string, unknown>)[key];
    if ((key === 'code' || key === 'originalCode') && typeof value === 'string') found.push(value);
    else if (typeof value === 'string') {
      for (const m of value.matchAll(/\b(?:Code: `|code: |SQLSTATE )([0-9A-Z]{5})\b/g))
        found.push(m[1] as string);
    } else if (value && typeof value === 'object') found.push(...errorCodes(value, seen));
  }
  return found;
}

/** Maps database and authorization failures to WorkspaceError; anything unexpected is rethrown. */
export function translate(error: unknown): never {
  if (error instanceof WorkspaceError) throw error;
  if (error instanceof ForbiddenError) throw new WorkspaceError('FORBIDDEN');
  const codes = errorCodes(error);
  if (codes.includes(LAST_OWNER_SQLSTATE)) throw new WorkspaceError('LAST_OWNER');
  for (const code of codes) {
    const mapped = PROJECT_SQLSTATES[code];
    if (mapped) throw new WorkspaceError(mapped);
  }
  if (codes.includes('42501')) throw new WorkspaceError('FORBIDDEN');
  throw error;
}
