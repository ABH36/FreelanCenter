/**
 * @platform/db - Prisma schema, migrations, RLS SQL, database roles and the tenant-scoped client.
 * Read docs/modules/03-data-isolation-audit-admin.md before changing anything here.
 */
export const PACKAGE_NAME = '@platform/db' as const;

export {
  type PoolOptions,
  type TenantDatabase,
  type TenantDatabaseOptions,
  type TenantScope,
  type Tx,
  assertConnectionRole,
  createAuthPrismaClient,
  createTenantDatabase,
} from './client';
export { connectionConfig } from './connection';
export {
  DEFINER_ROLE,
  ENV_KEYS,
  EXPECTED_ROLES,
  assertUrlRole,
  roleOf,
  type DbUrlKey,
  type RuntimeRoleKey,
} from './env';
export { DbBusyError, DbError, InvalidScopeError, UnsafeRoleError } from './errors';
export { TransactionLimiter, type LimiterOptions } from './limiter';
export { isUuid, uuidv7 } from './uuid';
export {
  AuditActorType,
  AuditResult,
  DomainStatus,
  DomainType,
  MemberRole,
  ProjectStatus,
  UserStatus,
  WorkspaceStatus,
} from './generated/enums';
export type {
  Account,
  AuditLog,
  ClientContact,
  Domain,
  Invitation,
  Membership,
  Notification,
  PlatformAdmin,
  Prisma,
  Project,
  Session,
  User,
  Workspace,
} from './generated/client';
