/**
 * P2 S5b: template tables, immutable versions and the catalogue (FR-TPL-01/10, ADR-004). Real roles through the
 * pooler; the operator functions run as `migrator` (the seed command's role). Table-level isolation between tenants
 * is the isolation suite's job (tests/isolation); this file covers the behaviour specific to templates.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDatabase, TenantScope } from '../../src/client';
import {
  createUser,
  expectPgError,
  pool,
  seedWorkspace,
  tenantDb,
  uniqueSlug,
  urls,
  type SeededWorkspace,
} from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let migrator: pg.Pool;
let visitor: pg.Pool;
let bootstrap: pg.Pool;
let A: SeededWorkspace;
let B: SeededWorkspace;
let editor: TenantScope;
let viewer: TenantScope;

/** Reads as svc_definer (migrator holds SET on it): the only non-tenant role with narrow SELECT policies on these tables. */
async function definerRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await migrator.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE svc_definer');
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const config = (tag: string) => ({ schemaVersion: '1.0', marker: tag });
const manifest: { fields: never[] } = { fields: [] };
const tplSlug = () => uniqueSlug('tpl').slice(0, 40);

async function publish(slug: string, tag: string, name = 'Built-in test template', category = 'gym') {
  const { rows } = await migrator.query<{ template_id: string; version: number; created: boolean }>(
    'SELECT * FROM app.operator_publish_builtin_template($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)',
    [
      slug,
      name,
      category,
      'A template published by the integration test.',
      '1.0',
      JSON.stringify(config(tag)),
      JSON.stringify(manifest),
      hash(tag),
    ],
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  migrator = pool(urls.migrator, 4);
  visitor = pool(urls.public, 2);
  bootstrap = pool(urls.bootstrap, 1);
  A = await seedWorkspace(db, auth);
  B = await seedWorkspace(db, auth);
  const editorId = await createUser(auth);
  const viewerId = await createUser(auth);
  await db.withTenant(A.scope, async (tx) => {
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: editorId, role: 'editor' },
    });
    await tx.membership.create({
      data: { workspaceId: A.scope.workspaceId, userId: viewerId, role: 'viewer' },
    });
  });
  editor = (await db.resolveTenantScope(editorId, A.scope.workspaceId))!;
  viewer = (await db.resolveTenantScope(viewerId, A.scope.workspaceId))!;
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end(), migrator.end(), visitor.end(), bootstrap.end()]);
});

async function createPrivate(scope: TenantScope, slug = tplSlug()) {
  return db.withTenant(scope, (tx) =>
    tx.template.create({
      data: {
        workspaceId: scope.workspaceId,
        slug,
        name: 'My template',
        category: 'salon',
        description: 'Private template.',
        createdBy: scope.actorUserId,
      },
      select: { id: true },
    }),
  );
}

