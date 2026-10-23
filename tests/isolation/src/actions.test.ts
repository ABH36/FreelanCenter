/**
 * IDOR for dashboard server actions and page loaders (SEC-10), P1 S5. Two gates:
 * 1. completeness: every exported function of every `'use server'` module in apps/dashboard is registered in
 *    `actions.ts` (with its selectors, or the reason it has none);
 * 2. for every selector of every registered action and page loader, the IDOR property of `./idor`: another
 *    workspace's id gives exactly the outcome of an id that never existed, reads still work on the attacker's
 *    own id, and the victim workspace is unchanged.
 * The attacker is the owner of workspace A (the strongest role), so a refusal cannot come from a weak role.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInlineJobs } from '@platform/jobs';
import { createCaptureProvider } from '@platform/providers';
import {
  type WorkspaceService,
  WorkspaceError,
  createInvitationEmailHandler,
  createWorkspaceService,
  deriveInvitationKey,
} from '@platform/workspaces';
import { PAGE_LOADERS, SERVER_ACTIONS, type Selector } from './actions';
import { createUser, pool, tenantDb, unique, urls } from './fixtures';
import { probeIdor } from './idor';

const DASHBOARD = fileURLToPath(new URL('../../../apps/dashboard', import.meta.url));

const db = tenantDb();
const auth = pool(urls.auth, 2);
const invitationKey = deriveInvitationKey('isolation-suite-local-only-secret-0123456789');
const handler = createInvitationEmailHandler({
  db,
  email: createCaptureProvider(),
  invitationKey,
  baseURL: 'http://localhost:3000',
  appName: 'Platform',
});
const service: WorkspaceService = createWorkspaceService({
  db,
  // Mail is not under test here: deferred job work is dropped.
  jobs: createInlineJobs({ invitationEmail: handler }, () => {}).emitter,
  invitationKey,
  baseURL: 'http://localhost:3000',
});

type Selectors = Record<Selector, string>;
interface Tenant {
  ownerId: string;
  own: Selectors;
}
let A: Tenant;
let B: Tenant;

async function seed(): Promise<Tenant> {
  const ownerId = await createUser(auth);
  const { id, slug } = await service.createWorkspace(ownerId, { name: 'IDOR tenant', slug: unique('idor') });
  const editorId = await createUser(auth);
  const editorEmail = (
    await auth.query<{ email: string }>('SELECT email FROM identity.users WHERE id = $1', [editorId])
  ).rows[0]!.email;
  const invited = await service.createInvitation(ownerId, {
    workspaceId: id,
    email: editorEmail,
    role: 'editor',
  });
  const { url } = await service.invitationLink(ownerId, {
    workspaceId: id,
    invitationId: invited.invitationId,
  });
  await service.acceptInvitation(editorId, url.split('/invite/')[1]!);
  const open = await service.createInvitation(ownerId, {
    workspaceId: id,
    email: `${unique('idor-open')}@example.test`,
    role: 'viewer',
  });
  const members = await service.listMembers(ownerId, id);
  return {
    ownerId,
    own: {
      workspaceId: id,
      slug,
      membershipId: members.find((m) => m.userId === editorId)!.membershipId,
      invitationId: open.invitationId,
    },
  };
}

beforeAll(async () => {
  A = await seed();
  B = await seed();
});
afterAll(async () => {
  await db.disconnect();
  await auth.end();
});

/** How each service method is called with the selectors; typed failures become comparable values. */
const CALLS: Record<string, (actor: string, s: Selectors) => Promise<unknown>> = {
  renameWorkspace: (a, s) => service.renameWorkspace(a, { workspaceId: s.workspaceId, name: 'IDOR probe' }),
  requestDeletion: (a, s) =>
    service.requestDeletion(a, { workspaceId: s.workspaceId, confirmSlug: 'idor-probe' }),
  cancelDeletion: (a, s) => service.cancelDeletion(a, { workspaceId: s.workspaceId }),
  changeMemberRole: (a, s) =>
    service.changeMemberRole(a, { workspaceId: s.workspaceId, membershipId: s.membershipId, role: 'viewer' }),
  removeMember: (a, s) =>
    service.removeMember(a, { workspaceId: s.workspaceId, membershipId: s.membershipId }),
  leaveWorkspace: (a, s) => service.leaveWorkspace(a, { workspaceId: s.workspaceId }),
  createInvitation: (a, s) =>
    service.createInvitation(a, {
      workspaceId: s.workspaceId,
      email: `${unique('probe')}@example.test`,
      role: 'viewer',
    }),
  revokeInvitation: (a, s) =>
    service.revokeInvitation(a, { workspaceId: s.workspaceId, invitationId: s.invitationId }),
  resendInvitation: (a, s) =>
    service.resendInvitation(a, { workspaceId: s.workspaceId, invitationId: s.invitationId }),
  invitationLink: (a, s) =>
    service.invitationLink(a, { workspaceId: s.workspaceId, invitationId: s.invitationId }),
  resolveBySlug: async (a, s) => {
    const ctx = await service.resolveBySlug(a, s.slug);
    return ctx && { id: ctx.id, role: ctx.role };
  },
  listMembers: (a, s) => service.listMembers(a, s.workspaceId),
  listInvitations: (a, s) => service.listInvitations(a, s.workspaceId),
  getOverview: (a, s) => service.getOverview(a, s.workspaceId),
};
const READS = new Set(['invitationLink', 'resolveBySlug', 'listMembers', 'listInvitations', 'getOverview']);

