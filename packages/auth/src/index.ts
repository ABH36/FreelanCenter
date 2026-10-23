/**
 * @platform/auth - product authentication (ADR-006, module 01). Server-only: never import from client code.
 */
export const PACKAGE_NAME = '@platform/auth' as const;

export {
  type Auth,
  type AuthDeps,
  type AuthPrismaClient,
  CAPTCHA_ENDPOINTS,
  RATE_LIMIT_RULES,
  SESSION_POLICY,
  TOTP_LOCKOUT,
  createAuth,
} from './auth';
export { type AuditWriter, type AuthAuditAction, type AuthAuditEvent, createAuditWriter } from './audit';
export {
  type AuthConfig,
  type EmailTransport,
  AuthConfigError,
  TURNSTILE_TEST_KEYS,
  loadAuthConfig,
} from './config';
export {
  type ResolvedSession,
  type SessionUser,
  AuthRequiredError,
  FreshSessionRequiredError,
  MfaRequiredError,
  requireMfa,
  requireSession,
} from './guards';
export {
  type AuthMail,
  type AuthMailKind,
  type Defer,
  createAuthMailer,
  inlineDefer,
  renderAuthMail,
} from './mail';
export {
  type Actor,
  type Capability,
  type Resource,
  type WorkspacePolicy,
  type WorkspaceRole,
  CAPABILITIES,
  ForbiddenError,
  WORKSPACE_ROLES,
  assignableRoles,
  authorize,
  can,
} from './rbac';