describe('private templates of a workspace', () => {
  it('an editor creates a template and its versions 1, 2 in order; the owner reads them', async () => {
    const t = await createPrivate(editor);
    const v = (version: number) =>
      db.withTenant(editor, (tx) =>
        tx.templateVersion.create({
          data: {
            workspaceId: editor.workspaceId,
            templateId: t.id,
            version,
            schemaVersion: '1.0',
            config: config(`v${version}`),
            manifest,
            contentHash: hash(`v${version}`),
          },
          select: { id: true },
        }),
      );
    await v(1);
    await v(2);
    const seen = await db.withTenant(A.scope, (tx) =>
      tx.templateVersion.findMany({
        where: { templateId: t.id },
        orderBy: { version: 'asc' },
        select: { version: true },
      }),
    );
    expect(seen.map((x) => x.version)).toEqual([1, 2]);
  });

  it('a viewer reads but cannot create or edit (RLS role check)', async () => {
    const t = await createPrivate(editor);
    expect(await db.withTenant(viewer, (tx) => tx.template.count({ where: { id: t.id } }))).toBe(1);
    await expectPgError(createPrivate(viewer), '42501');
    expect(
      await db.withTenant(viewer, (tx) =>
        tx.template.updateMany({ where: { id: t.id }, data: { name: 'x' } }),
      ),
    ).toEqual({ count: 0 });
  });

  it('rejects: gaps and repeats in the version number, a parent of another workspace, a malformed hash', async () => {
    const t = await createPrivate(editor);
    const base = {
      workspaceId: editor.workspaceId,
      templateId: t.id,
      schemaVersion: '1.0',
      config: config('x'),
      manifest,
    };
    const insert = (data: Record<string, unknown>) =>
      db.withTenant(editor, (tx) =>
        tx.templateVersion.create({ data: { ...base, contentHash: hash('x'), ...data } as never }),
      );
    await expectPgError(insert({ version: 2 }), '23514'); // must start at 1
    await insert({ version: 1 });
    await expectPgError(insert({ version: 1 }), '23505'); // repeat
    await expectPgError(insert({ version: 3 }), '23514'); // gap
    const other = await createPrivate(B.scope);
    // B's template: the composite FK (workspace_id, template_id) refuses it; the error is the same whether or not
    // that template exists, so it reveals nothing.
    await expectPgError(insert({ version: 1, templateId: other.id }), '23503');
    await expectPgError(insert({ version: 2, contentHash: 'not-a-hash' }), '23514');
    await expectPgError(insert({ version: 2, schemaVersion: 'one' }), '23514');
  });

  it('bounds the stored JSON: objects only, config 256 KB, manifest 64 KB', async () => {
    const t = await createPrivate(editor);
    const base = {
      workspaceId: editor.workspaceId,
      templateId: t.id,
      version: 1,
      schemaVersion: '1.0',
      contentHash: hash('b'),
    };
    const insert = (cfg: unknown, man: unknown) =>
      db.withTenant(editor, (tx) =>
        tx.templateVersion.create({ data: { ...base, config: cfg, manifest: man } as never }),
      );
    await expectPgError(insert([], manifest), '23514');
    await expectPgError(insert(config('a'), 'text'), '23514');
    await expectPgError(insert({ blob: 'x'.repeat(262_144) }, manifest), '23514');
    await expectPgError(insert(config('a'), { blob: 'x'.repeat(65_536) }), '23514');
    await expect(insert({ blob: 'x'.repeat(200_000) }, manifest)).resolves.toBeDefined();
  });

  it('field rules: slug format, category taxonomy, per-workspace slug uniqueness, name and description lengths', async () => {
    for (const data of [
      { slug: 'Bad Slug' },
      { slug: 'x'.repeat(41) },
      { category: 'spaceship' },
      { name: '   ' },
      { description: 'd'.repeat(301) },
    ]) {
      await expectPgError(
        db.withTenant(editor, (tx) =>
          tx.template.create({
            data: {
              workspaceId: editor.workspaceId,
              slug: tplSlug(),
              name: 'N',
              category: 'generic',
              description: 'D',
              ...data,
            },
          }),
        ),
        '23514',
      );
    }
    const slug = tplSlug();
    await createPrivate(editor, slug);
    await expectPgError(createPrivate(editor, slug), '23505');
    await expect(createPrivate(B.scope, slug)).resolves.toBeDefined(); // another workspace may reuse the slug
  });

  it('soft delete and rename work; owner, visibility and slug cannot change', async () => {
    const t = await createPrivate(editor);
    await db.withTenant(editor, (tx) =>
      tx.template.update({ where: { id: t.id }, data: { name: 'Renamed', status: 'published' } }),
    );
    await db.withTenant(editor, (tx) =>
      tx.template.update({ where: { id: t.id }, data: { deletedAt: new Date() } }),
    );
    const row = await db.withTenant(editor, (tx) => tx.template.findUniqueOrThrow({ where: { id: t.id } }));
    expect([row.name, row.status, row.deletedAt === null]).toEqual(['Renamed', 'published', false]);
    await expectPgError(
      db.withTenant(editor, (tx) =>
        tx.$executeRawUnsafe(`UPDATE app.templates SET slug = 'other-slug' WHERE id = $1::uuid`, t.id),
      ),
      '42501',
    );
    await expectPgError(
      db.withTenant(editor, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM app.templates WHERE id = $1::uuid`, t.id),
      ),
      '42501',
    );
  });
});

describe('immutable versions', () => {
  it('no UPDATE or DELETE for the application, and the trigger blocks TRUNCATE for everyone', async () => {
    const t = await createPrivate(editor);
    await db.withTenant(editor, (tx) =>
      tx.templateVersion.create({
        data: {
          workspaceId: editor.workspaceId,
          templateId: t.id,
          version: 1,
          schemaVersion: '1.0',
          config: config('i'),
          manifest,
          contentHash: hash('i'),
        },
      }),
    );
    for (const sql of [
      `UPDATE app.template_versions SET manifest = '{}'::jsonb`,
      `DELETE FROM app.template_versions`,
    ]) {
      await expectPgError(
        db.withTenant(editor, (tx) => tx.$executeRawUnsafe(sql)),
        '42501',
      );
    }
    await expectPgError(migrator.query('TRUNCATE app.template_versions'), '42501');
    const { rows } = await bootstrap.query(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'template_versions' AND NOT t.tgisinternal ORDER BY 1`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'template_versions_guard',
      'template_versions_immutable',
      'template_versions_no_truncate',
    ]);
  });
});

