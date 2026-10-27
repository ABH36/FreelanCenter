/**
 * Admin service without a database (P1 S8): input validation, the step-up sequence and its failure paths, error
 * translation, paging, and the after-commit dispatch of the suspension's invalidations. The database side is in
 * packages/db/test/integration/admin.test.ts, the end-to-end invalidation in test/integration/host-routing.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AdminDatabase } from '@platform/db/admin';
import { createAdminService } from './admin';
import { WorkspaceError } from './errors';
import type { Outbox } from './outbox';

const P = {
  userId: '01900000-0000-7000-8000-000000000001',
  sessionId: '01900000-0000-7000-8000-000000000002',
};
const WS = '01900000-0000-7000-8000-0000000000aa';
const pgError = (code: string) => Object.assign(new Error('db'), { code });

function setup(overrides: Partial<AdminDatabase> = {}) {
  const db = {
    consoleState: vi.fn(async () => ({ isAdmin: true, stepUpUntil: null, lockedUntil: null })),
    beginStepUp: vi.fn(async () => 'attempt-1'),
    finishStepUp: vi.fn(async (_p, _a, verified: boolean) =>
      verified ? new Date('2026-10-27T10:15:00Z') : null,
    ),
    listWorkspaces: vi.fn(async () => []),
    getWorkspace: vi.fn(async () => null),
    listUsers: vi.fn(async () => []),
    listAudit: vi.fn(async () => []),
    setWorkspaceStatus: vi.fn(async () => ({ changed: true, outboxIds: ['o1', 'o2'] })),
    verifyRole: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as AdminDatabase;
  const outbox = { dispatch: vi.fn(async () => undefined), sweep: vi.fn() } as unknown as Outbox;
  return { db, outbox, admin: createAdminService({ db, outbox }) };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkspaceError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('step-up', () => {
  it('a valid code is checked once and recorded as verified', async () => {
    const { db, admin } = setup();
    const verify = vi.fn(async () => true);
    await expect(admin.stepUp(P, ' 123 456 ', verify)).resolves.toEqual({
      until: new Date('2026-10-27T10:15:00Z'),
    });
    expect(verify).toHaveBeenCalledWith('123456');
    expect(db.finishStepUp).toHaveBeenCalledWith(P, 'attempt-1', true, null);
  });

  it('a malformed code starts no attempt', async () => {
    const { db, admin } = setup();
    for (const code of ['', '12345', '1234567', 'abcdef', null, 42]) {
      expect(await codeOf(admin.stepUp(P, code, async () => true))).toBe('INVALID_INPUT');
    }
    expect(db.beginStepUp).not.toHaveBeenCalled();
  });

  it('a wrong code is recorded as failed; a locked step-up checks no code', async () => {
    const { db, admin } = setup();
    expect(await codeOf(admin.stepUp(P, '000000', async () => false))).toBe('MFA_CODE_INVALID');
    expect(db.finishStepUp).toHaveBeenCalledWith(P, 'attempt-1', false, null);

    const locked = setup({ beginStepUp: vi.fn(async () => null) });
    const verify = vi.fn(async () => true);
    expect(await codeOf(locked.admin.stepUp(P, '123456', verify))).toBe('MFA_LOCKED');
    expect(verify).not.toHaveBeenCalled();
  });

  it('a verifier error leaves the attempt pending (it counts) and propagates', async () => {
    const { db, admin } = setup();
    await expect(
      admin.stepUp(P, '123456', async () => {
        throw new Error('auth down');
      }),
    ).rejects.toThrow('auth down');
    expect(db.finishStepUp).not.toHaveBeenCalled();
  });

  it('database refusals become typed errors; other errors propagate', async () => {
    expect(
      await codeOf(
        setup({ beginStepUp: vi.fn(async () => Promise.reject(pgError('42501'))) }).admin.stepUp(
          P,
          '123456',
          async () => true,
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        setup({ finishStepUp: vi.fn(async () => Promise.reject(pgError('P0002'))) }).admin.stepUp(
          P,
          '123456',
          async () => true,
        ),
      ),
    ).toBe('NOT_FOUND');
    await expect(
      setup({ listAudit: vi.fn(async () => Promise.reject(new Error('boom'))) }).admin.listAudit(P),
    ).rejects.toThrow('boom');
    expect(
      await codeOf(
        setup({ listUsers: vi.fn(async () => Promise.reject(pgError('22023'))) }).admin.listUsers(P),
      ),
    ).toBe('INVALID_INPUT');
  });
});

describe('lists', () => {
  it('pages with one extra row; malformed filters and cursors are dropped', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `id-${String(100 - i).padStart(3, '0')}` }));
    const { db, admin } = setup({
      listWorkspaces: vi.fn(async () => rows) as unknown as AdminDatabase['listWorkspaces'],
    });
    const page = await admin.listWorkspaces(P, { query: '  acme ', status: 'bogus', cursor: 'not-a-uuid' });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe(page.items.at(-1)!.id);
    expect(db.listWorkspaces).toHaveBeenCalledWith(
      P,
      { query: 'acme', status: null, before: null, limit: 51 },
      null,
    );
    expect(await codeOf(admin.listWorkspaces(P, { query: 'x'.repeat(101) }))).toBe('INVALID_INPUT');

    const last = setup();
    expect(await last.admin.listWorkspaces(P, { status: 'suspended', cursor: WS })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(last.db.listWorkspaces).toHaveBeenCalledWith(
      P,
      { query: null, status: 'suspended', before: WS, limit: 51 },
      null,
    );
  });

  it('users: id or exact address only, lower-cased; never a fragment', async () => {
    const { db, admin } = setup();
    expect(await codeOf(admin.listUsers(P, { query: 'alice' }))).toBe('INVALID_INPUT');
    expect(await codeOf(admin.listUsers(P, { query: `${'a'.repeat(250)}@x.io` }))).toBe('INVALID_INPUT');
    expect(db.listUsers).not.toHaveBeenCalled();
    await admin.listUsers(P, { query: ' Alice@Example.COM ' });
    await admin.listUsers(P, { query: WS.toUpperCase() });
    await admin.listUsers(P, {});
    expect(vi.mocked(db.listUsers).mock.calls.map((c) => c[1].query)).toEqual([
      'alice@example.com',
      WS,
      null,
    ]);
  });

  it('audit: only a well-formed action prefix and actor id reach the database', async () => {
    const { db, admin } = setup();
    await admin.listAudit(P, { action: "x' OR 1=1", actorId: 'me' });
    await admin.listAudit(P, { action: 'admin.', actorId: P.userId });
    expect(vi.mocked(db.listAudit).mock.calls.map((c) => c[1])).toEqual([
      { action: null, actorId: null, before: null, limit: 51 },
      { action: 'admin.', actorId: P.userId, before: null, limit: 51 },
    ]);
  });

  it('a malformed workspace id is not looked up', async () => {
    const { db, admin } = setup();
    expect(await admin.getWorkspace(P, '../etc')).toBeNull();
    expect(await admin.getWorkspace(P, 7)).toBeNull();
    expect(db.getWorkspace).not.toHaveBeenCalled();
    await admin.getWorkspace(P, WS);
    expect(db.getWorkspace).toHaveBeenCalledWith(P, WS, null);
  });
});

describe('suspend / unsuspend (FR-ADM-02)', () => {
  it('needs a reason of 3-500 characters and a known status; a malformed id is NOT_FOUND', async () => {
    const { db, admin } = setup();
    for (const reason of ['', '  ab ', 'x'.repeat(501), undefined]) {
      expect(
        await codeOf(admin.setWorkspaceStatus(P, { workspaceId: WS, status: 'suspended', reason })),
      ).toBe('INVALID_INPUT');
    }
    expect(
      await codeOf(admin.setWorkspaceStatus(P, { workspaceId: WS, status: 'deleted', reason: 'abuse' })),
    ).toBe('INVALID_INPUT');
    expect(
      await codeOf(admin.setWorkspaceStatus(P, { workspaceId: 'nope', status: 'active', reason: 'abuse' })),
    ).toBe('NOT_FOUND');
    expect(db.setWorkspaceStatus).not.toHaveBeenCalled();
  });

  it('dispatches the invalidation rows after the database call returned (committed)', async () => {
    const { db, outbox, admin } = setup();
    await expect(
      admin.setWorkspaceStatus(P, { workspaceId: WS, status: 'suspended', reason: '  phishing #1 ' }),
    ).resolves.toEqual({ changed: true });
    expect(db.setWorkspaceStatus).toHaveBeenCalledWith(
      P,
      { workspaceId: WS, status: 'suspended', reason: 'phishing #1' },
      null,
    );
    expect(outbox.dispatch).toHaveBeenCalledWith(WS, ['o1', 'o2']);
    expect(vi.mocked(db.setWorkspaceStatus).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(outbox.dispatch).mock.invocationCallOrder[0]!,
    );
  });

  it('a refused change dispatches nothing', async () => {
    const { outbox, admin } = setup({
      setWorkspaceStatus: vi.fn(async () => Promise.reject(pgError('42501'))),
    });
    expect(
      await codeOf(admin.setWorkspaceStatus(P, { workspaceId: WS, status: 'suspended', reason: 'abuse' })),
    ).toBe('FORBIDDEN');
    expect(outbox.dispatch).not.toHaveBeenCalled();
  });
});
