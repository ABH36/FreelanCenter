/**
 * Template catalogue and preview links in the dashboard service (P2 S6b; FR-TPL-09), against the real database: roles
 * through RLS and the capability gate, the link verifies with the sites app's verifier, the audit row never holds the
 * link or the prospect's name, abuse limit, IDOR, and the not-configured state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPreviewToken } from '@platform/hosting';
import pg from 'pg';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { WorkspaceError } from '../../src/errors';
import { createTemplateService, PREVIEW_DAYS } from '../../src/templates';
import { audit, closeAll, db, createUser, unique, workspaceWith } from '../harness';

const SECRET = 'workspace-suite-preview-secret-local-only-0123456789';
const HOST = 'preview.sites.example.test';
const templates = createTemplateService({ db, preview: { host: HOST, secret: SECRET } });
const unconfigured = createTemplateService({ db, preview: null });

let migrator: pg.Pool;
let visitor: pg.Pool;
let slug: string;
let templateId: string;
const tokenOf = (url: string) => url.split('/p/')[1] as string;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${String(e)}`;
  }
};

beforeAll(async () => {
  migrator = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.migrator, max: 2 });
  visitor = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.public, max: 2 });
  slug = unique('tplsvc').slice(0, 40);
  // Publish a built-in as the seed command does (operator function, migrator only).
  const { rows } = await migrator.query<{ template_id: string }>(
    `SELECT template_id FROM app.operator_publish_builtin_template($1, 'Service Test Template', 'gym', 'A template for the service suite.', '1.0', '{"schemaVersion":"1.0"}'::jsonb, '{"fields":[]}'::jsonb, $2)`,
    [slug, 'f'.repeat(64)],
  );
  templateId = rows[0]!.template_id;
});
afterAll(async () => {
  await migrator.end();
  await visitor.end();
  await closeAll();
});

describe('catalogue', () => {
  it('every member, viewers included, can browse the published templates', async () => {
    const ws = await workspaceWith(['editor', 'viewer']);
    for (const user of [ws.owner, ws.members.editor!, ws.members.viewer!]) {
      const list = await templates.catalog(user.id, ws.id);
      expect(list.find((t) => t.slug === slug)).toMatchObject({
        templateId,
        name: 'Service Test Template',
        category: 'gym',
        version: 1,
      });
    }
  });

  it('a stranger gets NOT_FOUND, exactly like an unknown workspace', async () => {
    const ws = await workspaceWith();
    const stranger = await createUser();
    expect(await code(templates.catalog(stranger.id, ws.id))).toBe('NOT_FOUND');
    expect(await code(templates.catalog(ws.owner.id, 'not-a-uuid'))).toBe('NOT_FOUND');
  });
});

describe('preview links', () => {
  it('owner, admin and editor can make a link that the sites verifier accepts; it carries the template, the name and the expiry', async () => {
    const ws = await workspaceWith(['admin', 'editor']);
    for (const user of [ws.owner, ws.members.admin!, ws.members.editor!]) {
      const link = await templates.createPreviewLink(user.id, {
        workspaceId: ws.id,
        templateId,
        prospectName: '  Sharma Gym  ',
        days: 7,
      });
      expect(link.url.startsWith(`https://${HOST}/p/`)).toBe(true);
      expect(link.templateName).toBe('Service Test Template');
      const verdict = verifyPreviewToken({ current: SECRET }, tokenOf(link.url));
      expect(verdict.ok && verdict.claims).toMatchObject({ tpl: templateId, name: 'Sharma Gym' });
      const claims = verdict.ok ? verdict.claims : null;
      expect(claims!.exp - claims!.iat).toBe(7 * 86_400);
      expect(Math.abs(new Date(link.expiresAt).getTime() / 1000 - claims!.exp)).toBeLessThan(2);
    }
  });

  it('a viewer is refused (and the refusal is audited); nothing is minted', async () => {
    const ws = await workspaceWith(['viewer']);
    expect(
      await code(
        templates.createPreviewLink(ws.members.viewer!.id, { workspaceId: ws.id, templateId, days: 7 }),
      ),
    ).toBe('FORBIDDEN');
    const page = await audit.listAuditLog(ws.owner.id, ws.id);
    expect(
      page.items.some((r) => r.action === 'template.preview_link.created' && r.result === 'denied'),
    ).toBe(true);
  });

  it('writes an audit row with the template, days and whether it is personalised, and never the link or the name', async () => {
    const ws = await workspaceWith();
    const link = await templates.createPreviewLink(ws.owner.id, {
      workspaceId: ws.id,
      templateId,
      prospectName: 'Secret Prospect Pvt Ltd',
      days: 3,
    });
    const page = await audit.listAuditLog(ws.owner.id, ws.id);
    const row = page.items.find(
      (r) => r.action === 'template.preview_link.created' && r.result === 'success',
    );
    expect(row).toBeDefined();
    expect(row!.targetType).toBe('template');
    expect(row!.targetId).toBe(templateId);
    expect(row!.metadata).toEqual({ slug, days: 3, personalised: true, linkId: link.id });
    const dump = JSON.stringify(page.items);
    expect(dump).not.toContain(tokenOf(link.url));
    expect(dump).not.toContain('Secret Prospect');
  });

  it('works without a prospect name (the demo shows the template as designed)', async () => {
    const ws = await workspaceWith();
    const link = await templates.createPreviewLink(ws.owner.id, {
      workspaceId: ws.id,
      templateId,
      prospectName: '   ',
      days: 1,
    });
    const verdict = verifyPreviewToken({ current: SECRET }, tokenOf(link.url));
    expect(verdict.ok && 'name' in verdict.claims).toBe(false);
  });

  it('validates input with field errors: unknown validity, markup in the name, an over-long name', async () => {
    const ws = await workspaceWith();
    const fieldErrors = async (raw: Record<string, unknown>) => {
      try {
        await templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 7, ...raw });
        return null;
      } catch (e) {
        return e instanceof WorkspaceError ? Object.keys(e.fieldErrors) : ['unexpected'];
      }
    };
    expect(await fieldErrors({ days: 9 })).toEqual(['preview.days']);
    expect(await fieldErrors({ days: 'abc' })).not.toBeNull();
    expect(await fieldErrors({ prospectName: '<script>alert(1)</script>' })).toEqual([
      'preview.prospectName',
    ]);
    expect(await fieldErrors({ prospectName: 'x'.repeat(61) })).toEqual(['preview.prospectName']);
    for (const days of PREVIEW_DAYS) expect(await fieldErrors({ days })).toBeNull();
  });

  it('an unknown, malformed, private or unpublished template is the same NOT_FOUND', async () => {
    const ws = await workspaceWith();
    for (const id of ['01920000-0000-7000-8000-0000000000ee', 'nope', '', null, 42]) {
      expect(
        await code(templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId: id, days: 7 })),
        String(id),
      ).toBe('NOT_FOUND');
    }
    const priv = await db.withTenant((await db.resolveTenantScope(ws.owner.id, ws.id))!, (tx) =>
      tx.template.create({
        data: {
          workspaceId: ws.id,
          slug: unique('mine').slice(0, 40),
          name: 'Mine',
          category: 'generic',
          description: 'Private.',
          status: 'published',
        },
        select: { id: true },
      }),
    );
    expect(
      await code(
        templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId: priv.id, days: 7 }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('IDOR: a user of another workspace cannot make a link through this workspace id', async () => {
    const mine = await workspaceWith();
    const theirs = await workspaceWith();
    expect(
      await code(templates.createPreviewLink(theirs.owner.id, { workspaceId: mine.id, templateId, days: 7 })),
    ).toBe('NOT_FOUND');
  });

  it('is limited per person per day', async () => {
    const limited = createTemplateService({ db, preview: { host: HOST, secret: SECRET }, linksPerDay: 3 });
    const ws = await workspaceWith();
    for (let i = 0; i < 3; i++)
      await limited.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 1 });
    expect(
      await code(limited.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 1 })),
    ).toBe('RATE_LIMITED');
  });

  it('says so when previews are not configured, and uses http and the port for a localhost host', async () => {
    const ws = await workspaceWith();
    expect(unconfigured.previewsConfigured).toBe(false);
    expect(
      await code(unconfigured.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 7 })),
    ).toBe('PREVIEWS_NOT_CONFIGURED');
    const local = createTemplateService({ db, preview: { host: 'preview.sites.localhost', secret: SECRET } });
    const link = await local.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 1 });
    expect(link.url.startsWith('http://preview.sites.localhost:3001/p/')).toBe(true);
  });
});

const revokedAsVisitor = async (id: string) =>
  (await visitor.query<{ r: boolean }>('SELECT app.is_preview_link_revoked($1::uuid) AS r', [id])).rows[0]!.r;

describe('revoking a link (P2 S8b)', () => {
  it('the token carries the id of a stored row, which the list shows without the token or the name', async () => {
    const ws = await workspaceWith();
    const link = await templates.createPreviewLink(ws.owner.id, {
      workspaceId: ws.id,
      templateId,
      prospectName: 'Hidden Prospect',
      days: 3,
    });
    const verdict = verifyPreviewToken({ current: SECRET }, tokenOf(link.url));
    expect(verdict.ok && verdict.claims.lid).toBe(link.id);
    const list = await templates.listPreviewLinks(ws.owner.id, ws.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: link.id,
      templateName: 'Service Test Template',
      personalised: true,
      status: 'active',
      revokedAt: null,
    });
    const dump = JSON.stringify(list);
    expect(dump).not.toContain('Hidden Prospect');
    expect(dump).not.toContain(tokenOf(link.url));
    expect(await revokedAsVisitor(link.id)).toBe(false);
  });

  it('owner, admin and editor can revoke; visitors then see it revoked; the audit row names only the link', async () => {
    const ws = await workspaceWith(['admin', 'editor']);
    for (const user of [ws.owner, ws.members.admin!, ws.members.editor!]) {
      const link = await templates.createPreviewLink(user.id, { workspaceId: ws.id, templateId, days: 7 });
      expect(await revokedAsVisitor(link.id)).toBe(false);
      expect(await templates.revokePreviewLink(user.id, { workspaceId: ws.id, linkId: link.id })).toEqual({
        revoked: true,
        alreadyRevoked: false,
      });
      expect(await revokedAsVisitor(link.id)).toBe(true);
    }
    const page = await audit.listAuditLog(ws.owner.id, ws.id);
    const rows = page.items.filter(
      (r) => r.action === 'template.preview_link.revoked' && r.result === 'success',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.targetType).toBe('template_preview_link');
    expect(rows[0]!.metadata).toEqual({});
  });

  it('revoking twice changes nothing and writes no second audit row; the list shows it turned off', async () => {
    const ws = await workspaceWith();
    const link = await templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 7 });
    await templates.revokePreviewLink(ws.owner.id, { workspaceId: ws.id, linkId: link.id });
    expect(await templates.revokePreviewLink(ws.owner.id, { workspaceId: ws.id, linkId: link.id })).toEqual({
      revoked: true,
      alreadyRevoked: true,
    });
    const page = await audit.listAuditLog(ws.owner.id, ws.id);
    expect(page.items.filter((r) => r.action === 'template.preview_link.revoked')).toHaveLength(1);
    const list = await templates.listPreviewLinks(ws.owner.id, ws.id);
    expect(list[0]).toMatchObject({ id: link.id, status: 'revoked' });
    expect(list[0]!.revokedAt).not.toBeNull();
  });

  it('a viewer can neither list nor revoke (refusal audited); the link stays active', async () => {
    const ws = await workspaceWith(['viewer']);
    const link = await templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 7 });
    const v = ws.members.viewer!;
    expect(await code(templates.listPreviewLinks(v.id, ws.id))).toBe('FORBIDDEN');
    expect(await code(templates.revokePreviewLink(v.id, { workspaceId: ws.id, linkId: link.id }))).toBe(
      'FORBIDDEN',
    );
    expect(await revokedAsVisitor(link.id)).toBe(false);
    const page = await audit.listAuditLog(ws.owner.id, ws.id);
    expect(
      page.items.some((r) => r.action === 'template.preview_link.revoked' && r.result === 'denied'),
    ).toBe(true);
  });

  it('IDOR: another workspace cannot list, see or revoke this link, with its own or this workspace id', async () => {
    const mine = await workspaceWith();
    const theirs = await workspaceWith();
    const link = await templates.createPreviewLink(mine.owner.id, {
      workspaceId: mine.id,
      templateId,
      days: 7,
    });
    expect(await templates.listPreviewLinks(theirs.owner.id, theirs.id)).toEqual([]);
    expect(
      await code(templates.revokePreviewLink(theirs.owner.id, { workspaceId: theirs.id, linkId: link.id })),
    ).toBe('NOT_FOUND');
    expect(
      await code(templates.revokePreviewLink(theirs.owner.id, { workspaceId: mine.id, linkId: link.id })),
    ).toBe('NOT_FOUND');
    expect(
      await code(templates.revokePreviewLink(mine.owner.id, { workspaceId: mine.id, linkId: 'nope' })),
    ).toBe('NOT_FOUND');
    expect(await revokedAsVisitor(link.id)).toBe(false);
  });

  it('an unknown id is "not revoked" for visitors (links without a row are legacy or operator links)', async () => {
    expect(await revokedAsVisitor('01920000-0000-7000-8000-00000000dead')).toBe(false);
  });

  it('a link expires on its own: the list says expired once the date has passed', async () => {
    const later = createTemplateService({
      db,
      preview: { host: HOST, secret: SECRET },
      now: () => new Date(Date.now() + 2 * 86_400_000),
    });
    const ws = await workspaceWith();
    await templates.createPreviewLink(ws.owner.id, { workspaceId: ws.id, templateId, days: 1 });
    expect((await later.listPreviewLinks(ws.owner.id, ws.id))[0]!.status).toBe('expired');
  });
});
