/**
 * Role-based access control (FR-AUTH-05, SRS section 7, SEC-10). One gate, `authorize(actor, capability,
 * resource)`, called by every service command before it touches data; the database repeats the member-management
 * rules in RLS (migration p1_s5_workspaces_rbac). UI hiding is not authorization.
 *
 * Pure and dependency-free (subpath `@platform/auth/rbac`), so it loads without Better Auth and is unit-tested
 * as a full role x capability matrix in `rbac.test.ts`.
 */

export const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** SRS 7, expanded. Workspace-management rows are the S5 additions; the rest are used from S6 onwards. */
export const CAPABILITIES = [
  'workspace.view',
  'workspace.update',
  'workspace.delete',
  'members.view',
  'members.manage',
  'members.manage_owners',
  'billing.manage',
  'audit.view',
  'projects.view',
  'projects.create',
  'projects.archive',
  'draft.edit',
  'site.publish',
  'version.approve',
  'leads.view',
  'domains.manage',
  'integrations.manage',
  'ai.use',
  'templates.sell',
  'platform.admin',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Who may do what inside a workspace. `site.publish` for editors is a workspace policy ("policy" in SRS 7),
 * off unless `editorsMayPublish` is set. PlatformAdmin is deliberately absent: it holds no workspace capability
 * and acts on tenants only through audited admin functions (FR-ADM, SEC-17).
 */
const MEMBER_GRANTS: Record<Capability, readonly WorkspaceRole[]> = {
  'workspace.view': ['owner', 'admin', 'editor', 'viewer'],
  'workspace.update': ['owner', 'admin'],
  'workspace.delete': ['owner'],
  'members.view': ['owner', 'admin', 'editor', 'viewer'],
  'members.manage': ['owner', 'admin'],
  'members.manage_owners': ['owner'],
  'billing.manage': ['owner'],
  'audit.view': ['owner'],
  'projects.view': ['owner', 'admin', 'editor', 'viewer'],
  'projects.create': ['owner', 'admin', 'editor'],
  'projects.archive': ['owner', 'admin'],
  'draft.edit': ['owner', 'admin', 'editor'],
  'site.publish': ['owner', 'admin'],
  'version.approve': ['owner', 'admin'],
  'leads.view': ['owner', 'admin', 'editor', 'viewer'],
  'domains.manage': ['owner', 'admin'],
  'integrations.manage': ['owner', 'admin'],
  'ai.use': ['owner', 'admin', 'editor'],
  'templates.sell': ['owner', 'admin'],
  'platform.admin': [],
};

/** A Client (Q5: no membership, project-scoped) may only act on their own project. */
const CLIENT_GRANTS: ReadonlySet<Capability> = new Set(['version.approve', 'leads.view']);

export type Actor =
  | { kind: 'member'; userId: string; workspaceId: string; role: WorkspaceRole }
  | { kind: 'platform_admin'; userId: string }
  | { kind: 'client'; workspaceId: string; projectId: string };

/** What the capability is exercised on. Omitted fields are not checked. */
export interface Resource {
  workspaceId?: string;
  projectId?: string;
}

export interface WorkspacePolicy {
  /** SRS 7 "Publish live: Editor = policy". Default false. */
  editorsMayPublish?: boolean;
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(readonly capability: Capability) {
    super(`not allowed: ${capability}`);
    this.name = 'ForbiddenError';
  }
}

export function can(
  actor: Actor,
  capability: Capability,
  resource: Resource = {},
  policy: WorkspacePolicy = {},
): boolean {
  switch (actor.kind) {
    case 'platform_admin':
      return capability === 'platform.admin';
    case 'client':
      return (
        CLIENT_GRANTS.has(capability) &&
        resource.projectId === actor.projectId &&
        (resource.workspaceId === undefined || resource.workspaceId === actor.workspaceId)
      );
    case 'member': {
      if (resource.workspaceId !== undefined && resource.workspaceId !== actor.workspaceId) return false;
      if (capability === 'site.publish' && actor.role === 'editor') return policy.editorsMayPublish === true;
      return MEMBER_GRANTS[capability].includes(actor.role);
    }
  }
}

/** Throws ForbiddenError unless `can(...)`. Services call this before any data access. */
export function authorize(
  actor: Actor,
  capability: Capability,
  resource: Resource = {},
  policy: WorkspacePolicy = {},
): void {
  if (!can(actor, capability, resource, policy)) throw new ForbiddenError(capability);
}

/** Roles an actor may assign through membership changes or invitations (owner is never invitable). */
export function assignableRoles(role: WorkspaceRole): WorkspaceRole[] {
  if (role === 'owner') return ['owner', 'admin', 'editor', 'viewer'];
  if (role === 'admin') return ['admin', 'editor', 'viewer'];
  return [];
}
