/**
 * P3 S2: the draft service against the local database (FR-PRJ-01, FR-BLD-06, FR-BLD-07; approved 2026-11-14).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '@platform/db';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { BUILDER_LIMITS, createBuilderService } from '../../src/builder';
import { WorkspaceError } from '../../src/errors';
import { closeAll, db, projects, unique, workspaceWith } from '../harness';

const builder = createBuilderService({ db });
let migrator: pg.Pool;
let templateId: string;
let otherTemplateId: string;

const config = {
  schemaVersion: '1.0',
  business: {
    name: 'Iron Pulse Fitness',
    category: 'gym',
    phone: '+919800000000',
    address: { line1: '12 MG Road', city: 'Indore', state: 'MP', postalCode: '452001', country: 'IN' },
  },
  theme: {
    colors: {
      primary: '#E11D2E',
      secondary: '#111827',
      accent: '#FACC15',
      background: '#0B0B0F',
      surface: '#15151C',
      text: '#F9FAFB',
    },
    typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
    radius: 'lg',
    spacing: 'regular',
    buttons: { style: 'solid', shape: 'pill', hover: 'lift' },
    motion: { preset: 'subtle', reducedMotionRespected: true },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      title: 'Home',
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Personal training', description: 'One to one' }] },
        },
        {
          id: 's2',
          type: 'contact',
          variant: 'form-map',
          visible: true,
          props: { fields: ['name', 'phone', 'message'], showMap: true },
        },
      ],
    },
  ],
  navigation: { items: [{ label: 'Home', target: '/' }] },
  footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
  integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${String(e)}`;
  }
};
const rename = (name: string) => [{ op: 'updateBusiness', value: { name } }];

beforeAll(async () => {
  migrator = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.migrator, max: 2 });
  const publish = async (label: string) =>
    (
      await migrator.query<{ template_id: string }>(
        `SELECT template_id FROM app.operator_publish_builtin_template($1, $2, 'gym', 'Builder suite template.', '1.0', $3::jsonb, '{"fields":[]}'::jsonb, $4)`,
        [
          unique(label).slice(0, 40),
          `Builder ${label}`,
          JSON.stringify(config),
          uuidv7().replace(/-/g, '').padEnd(64, '0'),
        ],
      )
    ).rows[0]!.template_id;
  templateId = await publish('bld');
  otherTemplateId = await publish('bld2');
});
afterAll(async () => {
  await migrator.end();
  await closeAll();
});

/** A workspace with a draft on a new project and the editor holding the lock. */
async function editing() {
  const ws = await workspaceWith(['admin', 'editor', 'viewer']);
  const editor = ws.members.editor!.id;
  const { id: projectId } = await projects.createProject(ws.owner.id, {
    workspaceId: ws.id,
    requestKey: uuidv7(),
    name: 'Builder project',
    category: 'gym',
  });
  await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId });
  expect((await builder.acquireLock(editor, { workspaceId: ws.id, projectId })).held).toBe(true);
  const at = <T extends object>(input: T) => ({ workspaceId: ws.id, projectId, ...input });
  return { ws, editor, projectId, at };
}

