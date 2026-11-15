/**
 * P3 S6: the asset library against the local database and the S3Mock bucket pair (FR-BLD-05, SEC-08, ADR-009;
 * approved 2026-11-15). The browser's direct PUT is replayed with the signed URL the service returns.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@platform/db';
import { LOCAL_ASSET_STORAGE } from '@platform/db/testing';
import { createS3Storage } from '@platform/providers';
import { assetIdsIn, createAssetService, uploadKey } from '../../src/assets';
import { WorkspaceError } from '../../src/errors';
import { closeAll, db, projects, workspaceWith } from '../harness';

const storage = createS3Storage(LOCAL_ASSET_STORAGE);
const assets = createAssetService({ db, storage: () => storage });
const off = createAssetService({ db, storage: () => null });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${String(e)}`;
  }
};

async function waitForStorage() {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${LOCAL_ASSET_STORAGE.endpoint}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('S3Mock (packages/db/docker) is not reachable on 127.0.0.1:59090');
}

beforeAll(waitForStorage, 90_000);
afterAll(closeAll);

async function setup() {
  const ws = await workspaceWith(['editor', 'viewer']);
  const { id: projectId } = await projects.createProject(ws.owner.id, {
    workspaceId: ws.id,
    requestKey: uuidv7(),
    name: 'Asset project',
  });
  return { ws, projectId, editor: ws.members.editor!.id, viewer: ws.members.viewer!.id };
}

const photo = (w = 1000, h = 600) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .jpeg()
    .withExif({ IFD0: { Artist: 'Owner Name' } })
    .toBuffer();

async function upload(
  actor: string,
  ws: string,
  projectId: string,
  body: Buffer,
  contentType = 'image/jpeg',
) {
  const { assetId, upload: signed } = await assets.requestUpload(actor, {
    workspaceId: ws,
    projectId,
    fileName: 'C:\\fakepath\\shop front.jpg',
    contentType,
    size: body.byteLength,
  });
  const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(body) });
  expect(put.ok).toBe(true);
  return assetId;
}

describe('upload, finish, list (FR-BLD-05)', () => {
  it('an editor uploads a photo; it becomes WebP variants without metadata and the original is deleted', async () => {
    const { ws, projectId, editor } = await setup();
    const body = await photo();
    const assetId = await upload(editor, ws.id, projectId, body);
    const done = await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId });
    expect(done).toMatchObject({
      status: 'ready',
      fileName: 'shop front.jpg',
      width: 1000,
      height: 600,
      widths: [400, 800, 1200],
    });
    const thumb = await fetch(done.thumbnailUrl!);
    expect(thumb.ok).toBe(true);
    const bytes = Buffer.from(await thumb.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.exif]).toEqual(['webp', 400, undefined]);
    expect(bytes.includes('Owner Name')).toBe(false);
    // The original is gone from the private bucket.
    const key = uploadKey(
      ws.id,
      assetId,
      (
        await db.withTenant((await db.resolveTenantScope(editor, ws.id))!, (tx) =>
          tx.asset.findUniqueOrThrow({ where: { id: assetId }, select: { storageToken: true } }),
        )
      ).storageToken,
    );
    expect(await storage.readUpload(key, 1)).toBeNull();
    // Repeating returns the same outcome (idempotent) and the library lists it.
    expect((await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId })).status).toBe(
      'ready',
    );
    expect((await assets.list(editor, ws.id, projectId)).map((a) => a.id)).toEqual([assetId]);
    const map = await assets.renderAssets(editor, ws.id, projectId, [assetId, 'placeholder-1']);
    expect(Object.keys(map.get(assetId)!)).toEqual(['400', '800', '1200']);
    expect(map.has('placeholder-1')).toBe(false);
  });

  it('a file that is not what it claims is rejected with a reason and never served', async () => {
    const { ws, projectId, editor } = await setup();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const assetId = await upload(editor, ws.id, projectId, svg);
    const done = await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId });
    expect(done.status).toBe('rejected');
    expect(done.rejectMessage).toMatch(/JPEG, PNG and WebP/);
    expect(done.thumbnailUrl).toBeNull();
    expect(await assets.list(editor, ws.id, projectId)).toEqual([]);
  });

  it('finishing before the file arrived rejects it as missing', async () => {
    const { ws, projectId, editor } = await setup();
    const { assetId } = await assets.requestUpload(editor, {
      workspaceId: ws.id,
      projectId,
      fileName: 'x.png',
      contentType: 'image/png',
      size: 10,
    });
    expect((await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId })).status).toBe(
      'rejected',
    );
  });

  it('requests are checked: type, size, roles and configuration', async () => {
    const { ws, projectId, editor, viewer } = await setup();
    const req = (actor: string, extra: object) =>
      code(
        assets.requestUpload(actor, {
          workspaceId: ws.id,
          projectId,
          fileName: 'a.jpg',
          contentType: 'image/jpeg',
          size: 100,
          ...extra,
        }),
      );
    expect(await req(editor, { contentType: 'image/svg+xml' })).toBe('INVALID_INPUT');
    expect(await req(editor, { contentType: 'image/heic' })).toBe('INVALID_INPUT');
    expect(await req(editor, { size: 10 * 1024 * 1024 + 1 })).toBe('INVALID_INPUT');
    expect(await req(editor, { size: 0 })).toBe('INVALID_INPUT');
    expect(await req(viewer, {})).toBe('FORBIDDEN');
    expect(await req(editor, { projectId: uuidv7() })).toBe('NOT_FOUND');
    expect(
      await code(
        off.requestUpload(editor, {
          workspaceId: ws.id,
          projectId,
          fileName: 'a.jpg',
          contentType: 'image/jpeg',
          size: 1,
        }),
      ),
    ).toBe('ASSETS_NOT_CONFIGURED');
    // A viewer cannot make the server process an editor's upload.
    const assetId = await upload(editor, ws.id, projectId, await photo(200, 200));
    expect(await code(assets.finishUpload(viewer, { workspaceId: ws.id, projectId, assetId }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId }))).toBe('ok');
  });

  it('alt text and hiding: hidden images leave the library but still render where used', async () => {
    const { ws, projectId, editor, viewer } = await setup();
    const assetId = await upload(editor, ws.id, projectId, await photo(500, 500));
    await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId });
    const at = { workspaceId: ws.id, projectId, assetId };
    expect((await assets.describe(editor, { ...at, alt: '  Our shop  ' })).alt).toBe('Our shop');
    expect(await code(assets.describe(editor, { ...at, alt: 'x'.repeat(201) }))).toBe('INVALID_INPUT');
    expect(await code(assets.hide(viewer, at))).toBe('FORBIDDEN');
    await assets.hide(editor, at);
    await assets.hide(editor, at); // idempotent
    expect(await assets.list(viewer, ws.id, projectId)).toEqual([]);
    expect((await assets.renderAssets(viewer, ws.id, projectId, [assetId])).has(assetId)).toBe(true);
  });

  it("another workspace's asset is not found, whatever ids are combined", async () => {
    const a = await setup();
    const b = await setup();
    const assetId = await upload(a.editor, a.ws.id, a.projectId, await photo(300, 300));
    await assets.finishUpload(a.editor, { workspaceId: a.ws.id, projectId: a.projectId, assetId });
    expect(
      await code(assets.finishUpload(b.editor, { workspaceId: b.ws.id, projectId: b.projectId, assetId })),
    ).toBe('NOT_FOUND');
    expect(await code(assets.hide(b.editor, { workspaceId: a.ws.id, projectId: a.projectId, assetId }))).toBe(
      'NOT_FOUND',
    );
    expect((await assets.renderAssets(b.editor, b.ws.id, b.projectId, [assetId])).size).toBe(0);
  });
});

describe('crop (S6 part 2)', () => {
  it('a crop is a new image of the chosen shape; the source stays unchanged', async () => {
    const { ws, projectId, editor, viewer } = await setup();
    const sourceId = await upload(editor, ws.id, projectId, await photo(2000, 1000));
    const source = await assets.finishUpload(editor, { workspaceId: ws.id, projectId, assetId: sourceId });
    await assets.describe(editor, { workspaceId: ws.id, projectId, assetId: sourceId, alt: 'Front desk' });
    const at = { workspaceId: ws.id, projectId, assetId: sourceId };
    const square = await assets.crop(editor, { ...at, aspect: '1:1', x: 50, y: 50 });
    // The largest variant (1600 x 800) is the source: a centred 800 x 800 square.
    expect(square).toMatchObject({
      status: 'ready',
      width: 800,
      height: 800,
      widths: [400, 800],
      alt: 'Front desk',
      fileName: 'shop front (1:1).webp',
    });
    expect(square.id).not.toBe(sourceId);
    const meta = await sharp(Buffer.from(await (await fetch(square.thumbnailUrl!)).arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([400, 400]);
    const after = (await assets.list(editor, ws.id, projectId)).find((a) => a.id === sourceId)!;
    expect([after.width, after.height, after.widths]).toEqual([source.width, source.height, source.widths]);

    expect(await code(assets.crop(editor, { ...at, aspect: '3:2', x: 50, y: 50 }))).toBe('INVALID_INPUT');
    expect(await code(assets.crop(editor, { ...at, aspect: '1:1', x: 150, y: 50 }))).toBe('INVALID_INPUT');
    expect(await code(assets.crop(viewer, { ...at, aspect: '1:1', x: 50, y: 50 }))).toBe('FORBIDDEN');
    expect(await code(assets.crop(editor, { ...at, assetId: uuidv7(), aspect: '1:1', x: 50, y: 50 }))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('assetIdsIn', () => {
  it('finds every assetId in a config', () => {
    const ids = assetIdsIn({
      business: { logo: { assetId: 'l', alt: 'x' } },
      pages: [
        { sections: [{ props: { image: { assetId: 'a', alt: '' }, images: [{ assetId: 'b', alt: '' }] } }] },
      ],
    });
    expect([...ids].sort()).toEqual(['a', 'b', 'l']);
  });
});