const call = (method: string) => async (actor: string, s: Selectors) => {
  try {
    return await CALLS[method]!(actor, s);
  } catch (error) {
    if (error instanceof WorkspaceError) return { error: error.code };
    throw error;
  }
};

/** B as its owner sees it: name, deletion state, members with roles, open invitations. */
async function victimState() {
  const ctx = (await service.resolveBySlug(B.ownerId, B.own.slug))!;
  return {
    name: ctx.name,
    deletion: ctx.deletionScheduledFor,
    members: (await service.listMembers(B.ownerId, B.own.workspaceId)).map((m) => [m.membershipId, m.role]),
    invitations: (await service.listInvitations(B.ownerId, B.own.workspaceId)).map((i) => i.id),
  };
}

function serverActionExports(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) {
        const source = readFileSync(path, 'utf8');
        if (!/['"]use server['"]/.test(source)) continue;
        if (!/^\s*['"]use server['"]/.test(source)) {
          throw new Error(
            `${relative(DASHBOARD, path)}: inline 'use server' functions must move to a server module`,
          );
        }
        for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
          found.set(m[1]!, relative(DASHBOARD, path));
        }
        if (/export\s+(?:const|let|default)\b/.test(source.replace(/export\s+(?:type|interface)\b/g, ''))) {
          throw new Error(
            `${relative(DASHBOARD, path)}: export server actions as named async functions only`,
          );
        }
      }
    }
  };
  walk(DASHBOARD);
  return found;
}

describe('server-action registry (completeness)', () => {
  it('every exported server action in apps/dashboard is registered, and nothing stale is', () => {
    const exported = serverActionExports();
    expect(exported.size, 'no server actions found: the scan is broken').toBeGreaterThan(0);
    expect([...exported.keys()].sort()).toEqual(Object.keys(SERVER_ACTIONS).sort());
  });

  it('every registered service method has a probe call, and every no-selector entry gives a reason', () => {
    for (const [name, reg] of Object.entries({ ...SERVER_ACTIONS, ...PAGE_LOADERS })) {
      if ('selectors' in reg) {
        expect(CALLS[reg.service], name).toBeTypeOf('function');
        expect(reg.selectors.length, name).toBeGreaterThan(0);
      } else {
        expect(reg.noSelector.length, name).toBeGreaterThan(20);
      }
    }
  });
});

const probes = Object.entries({ ...SERVER_ACTIONS, ...PAGE_LOADERS }).flatMap(([name, reg]) =>
  'selectors' in reg ? reg.selectors.map((selector) => ({ name, method: reg.service, selector })) : [],
);

describe('IDOR: server actions and page loaders, owner of A against workspace B', () => {
  it.each(probes)('$name via $selector', async ({ method, selector }) => {
    const report = await probeIdor({
      resource: `${method}.${selector}`,
      attacker: A.ownerId,
      foreignId: B.own[selector],
      ownId: A.own[selector],
      missingId: selector === 'slug' ? unique('missing') : undefined,
      operations: [
        {
          name: method,
          kind: READS.has(method) ? 'read' : 'write',
          run: (actor, id) => call(method)(actor, { ...A.own, [selector]: id }),
        },
      ],
      victimState,
    });
    expect(report.violations).toEqual([]);
    // Every foreign probe ends as NOT_FOUND or an empty result, never as FORBIDDEN (which would confirm existence).
    for (const r of report.results) expect(JSON.stringify(r.foreign)).not.toContain('FORBIDDEN');
  });
});