describe('createDraftFromTemplate (FR-PRJ-01)', () => {
  it('starts revision 1 from the latest published version and records the template on the project', async () => {
    const ws = await workspaceWith(['editor', 'viewer']);
    const editor = ws.members.editor!.id;
    const { id: projectId } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: uuidv7(),
      name: 'Draft from template',
    });
    expect(
      await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId }),
    ).toEqual({
      revision: 1,
      created: true,
    });
    const view = await builder.getDraft(ws.members.viewer!.id, ws.id, projectId);
    expect(view).toMatchObject({ revision: 1, templateId, lock: null, canUndo: false, canRedo: false });
    expect(view.config.business.name).toBe('Iron Pulse Fitness');
    // Repeating is idempotent; another template while a draft exists is refused.
    expect(
      await builder.createDraftFromTemplate(editor, { workspaceId: ws.id, projectId, templateId }),
    ).toEqual({
      revision: 1,
      created: false,
    });
    expect(
      await code(
        builder.createDraftFromTemplate(editor, {
          workspaceId: ws.id,
          projectId,
          templateId: otherTemplateId,
        }),
      ),
    ).toBe('DRAFT_EXISTS');
  });

  it('viewers cannot start a draft; unknown templates and another workspace’s project are NOT_FOUND', async () => {
    const ws = await workspaceWith(['viewer']);
    const other = await workspaceWith();
    const { id: projectId } = await projects.createProject(ws.owner.id, {
      workspaceId: ws.id,
      requestKey: uuidv7(),
      name: 'Guarded',
    });
    const { id: foreignProject } = await projects.createProject(other.owner.id, {
      workspaceId: other.id,
      requestKey: uuidv7(),
      name: 'Foreign',
    });
    expect(
      await code(
        builder.createDraftFromTemplate(ws.members.viewer!.id, { workspaceId: ws.id, projectId, templateId }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        builder.createDraftFromTemplate(ws.owner.id, { workspaceId: ws.id, projectId, templateId: uuidv7() }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await code(
        builder.createDraftFromTemplate(ws.owner.id, {
          workspaceId: ws.id,
          projectId: foreignProject,
          templateId,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await code(builder.getDraft(ws.owner.id, ws.id, projectId))).toBe('NO_DRAFT');
  });
});

describe('the edit lock (FR-BLD-07; approved 2026-11-14)', () => {
  it('another member sees who holds the lock and cannot save; an admin may take it over (audited)', async () => {
    const { ws, editor, projectId, at } = await editing();
    const admin = ws.members.admin!.id;
    const seen = await builder.acquireLock(admin, at({}));
    expect(seen.held).toBe(false);
    expect(seen.lock).toMatchObject({ holderUserId: editor, mine: false });
    expect(
      await code(
        builder.applyChange(admin, at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('X') })),
      ),
    ).toBe('LOCK_REQUIRED');
    // Only owners and admins take a live lock over.
    expect(await code(builder.takeOverLock(ws.members.viewer!.id, at({})))).toBe('FORBIDDEN');
    await builder.takeOverLock(admin, at({}));
    expect((await builder.getDraft(admin, ws.id, projectId)).lock).toMatchObject({
      holderUserId: admin,
      mine: true,
    });
    expect(
      await code(
        builder.applyChange(editor, at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('Y') })),
      ),
    ).toBe('LOCK_REQUIRED');
    const audit = await db.withTenant((await db.resolveTenantScope(ws.owner.id, ws.id))!, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'draft.lock.taken_over', projectId },
        select: { actorId: true, metadata: true },
      }),
    );
    expect(audit).toEqual([{ actorId: admin, metadata: { previousHolder: editor } }]);
  });

  it('the holder renews and releases; a released lock is free for the next editor', async () => {
    const { ws, editor, at } = await editing();
    expect((await builder.acquireLock(editor, at({}))).held).toBe(true);
    await builder.releaseLock(editor, at({}));
    expect((await builder.acquireLock(ws.members.admin!.id, at({}))).held).toBe(true);
  });
});