describe('platform built-ins: the operator function and the catalogue', () => {
  it('creates a template on first call, is idempotent for unchanged content, appends a version for changed content', async () => {
    const slug = tplSlug();
    const first = await publish(slug, 'one');
    expect(first).toMatchObject({ version: 1, created: true });
    const again = await publish(slug, 'one');
    expect(again).toEqual({ template_id: first.template_id, version: 1, created: false });
    const next = await publish(slug, 'two');
    expect(next).toEqual({ template_id: first.template_id, version: 2, created: true });
    const rows = await definerRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.template_versions WHERE template_id = $1`,
      [first.template_id],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('leaves platform audit rows (created once, one per new version, never for a no-op)', async () => {
    const slug = tplSlug();
    await publish(slug, 'a');
    await publish(slug, 'a');
    await publish(slug, 'b');
    const rows = await definerRows<{ action: string }>(
      `SELECT action FROM app.audit_logs WHERE action LIKE 'admin.template.%' AND metadata->>'slug' = $1 ORDER BY id`,
      [slug],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'admin.template.created',
      'admin.template.version_published',
      'admin.template.version_published',
    ]);
  });

  it('serialises concurrent seeds of one slug: one template, one version, exactly one creator', async () => {
    const slug = tplSlug();
    const results = await Promise.all(Array.from({ length: 8 }, () => publish(slug, 'race')));
    expect(new Set(results.map((r) => r.template_id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await definerRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.templates WHERE slug = $1 AND workspace_id IS NULL`,
      [slug],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses bad input through the table checks (category, slug, hash)', async () => {
    await expectPgError(publish(tplSlug(), 'x', 'Bad', 'spaceship'), '23514');
    await expectPgError(publish('Bad Slug', 'x'), '23514');
    await expectPgError(
      migrator.query(
        `SELECT * FROM app.operator_publish_builtin_template($1,'N','gym','D','1.0','{}'::jsonb,'{}'::jsonb,'zz')`,
        [tplSlug()],
      ),
      '23514',
    );
  });

  it('the catalogue shows published platform templates to tenants and visitors, latest version, content on request', async () => {
    const slug = tplSlug();
    const v1 = await publish(slug, 'cat-1', 'Catalogue template', 'taxi');
    const v2 = await publish(slug, 'cat-2', 'Catalogue template', 'taxi');
    expect(v2.version).toBe(2);
    const asTenant = await db.withTenant(A.scope, (tx) =>
      tx.$queryRawUnsafe<{ template_id: string; slug: string; version: number; visibility: string }[]>(
        `SELECT template_id, slug, version, visibility FROM app.list_catalog_templates() WHERE slug = $1`,
        slug,
      ),
    );
    expect(asTenant).toEqual([{ template_id: v1.template_id, slug, version: 2, visibility: 'platform' }]);
    const asVisitor = await visitor.query(
      `SELECT version FROM app.list_catalog_templates() WHERE slug = $1`,
      [slug],
    );
    expect(asVisitor.rows).toEqual([{ version: 2 }]);
    const latest = await visitor.query(
      `SELECT version, config->>'marker' AS marker FROM app.get_catalog_template($1::uuid)`,
      [v1.template_id],
    );
    expect(latest.rows).toEqual([{ version: 2, marker: 'cat-2' }]);
    const old = await visitor.query(
      `SELECT version, config->>'marker' AS marker FROM app.get_catalog_template($1::uuid, 1)`,
      [v1.template_id],
    );
    expect(old.rows).toEqual([{ version: 1, marker: 'cat-1' }]);
    expect(
      (await visitor.query(`SELECT 1 FROM app.get_catalog_template($1::uuid, 99)`, [v1.template_id])).rows,
    ).toEqual([]);
  });

  it('platform rows are invisible to tenants and visitors through the tables themselves', async () => {
    const slug = tplSlug();
    const t = await publish(slug, 'hidden');
    expect(await db.withTenant(A.scope, (tx) => tx.template.count({ where: { id: t.template_id } }))).toBe(0);
    expect(
      await db.withTenant(A.scope, (tx) =>
        tx.templateVersion.count({ where: { templateId: t.template_id } }),
      ),
    ).toBe(0);
    await expectPgError(visitor.query('SELECT 1 FROM app.templates'), '42501');
    await expectPgError(visitor.query('SELECT 1 FROM app.template_versions'), '42501');
  });

  it('archiving removes a built-in from the catalogue; republishing restores it; private templates are never listed', async () => {
    const slug = tplSlug();
    const t = await publish(slug, 'arch');
    const listed = () =>
      visitor
        .query(`SELECT 1 FROM app.list_catalog_templates() WHERE slug = $1`, [slug])
        .then((r) => r.rows.length);
    expect(await listed()).toBe(1);
    expect(
      (await migrator.query('SELECT app.operator_archive_builtin_template($1, $2) AS ok', [slug, 'test']))
        .rows[0].ok,
    ).toBe(true);
    expect(
      (await migrator.query('SELECT app.operator_archive_builtin_template($1, $2) AS ok', [slug, 'again']))
        .rows[0].ok,
    ).toBe(false);
    expect(await listed()).toBe(0);
    expect(
      (await visitor.query(`SELECT 1 FROM app.get_catalog_template($1::uuid)`, [t.template_id])).rows,
    ).toEqual([]);
    await publish(slug, 'arch');
    expect(await listed()).toBe(1);
    const priv = await createPrivate(editor);
    await db.withTenant(editor, (tx) =>
      tx.template.update({ where: { id: priv.id }, data: { status: 'published' } }),
    );
    expect((await visitor.query(`SELECT 1 FROM app.get_catalog_template($1::uuid)`, [priv.id])).rows).toEqual(
      [],
    );
  });

  it('only migrator can run the operator functions', async () => {
    const call = `SELECT * FROM app.operator_publish_builtin_template('x-probe','N','gym','D','1.0','{}'::jsonb,'{}'::jsonb,'${randomBytes(32).toString('hex')}')`;
    await expectPgError(visitor.query(call), '42501');
    await expectPgError(
      db.withTenant(A.scope, (tx) => tx.$queryRawUnsafe(call)),
      '42501',
    );
    await expectPgError(
      db.withTenant(A.scope, (tx) =>
        tx.$queryRawUnsafe(`SELECT app.operator_archive_builtin_template('x', 'y')`),
      ),
      '42501',
    );
  });
});
