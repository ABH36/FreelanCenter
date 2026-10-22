/**
 * IDOR per resource type (SEC-10), data layer. Each Prisma operation an application could call with an id from
 * the browser gives the same observable outcome for another tenant's id as for an id that never existed.
 * Later slices register their server actions and route handlers with the same harness (`./idor`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantScope } from '@platform/db';
import { TABLE_NAMES, spec, type TableName } from './factories';
import { createUser, createWorld, fingerprint, type World } from './fixtures';
import { probeIdor, type IdorOperation } from './idor';

let w: World;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.close();
});

function prismaOperations(table: TableName): Array<IdorOperation<TenantScope>> {
  const { model, data } = spec(table).prisma;
  const on =
    <T>(fn: (m: ReturnType<typeof model>, id: string) => Promise<T>) =>
    (scope: TenantScope, id: string) =>
      w.db.withTenant(scope, (tx) => fn(model(tx), id));
  return [
    { name: 'findUnique', kind: 'read', run: on((m, id) => m.findUnique({ where: { id } })) },
    { name: 'findFirst', kind: 'read', run: on((m, id) => m.findFirst({ where: { id } })) },
    { name: 'count', kind: 'read', run: on((m, id) => m.count({ where: { id } })) },
    { name: 'updateMany', kind: 'write', run: on((m, id) => m.updateMany({ where: { id }, data })) },
    { name: 'update', kind: 'write', run: on((m, id) => m.update({ where: { id }, data })) },
    { name: 'deleteMany', kind: 'write', run: on((m, id) => m.deleteMany({ where: { id } })) },
    { name: 'delete', kind: 'write', run: on((m, id) => m.delete({ where: { id } })) },
  ];
}

describe('IDOR: Prisma model operations by id, workspace A against workspace B', () => {
  it.each(TABLE_NAMES)('%s', async (table) => {
    const report = await probeIdor({
      resource: table,
      attacker: w.A.scope,
      foreignId: w.B.rows[table],
      ownId: w.A.rows[table],
      operations: prismaOperations(table),
      victimState: () => fingerprint(w.db, w.B, table),
    });
    expect(report.results).toHaveLength(7);
    expect(report.violations).toEqual([]);
  });
});

describe('IDOR: user-private resources inside one workspace', () => {
  it("a member cannot read, mark or delete another member's notification", async () => {
    const member = await createUser(w.auth);
    await w.db.withTenant(w.A.scope, async (tx) => {
      await tx.membership.create({
        data: { workspaceId: w.A.scope.workspaceId, userId: member, role: 'viewer' },
      });
      // Addressed to someone else, so without RETURNING (the recipient SELECT policy would hide the new row).
      await tx.notification.createMany({
        data: [{ workspaceId: w.A.scope.workspaceId, userId: member, type: 'isolation.member' }],
      });
    });
    const memberScope = (await w.db.resolveTenantScope(member, w.A.scope.workspaceId))!;
    const own = await w.db.withTenant(memberScope, (tx) =>
      tx.notification.findFirstOrThrow({ select: { id: true } }),
    );
    const report = await probeIdor({
      resource: 'notifications (same workspace)',
      attacker: memberScope,
      foreignId: w.A.rows.notifications,
      ownId: own.id,
      operations: prismaOperations('notifications'),
      victimState: () => fingerprint(w.db, w.A, 'notifications'),
    });
    expect(report.violations).toEqual([]);
  });
});

describe('IDOR: workspace selection from a browser-supplied id (FR-AUTH-08)', () => {
  it('resolveTenantScope answers the same for a foreign workspace as for one that does not exist', async () => {
    const report = await probeIdor({
      resource: 'workspace scope',
      attacker: w.A.ownerId,
      foreignId: w.B.scope.workspaceId,
      ownId: w.A.scope.workspaceId,
      operations: [
        { name: 'resolveTenantScope', kind: 'read', run: (actor, id) => w.db.resolveTenantScope(actor, id) },
      ],
      victimState: () => fingerprint(w.db, w.B, 'workspaces'),
    });
    expect(report.results[0]?.foreign).toEqual({ kind: 'value', value: null });
    expect(report.violations).toEqual([]);
  });
});

describe('IDOR harness self-test', () => {
  it('flags an existence oracle, a failed positive control and a changed victim', async () => {
    let victim = 0;
    const report = await probeIdor<null>({
      resource: 'leaky',
      attacker: null,
      foreignId: 'foreign',
      ownId: 'own',
      missingId: 'missing',
      operations: [
        // Leaks: says "forbidden" for an existing foreign id but "not found" for a missing one.
        {
          name: 'oracle',
          kind: 'read',
          run: async (_a, id) => (id === 'foreign' ? 'forbidden' : id === 'own' ? 'ok' : null),
        },
        // Broken accessor: not found for everything, including the attacker's own id.
        { name: 'blind', kind: 'read', run: async () => null },
        // Silent cross-tenant write: same result, but the victim changed.
        {
          name: 'write',
          kind: 'write',
          run: async (_a, id) => {
            if (id === 'foreign') victim += 1;
            return 0;
          },
        },
      ],
      victimState: async () => victim,
    });
    expect(report.violations).toHaveLength(3);
    expect(report.violations.join('\n')).toMatch(/oracle: foreign id/);
    expect(report.violations.join('\n')).toMatch(/blind: positive control failed/);
    expect(report.violations.join('\n')).toMatch(/victim's resource changed/);
  });
});