describe('applyChange (FR-BLD-06)', () => {
  it('saves on the expected revision; a stale save is DRAFT_CONFLICT; a retry with the same id is idempotent', async () => {
    const { ws, editor, projectId, at } = await editing();
    const changeId = uuidv7();
    expect(
      await builder.applyChange(editor, at({ changeId, expectedRevision: 1, operations: rename('Pulse') })),
    ).toEqual({
      revision: 2,
    });
    // The browser retries the same request (lost response): same result, no second change.
    expect(
      await builder.applyChange(editor, at({ changeId, expectedRevision: 1, operations: rename('Pulse') })),
    ).toEqual({
      revision: 2,
    });
    expect(
      await code(
        builder.applyChange(editor, at({ changeId, expectedRevision: 1, operations: rename('Other') })),
      ),
    ).toBe('IDEMPOTENCY_MISMATCH');
    // Another save still based on revision 1 loses (no last-write-wins).
    expect(
      await code(
        builder.applyChange(
          editor,
          at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('Late') }),
        ),
      ),
    ).toBe('DRAFT_CONFLICT');
    const view = await builder.getDraft(editor, ws.id, projectId);
    expect(view).toMatchObject({ revision: 2, canUndo: true, canRedo: false });
    expect(view.config.business.name).toBe('Pulse');
  });

  it('an operation that would make the config invalid is refused with field errors and changes nothing', async () => {
    const { ws, editor, projectId, at } = await editing();
    const bad = [{ op: 'updateSection', sectionId: 'nope', visible: false }];
    expect(
      await code(
        builder.applyChange(editor, at({ changeId: uuidv7(), expectedRevision: 1, operations: bad })),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await code(
        builder.applyChange(editor, at({ changeId: uuidv7(), expectedRevision: 1, operations: [] })),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      await code(
        builder.applyChange(
          editor,
          at({ changeId: uuidv7(), expectedRevision: 1, operations: [{ op: 'rewriteEverything' }] }),
        ),
      ),
    ).toBe('INVALID_INPUT');
    expect((await builder.getDraft(editor, ws.id, projectId)).revision).toBe(1);
  });

  it('a viewer cannot save; an archived project cannot be changed', async () => {
    const { ws, editor, projectId, at } = await editing();
    expect(
      await code(
        builder.applyChange(
          ws.members.viewer!.id,
          at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('V') }),
        ),
      ),
    ).toBe('FORBIDDEN');
    await projects.transitionProject(ws.owner.id, {
      workspaceId: ws.id,
      projectId,
      from: 'draft',
      to: 'archived',
    });
    expect(
      await code(
        builder.applyChange(editor, at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('A') })),
      ),
    ).toBe('ARCHIVED');
  });
});

