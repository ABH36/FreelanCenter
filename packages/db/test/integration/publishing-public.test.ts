/**
 * P3 S7a: the visitor side of publishing through the real app_public client (`@platform/db/public`): resolve_host's
 * `live` outcome, get_published_version (live only) and get_staging_site (ok, revoked, expired, unavailable,
 * unknown). Who may write versions, pointers and links is covered by builder-model.test.ts and tests/isolation.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../src/client';
import { type PublicDatabase, createPublicDatabase } from '../../src/public';
import { uuidv7 } from '../../src/uuid';
import { pool, seedWorkspace, tenantDb, urls, type SeededWorkspace } from './helpers';

let db: TenantDatabase;
let auth: pg.Pool;
let visitor: PublicDatabase;
let A: SeededWorkspace;

const DAY = 86_400_000;

beforeAll(async () => {
  db = tenantDb();
  auth = pool(urls.auth, 2);
  visitor = createPublicDatabase({ connectionString: urls.public });
  A = await seedWorkspace(db, auth);
});
afterAll(async () => {
  await Promise.all([db.disconnect(), auth.end(), visitor.close()]);
});

describe('resolve_host and get_published_version', () => {
  it('a host is placeholder until the project has a live pointer, then live with that version', async () => {
    expect(await visitor.resolveHost(A.hostname)).toEqual({
      outcome: 'placeholder',
      workspaceId: A.scope.workspaceId,
      projectId: A.projectId,
    });
    const live = await db.withTenant(A.scope, async (tx) => {
      const v = await tx.siteVersion.create({
        data: {
          workspaceId: A.scope.workspaceId,
          projectId: A.projectId,
          kind: 'live',
          config: { schemaVersion: '1.0', marker: 'live-content' },
          assets: { a1: { 400: 'https://assets.example.test/a1/400.webp' } },
          schemaVersion: '1.0',
          checksum: 'b'.repeat(64),
          sourceDraftRevision: 1,
        },
        select: { id: true, number: true },
      });
      await tx.sitePointer.create({
        data: { workspaceId: A.scope.workspaceId, projectId: A.projectId, kind: 'live', siteVersionId: v.id },
      });
      return v;
    });
    // The seed already made staging version 1, so this is number 2.
    expect(live.number).toBe(2);
    expect(await visitor.resolveHost(A.hostname)).toEqual({
      outcome: 'live',
      workspaceId: A.scope.workspaceId,
      projectId: A.projectId,
      siteVersionId: live.id,
    });
    const content = await visitor.getPublishedVersion(live.id);
    expect(content?.config).toEqual({ schemaVersion: '1.0', marker: 'live-content' });
    expect(content?.assets).toEqual({ a1: { 400: 'https://assets.example.test/a1/400.webp' } });
    expect(content?.publishedAt).toBeInstanceOf(Date);

    // A staging version is never served by id, and neither is an unknown id.
    const staging = await db.withTenant(A.scope, (tx) =>
      tx.sitePointer.findFirstOrThrow({ where: { projectId: A.projectId, kind: 'staging' } }),
    );
    expect(await visitor.getPublishedVersion(staging.siteVersionId)).toBeNull();
    expect(await visitor.getPublishedVersion(uuidv7())).toBeNull();
  });
});

describe('get_staging_site', () => {
  it('answers ok with the current staging version, then revoked; expired and unknown have their own answers', async () => {
    const { link, expired, stagingVersionId } = await db.withTenant(A.scope, async (tx) => {
      const pointer = await tx.sitePointer.findFirstOrThrow({
        where: { projectId: A.projectId, kind: 'staging' },
      });
      const now = Date.now();
      return {
        stagingVersionId: pointer.siteVersionId,
        link: await tx.stagingLink.create({
          data: { workspaceId: A.scope.workspaceId, projectId: A.projectId, expiresAt: new Date(now + DAY) },
        }),
        expired: await tx.stagingLink.create({
          data: {
            workspaceId: A.scope.workspaceId,
            projectId: A.projectId,
            createdAt: new Date(now - 2 * DAY),
            expiresAt: new Date(now - DAY),
          },
        }),
      };
    });
    const ok = await visitor.getStagingSite(link.id);
    expect(ok).toMatchObject({ status: 'ok', siteVersionId: stagingVersionId, assets: {} });
    expect(ok.status === 'ok' && ok.sender).toBeTruthy();
    expect(ok.status === 'ok' && ok.publishedAt).toBeInstanceOf(Date);

    expect(await visitor.getStagingSite(expired.id)).toMatchObject({ status: 'expired' });
    expect(await visitor.getStagingSite(uuidv7())).toEqual({ status: 'unknown' });

    await db.withTenant(A.scope, (tx) =>
      tx.stagingLink.update({
        where: { id: link.id },
        data: { revokedAt: new Date(), revokedBy: A.ownerId },
      }),
    );
    const revoked = await visitor.getStagingSite(link.id);
    expect(revoked.status).toBe('revoked');
    expect('sender' in revoked && revoked.sender).toBeTruthy();
  });

  it('is unavailable for a project with nothing on staging', async () => {
    const link = await db.withTenant(A.scope, async (tx) => {
      const project = await tx.project.create({
        data: { workspaceId: A.scope.workspaceId, name: 'Nothing staged' },
        select: { id: true },
      });
      return tx.stagingLink.create({
        data: {
          workspaceId: A.scope.workspaceId,
          projectId: project.id,
          expiresAt: new Date(Date.now() + DAY),
        },
      });
    });
    expect(await visitor.getStagingSite(link.id)).toMatchObject({ status: 'unavailable' });
  });
});
