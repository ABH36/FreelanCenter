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
  | 'IDEMPOTENCY_MISMATCH'
  | 'MFA_CODE_INVALID'
  | 'MFA_LOCKED'
  | 'PREVIEWS_NOT_CONFIGURED'
  // P3 S2: the draft service (builder).
  | 'DRAFT_CONFLICT'
  | 'DRAFT_EXISTS'
  | 'NO_DRAFT'
  | 'LOCK_REQUIRED'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO'
  | 'UNDO_LIMIT'
  | 'PROPOSAL_STALE'
  | 'CHANGE_TOO_LARGE';

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
  MFA_CODE_INVALID: 'That code is not valid. Enter the current code from your authenticator app.',
  MFA_LOCKED: 'Too many wrong codes. Try again in 15 minutes.',
  PREVIEWS_NOT_CONFIGURED: 'Preview links are not set up in this environment yet. Contact support.',
  DRAFT_CONFLICT:
    'Someone saved this site a moment ago. Your view was refreshed; check it and make your change again.',
  DRAFT_EXISTS: 'This project already has a site from another template.',
  NO_DRAFT: 'This project has no site yet. Choose a template first.',
  LOCK_REQUIRED: 'Someone else is editing this site right now. You can view it until they finish.',
  NOTHING_TO_UNDO: 'There is nothing to undo.',
  NOTHING_TO_REDO: 'There is nothing to redo.',
  UNDO_LIMIT: 'You can undo only the last 50 changes.',
  PROPOSAL_STALE: 'The site changed after this suggestion was made. Ask for a new suggestion.',
  CHANGE_TOO_LARGE: 'This change is too large to save in one step. Make it in smaller parts.',
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
  // P3 S1 builder data model.
  P5101: 'DRAFT_CONFLICT',
  P5102: 'INVALID_TRANSITION',
  P5103: 'INVALID_INPUT',
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

/**
 * `instanceof WorkspaceError` fails when the error crosses two copies of this module, which Next.js bundling can
 * produce between a route handler and the shared runtime (P3 S3: the editor preview answered 500 instead of 404).
 * Route handlers use this check instead.
 */
export function isWorkspaceError(error: unknown): error is WorkspaceError {
  if (error instanceof WorkspaceError) return true;
  if (!(error instanceof Error) || error.name !== 'WorkspaceError') return false;
  const code = (error as unknown as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code);
}