describe('undo and redo (one stack per project, approved 2026-11-14)', () => {
  it('undo walks back, redo walks forward, and a new change clears redo', async () => {
    const { ws, editor, projectId, at } = await editing();
    const name = async () => (await builder.getDraft(editor, ws.id, projectId)).config.business.name;
    const sections = async () =>
      (await builder.getDraft(editor, ws.id, projectId)).config.pages[0]!.sections.map((s) => s.id);
    await builder.applyChange(
      editor,
      at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('A') }),
    );
    await builder.applyChange(
      editor,
      at({
        changeId: uuidv7(),
        expectedRevision: 2,
        operations: [{ op: 'moveSection', sectionId: 's2', toIndex: 0 }],
      }),
    );
    expect(await sections()).toEqual(['s2', 's1']);

    expect(await builder.undo(editor, at({ expectedRevision: 3 }))).toEqual({ revision: 4 });
    expect([await name(), await sections()]).toEqual(['A', ['s1', 's2']]);
    await builder.undo(editor, at({ expectedRevision: 4 }));
    expect(await name()).toBe('Iron Pulse Fitness');
    expect(await code(builder.undo(editor, at({ expectedRevision: 5 })))).toBe('NOTHING_TO_UNDO');

    await builder.redo(editor, at({ expectedRevision: 5 }));
    expect([await name(), await sections()]).toEqual(['A', ['s1', 's2']]);
    await builder.redo(editor, at({ expectedRevision: 6 }));
    expect(await sections()).toEqual(['s2', 's1']);
    expect(await code(builder.redo(editor, at({ expectedRevision: 7 })))).toBe('NOTHING_TO_REDO');

    // Undo once more, then a new change: the undone change can no longer be redone.
    await builder.undo(editor, at({ expectedRevision: 7 }));
    expect((await builder.getDraft(editor, ws.id, projectId)).canRedo).toBe(true);
    await builder.applyChange(
      editor,
      at({ changeId: uuidv7(), expectedRevision: 8, operations: rename('C') }),
    );
    const view = await builder.getDraft(editor, ws.id, projectId);
    expect(view).toMatchObject({ revision: 9, canUndo: true, canRedo: false });
    expect(await code(builder.redo(editor, at({ expectedRevision: 9 })))).toBe('NOTHING_TO_REDO');
    // Undo and redo need the lock and the current revision, like a save.
    expect(await code(builder.undo(editor, at({ expectedRevision: 3 })))).toBe('DRAFT_CONFLICT');
    expect(await code(builder.undo(ws.members.admin!.id, at({ expectedRevision: 9 })))).toBe('LOCK_REQUIRED');
  });

  it(`undo reaches the last ${BUILDER_LIMITS.undoDepth} changes and no further`, async () => {
    const { ws, editor, projectId, at } = await editing();
    const total = BUILDER_LIMITS.undoDepth + 1;
    for (let i = 0; i < total; i++) {
      await builder.applyChange(
        editor,
        at({ changeId: uuidv7(), expectedRevision: i + 1, operations: rename(`N${i}`) }),
      );
    }
    let revision = total + 1;
    for (let i = 0; i < BUILDER_LIMITS.undoDepth; i++) {
      revision = (await builder.undo(editor, at({ expectedRevision: revision }))).revision;
    }
    expect((await builder.getDraft(editor, ws.id, projectId)).config.business.name).toBe('N0');
    expect(await code(builder.undo(editor, at({ expectedRevision: revision })))).toBe('UNDO_LIMIT');
    expect((await builder.getDraft(editor, ws.id, projectId)).canUndo).toBe(false);
  });
});

describe('proposals (source ai/client; P4 and P5 use them)', () => {
  it('a proposal leaves the draft alone until a member with the lock accepts it; rejected ones stay rejected', async () => {
    const { ws, editor, projectId, at } = await editing();
    const { changeSetId } = await builder.proposeChange(
      editor,
      at({ source: 'ai', baseRevision: 1, operations: rename('Suggested'), summary: 'A better name' }),
    );
    expect((await builder.getDraft(editor, ws.id, projectId)).revision).toBe(1);
    expect(await code(builder.acceptProposal(ws.members.admin!.id, at({ changeSetId })))).toBe(
      'LOCK_REQUIRED',
    );
    expect(await builder.acceptProposal(editor, at({ changeSetId }))).toEqual({ revision: 2 });
    expect((await builder.getDraft(editor, ws.id, projectId)).config.business.name).toBe('Suggested');
    // An accepted proposal is undoable like any change.
    await builder.undo(editor, at({ expectedRevision: 2 }));
    expect((await builder.getDraft(editor, ws.id, projectId)).config.business.name).toBe(
      'Iron Pulse Fitness',
    );

    const second = await builder.proposeChange(
      editor,
      at({ source: 'client', baseRevision: 3, operations: rename('Client') }),
    );
    await builder.rejectProposal(editor, at({ changeSetId: second.changeSetId }));
    expect(await code(builder.acceptProposal(editor, at({ changeSetId: second.changeSetId })))).toBe(
      'NOT_FOUND',
    );
  });

  it('a proposal made for an older revision cannot be accepted', async () => {
    const { editor, at } = await editing();
    const { changeSetId } = await builder.proposeChange(
      editor,
      at({ source: 'ai', baseRevision: 1, operations: rename('Old') }),
    );
    await builder.applyChange(
      editor,
      at({ changeId: uuidv7(), expectedRevision: 1, operations: rename('Newer') }),
    );
    expect(await code(builder.acceptProposal(editor, at({ changeSetId })))).toBe('PROPOSAL_STALE');
  });
});
