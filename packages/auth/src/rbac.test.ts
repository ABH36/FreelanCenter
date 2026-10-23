/**
 * Permission matrix (FR-AUTH-05: "Permission matrix documented and tested"). The expected table is written out
 * by hand from SRS section 7, row by row, so a change to `rbac.ts` that disagrees with the SRS fails here. Rows
 * marked "S5" expand the SRS summary for workspace management; the decisions behind them are in
 * docs/reports/PHASE_1_S5_WORKSPACES_RBAC.md.
 */
import { describe, expect, it } from 'vitest';
import {
  type Actor,
  CAPABILITIES,
  type Capability,
  ForbiddenError,
  WORKSPACE_ROLES,
  assignableRoles,
  authorize,
  can,
} from './rbac';

const WS = '01900000-0000-7000-8000-000000000001';
const OTHER_WS = '01900000-0000-7000-8000-000000000002';
const PROJECT = '01900000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '01900000-0000-7000-8000-0000000000a2';

type Principal = 'PlatformAdmin' | 'Owner' | 'Admin' | 'Editor' | 'Viewer' | 'Client';
const PRINCIPALS: Principal[] = ['PlatformAdmin', 'Owner', 'Admin', 'Editor', 'Viewer', 'Client'];

// Columns: PlatformAdmin, Owner, Admin, Editor, Viewer, Client. "y" = allowed, "-" = denied, "p" = editor only
// when the workspace policy allows it. Client entries apply to the client's own project only.
const MATRIX: Record<Capability, string> = {
  // SRS 7
  'billing.manage': '- y - - - -',
  'members.manage': '- y y - - -',
  'projects.create': '- y y y - -',
  'projects.archive': '- y y - - -',
  'draft.edit': '- y y y - -',
  'site.publish': '- y y p - -',
  'version.approve': '- y y - - y',
  'leads.view': '- y y y y y',
  'domains.manage': '- y y - - -',
  'integrations.manage': '- y y - - -',
  'ai.use': '- y y y - -',
  'templates.sell': '- y y - - -',
  'platform.admin': 'y - - - - -',
  // S5 expansion (workspace management) and FR-AUD-01 ("workspace owners can view/export theirs")
  'workspace.view': '- y y y y -',
  'workspace.update': '- y y - - -',
  'workspace.delete': '- y - - - -',
  'members.view': '- y y y y -',
  'members.manage_owners': '- y - - - -',
  'audit.view': '- y - - - -',
  'projects.view': '- y y y y -',
};

function actorFor(principal: Principal): Actor {
  switch (principal) {
    case 'PlatformAdmin':
      return { kind: 'platform_admin', userId: 'u-admin' };
    case 'Client':
      return { kind: 'client', workspaceId: WS, projectId: PROJECT };
    default:
      return {
        kind: 'member',
        userId: 'u-member',
        workspaceId: WS,
        role: principal.toLowerCase() as (typeof WORKSPACE_ROLES)[number],
      };
  }
}

const cells = (capability: Capability) => MATRIX[capability].split(' ');

describe('permission matrix (SRS 7): every principal x every capability', () => {
  it('the matrix covers every capability exactly once', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...CAPABILITIES].sort());
    for (const capability of CAPABILITIES) expect(cells(capability), capability).toHaveLength(6);
  });

  const cases = CAPABILITIES.flatMap((capability) =>
    PRINCIPALS.map((principal, i) => ({ capability, principal, cell: cells(capability)[i] as string })),
  );

  it.each(cases)('$principal / $capability = $cell', ({ capability, principal, cell }) => {
    const actor = actorFor(principal);
    const resource = { workspaceId: WS, projectId: PROJECT };
    expect(can(actor, capability, resource), 'default policy').toBe(cell === 'y');
    expect(can(actor, capability, resource, { editorsMayPublish: true }), 'editors may publish').toBe(
      cell === 'y' || cell === 'p',
    );
    if (cell === 'y') {
      expect(() => authorize(actor, capability, resource)).not.toThrow();
    } else {
      expect(() => authorize(actor, capability, resource)).toThrow(ForbiddenError);
    }
  });
});

describe('scope', () => {
  it('a member is denied every capability in another workspace', () => {
    for (const role of WORKSPACE_ROLES) {
      const actor: Actor = { kind: 'member', userId: 'u', workspaceId: WS, role };
      for (const capability of CAPABILITIES) {
        expect(can(actor, capability, { workspaceId: OTHER_WS }), `${role} ${capability}`).toBe(false);
      }
    }
  });

  it("a client is denied another project's leads and approvals, and anything without a project", () => {
    const client = actorFor('Client');
    for (const capability of ['version.approve', 'leads.view'] as const) {
      expect(can(client, capability, { workspaceId: WS, projectId: OTHER_PROJECT })).toBe(false);
      expect(can(client, capability, { workspaceId: OTHER_WS, projectId: PROJECT })).toBe(false);
      expect(can(client, capability, {})).toBe(false);
    }
  });

  it('the error names the capability and carries a stable code', () => {
    try {
      authorize(actorFor('Viewer'), 'members.manage', { workspaceId: WS });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).code).toBe('FORBIDDEN');
      expect((error as ForbiddenError).capability).toBe('members.manage');
    }
  });
});

describe('assignable roles', () => {
  it('owners assign any role, admins never owner, editors and viewers nothing', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'editor', 'viewer']);
    expect(assignableRoles('admin')).toEqual(['admin', 'editor', 'viewer']);
    expect(assignableRoles('editor')).toEqual([]);
    expect(assignableRoles('viewer')).toEqual([]);
  });
});
