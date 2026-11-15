/**
 * P3 S6: the project asset library (module 05; FR-BLD-05, SEC-08, ADR-009; design approved by the Owner 2026-11-15).
 *
 *   1. requestUpload   an editor names a file (type, size); the server checks both, records a pending asset with a
 *                      random storage token and returns a 10-minute signed PUT for the private upload bucket. The
 *                      browser sends the file straight there (no file passes through a serverless function body).
 *   2. finishUpload    the server reads the upload back (10 MB cap), sniffs and decodes it (image.ts), stores the
 *                      WebP variants in the public bucket, deletes the original, and marks the asset ready or
 *                      rejected. Repeating it returns the same outcome.
 *   3. list / describe / hide, and `renderAssets` for the renderer (the editor preview now; publishing in S7).
 *
 * Uploading does not need the edit lock (it does not change the draft); putting an image on the page is an
 * ordinary draft change (builder.applyChange) and does. Audit rows carry ids, sizes and outcomes, never file names.
 */
import { randomBytes } from 'node:crypto';
import type { TenantDatabase, Tx } from '@platform/db';
import type { Logger } from '@platform/logger';
import type { ObjectStorage } from '@platform/providers';
import { z } from 'zod';
import { WorkspaceError } from './errors';
import {
  ACCEPTED_IMAGE_TYPES,
  CROP_ASPECTS,
  type CropAspect,
  IMAGE_LIMITS,
  type ProcessedImage,
  type ImageWidth,
  type RejectReason,
  processImage,
} from './image';
import { createScopedRunner, parse, requireId } from './scoped';

export const ASSET_LIMITS = {
  perProject: 200,
  uploadUrlSeconds: 600,
  maxBytes: IMAGE_LIMITS.maxBytes,
  altMax: 200,
  fileNameMax: 200,
} as const;

export const REJECT_MESSAGES: Record<RejectReason, string> = {
  upload_missing: 'The file did not arrive. Try uploading it again.',
  too_large: 'This file is larger than 10 MB.',
  unsupported_type: 'Only JPEG, PNG and WebP photos can be used. Save it as a JPEG and try again.',
  too_many_pixels: 'This picture is too large (more than 40 megapixels). Make it smaller and try again.',
  not_an_image: 'This file could not be read as a picture.',
};

export const uploadKey = (workspaceId: string, assetId: string, token: string) =>
  `uploads/ws/${workspaceId}/${assetId}/${token}`;
export const variantKey = (workspaceId: string, assetId: string, token: string, width: ImageWidth) =>
  `ws/${workspaceId}/${assetId}/${token}/${width}.webp`;

export interface AssetView {
  id: string;
  status: 'pending' | 'ready' | 'rejected';
  fileName: string;
  alt: string;
  width: number | null;
  height: number | null;
  widths: ImageWidth[];
  bytes: number | null;
  /** The smallest variant, for thumbnails. Null until ready. */
  thumbnailUrl: string | null;
  /** Shown to the person who uploaded a rejected file. */
  rejectMessage: string | null;
  createdAt: Date;
}

/** What the renderer needs for one asset: its variant URLs by width. */
export type RenderAssets = Map<string, Partial<Record<ImageWidth, string>>>;

const fileNameSchema = z
  .string()
  .transform((s) =>
    // Display only, never a key: drop any path, control characters and odd whitespace.
    s
      .split(/[\\/]/)
      .pop()!
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, ASSET_LIMITS.fileNameMax),
  )
  .pipe(z.string().min(1, 'The file needs a name'));
const requestSchema = z.object({
  fileName: fileNameSchema,
  contentType: z.enum(ACCEPTED_IMAGE_TYPES, {
    error: 'Only JPEG, PNG and WebP photos can be used',
  }),
  size: z
    .number()
    .int()
    .min(1, 'The file is empty')
    .max(ASSET_LIMITS.maxBytes, 'The file is larger than 10 MB'),
});
const cropSchema = z.object({
  aspect: z.enum(Object.keys(CROP_ASPECTS) as [CropAspect, ...CropAspect[]], {
    error: 'Choose 1:1, 4:3 or 16:9',
  }),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});
const altSchema = z.string().trim().max(ASSET_LIMITS.altMax, 'At most 200 characters');

const select = {
  id: true,
  status: true,
  fileName: true,
  alt: true,
  width: true,
  height: true,
  variantWidths: true,
  variantBytes: true,
  rejectReason: true,
  storageToken: true,
  workspaceId: true,
  createdAt: true,
} as const;
type Row = {
  id: string;
  status: 'pending' | 'ready' | 'rejected';
  fileName: string;
  alt: string;
  width: number | null;
  height: number | null;
  variantWidths: number[];
  variantBytes: number | null;
  rejectReason: string | null;
  storageToken: string;
  workspaceId: string;
  createdAt: Date;
};

export interface AssetServiceDeps {
  db: TenantDatabase;
  /** `null` when uploads are not configured in this environment (ASSETS_NOT_CONFIGURED). */
  storage: () => ObjectStorage | null;
  logger?: Logger;
}

export function createAssetService(deps: AssetServiceDeps) {
  const { command, query } = createScopedRunner(deps.db, deps.logger);

  function storage(): ObjectStorage {
    const s = deps.storage();
    if (!s) throw new WorkspaceError('ASSETS_NOT_CONFIGURED');
    return s;
  }

  function view(row: Row, s: ObjectStorage | null): AssetView {
    const widths = (row.variantWidths ?? []) as ImageWidth[];
    const smallest = widths[0];
    return {
      id: row.id,
      status: row.status,
      fileName: row.fileName,
      alt: row.alt,
      width: row.width,
      height: row.height,
      widths,
      bytes: row.variantBytes,
      thumbnailUrl:
        s && row.status === 'ready' && smallest
          ? s.publicUrl(variantKey(row.workspaceId, row.id, row.storageToken, smallest))
          : null,
      rejectMessage:
        row.status === 'rejected'
          ? (REJECT_MESSAGES[row.rejectReason as RejectReason] ?? REJECT_MESSAGES.not_an_image)
          : null,
      createdAt: row.createdAt,
    };
  }

  async function project(tx: Tx, projectId: unknown) {
    const id = requireId(projectId);
    const found = await tx.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!found) throw new WorkspaceError('NOT_FOUND');
    return found;
  }

  async function asset(tx: Tx, projectId: string, assetId: unknown): Promise<Row> {
    const id = requireId(assetId);
    const row = await tx.asset.findFirst({ where: { id, projectId }, select });
    if (!row) throw new WorkspaceError('NOT_FOUND');
    return row;
  }

  const audit = (
    projectId: string,
    assetId: string,
    metadata: Record<string, string | number | boolean | null>,
  ) => ({
    targetType: 'asset',
    targetId: assetId,
    projectId,
    metadata,
  });

  type Outcome =
    | { ok: true; width: number; height: number; widths: ImageWidth[]; bytes: number }
    | { ok: false; reason: RejectReason };

  /** Stores the variants of a processed image and returns the outcome to record. */
  async function storeVariants(
    s: ObjectStorage,
    row: { workspaceId: string; id: string; storageToken: string },
    processed: ProcessedImage,
  ): Promise<Outcome> {
    deps.logger?.info('assets.processed', {
      assetId: row.id,
      ok: processed.ok,
      ...(processed.ok ? {} : { reason: processed.reason }),
    });
    if (!processed.ok) return processed;
    // Variants first: a ready row always has its files (a retry rewrites the same immutable keys).
    for (const v of processed.variants) {
      await s.putPublic(variantKey(row.workspaceId, row.id, row.storageToken, v.width), v.body, 'image/webp');
    }
    return {
      ok: true,
      width: processed.width,
      height: processed.height,
      widths: processed.variants.map((v) => v.width),
      bytes: processed.variants.reduce((n, v) => n + v.body.byteLength, 0),
    };
  }

  /** Records the outcome of a pending asset once (a concurrent finisher's outcome stands) and audits it. */
  function settle(
    actorUserId: string,
    workspaceId: unknown,
    projectId: string,
    assetId: string,
    outcome: Outcome,
    extra: Record<string, string | number | boolean | null>,
  ): Promise<AssetView> {
    const s = deps.storage();
    return command<AssetView>(
      actorUserId,
      workspaceId,
      { action: outcome.ok ? 'asset.ready' : 'asset.rejected', capability: 'draft.edit' },
      async (tx) => {
        const updated = await tx.asset.updateMany({
          where: { id: assetId, projectId, status: 'pending' },
          data: outcome.ok
            ? {
                status: 'ready',
                width: outcome.width,
                height: outcome.height,
                variantWidths: outcome.widths,
                variantBytes: outcome.bytes,
              }
            : { status: 'rejected', rejectReason: outcome.reason },
        });
        const now = await asset(tx, projectId, assetId);
        // Someone else finished it a moment ago: their outcome stands, no second audit row.
        if (updated.count === 0) return { result: view(now, s), audit: null };
        return {
          result: view(now, s),
          audit: audit(projectId, assetId, {
            ...(outcome.ok
              ? { widths: outcome.widths.length, bytes: outcome.bytes }
              : { reason: outcome.reason }),
            ...extra,
          }),
        };
      },
    );
  }

  return {
    /** Step 1: a pending asset and a signed upload URL for exactly this type and size. */
    async requestUpload(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        fileName: unknown;
        contentType: unknown;
        size: unknown;
      },
    ) {
      const file = parse(requestSchema, input, 'file');
      const s = storage();
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'asset.upload_started', capability: 'draft.edit' },
        async (tx, scope) => {
          const p = await project(tx, input.projectId);
          if (p.status === 'archived') throw new WorkspaceError('ARCHIVED');
          const storageToken = randomBytes(16).toString('base64url');
          const row = await tx.asset.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: p.id,
              fileName: file.fileName,
              declaredType: file.contentType,
              declaredBytes: file.size,
              storageToken,
            },
            select: { id: true },
          });
          const upload = await s.signUpload(uploadKey(scope.workspaceId, row.id, storageToken), {
            contentType: file.contentType,
            contentLength: file.size,
            expiresInSeconds: ASSET_LIMITS.uploadUrlSeconds,
          });
          return {
            result: { assetId: row.id, upload },
            audit: audit(p.id, row.id, { declaredType: file.contentType, declaredBytes: file.size }),
          };
        },
      );
    },

    /** Step 2: check and process the uploaded file. Idempotent: a finished asset returns its outcome. */
    async finishUpload(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; assetId: unknown },
    ): Promise<AssetView> {
      const s = storage();
      // Read under draft.edit first, so a viewer cannot make the server process anything.
      const pending = await query(actorUserId, input.workspaceId, 'draft.edit', async (tx) => {
        const p = await project(tx, input.projectId);
        return { projectId: p.id, row: await asset(tx, p.id, input.assetId) };
      });
      if (pending.row.status !== 'pending') return view(pending.row, s);
      const { row, projectId } = pending;
      const key = uploadKey(row.workspaceId, row.id, row.storageToken);

      let outcome: Outcome;
      try {
        const original = await s.readUpload(key, ASSET_LIMITS.maxBytes);
        outcome = original
          ? await storeVariants(s, row, await processImage(original))
          : { ok: false, reason: 'upload_missing' };
      } catch (error) {
        if (!(error instanceof Error && error.name === 'ObjectTooLargeError')) throw error;
        outcome = { ok: false, reason: 'too_large' };
      }
      const result = await settle(actorUserId, input.workspaceId, projectId, row.id, outcome, {});
      // The original is never served; a failure here leaves it to the bucket's lifecycle rule (1 day).
      await s
        .deleteUpload(key)
        .catch((error: unknown) =>
          deps.logger?.warn('assets.original_delete_failed', { assetId: row.id, error: String(error) }),
        );
      return result;
    },

    /** The project's library: ready images that are not hidden, newest first. Any member may read. */
    async list(actorUserId: string, workspaceId: unknown, projectId: unknown): Promise<AssetView[]> {
      const s = deps.storage();
      return query(actorUserId, workspaceId, 'projects.view', async (tx) => {
        const p = await project(tx, projectId);
        const rows = await tx.asset.findMany({
          where: { projectId: p.id, status: 'ready', deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: ASSET_LIMITS.perProject,
          select,
        });
        return rows.map((r) => view(r, s));
      });
    },

    /** The default alt text a new use of the image starts with (each use keeps its own in the site config). */
    async describe(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; assetId: unknown; alt: unknown },
    ): Promise<AssetView> {
      const alt = parse(altSchema, input.alt, 'alt');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'asset.described', capability: 'draft.edit' },
        async (tx) => {
          const p = await project(tx, input.projectId);
          const row = await asset(tx, p.id, input.assetId);
          if (row.status !== 'ready') throw new WorkspaceError('ASSET_NOT_READY');
          if (row.alt === alt) return { result: view(row, deps.storage()), audit: null };
          await tx.asset.update({ where: { id: row.id }, data: { alt }, select: { id: true } });
          return {
            result: view({ ...row, alt }, deps.storage()),
            audit: audit(p.id, row.id, { altLength: alt.length }),
          };
        },
      );
    },

    /**
     * Deleting is hiding (approved): out of the library, but pages that use the image keep showing it, and
     * published versions never break. Unused files are removed by retention (P8).
     */
    async hide(
      actorUserId: string,
      input: { workspaceId: unknown; projectId: unknown; assetId: unknown },
    ): Promise<void> {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'asset.deleted', capability: 'draft.edit' },
        async (tx) => {
          const p = await project(tx, input.projectId);
          const row = await tx.asset.findFirst({
            where: { id: requireId(input.assetId), projectId: p.id },
            select: { id: true, deletedAt: true },
          });
          if (!row) throw new WorkspaceError('NOT_FOUND');
          if (row.deletedAt) return { result: undefined, audit: null };
          await tx.asset.update({
            where: { id: row.id },
            data: { deletedAt: new Date() },
            select: { id: true },
          });
          return { result: undefined, audit: audit(p.id, row.id, {}) };
        },
      );
    },

    /**
     * S6 part 2 (approved 2026-11-15): a crop to 1:1, 4:3 or 16:9, placed by `x`/`y` (0..100). Originals are not
     * kept, so the crop is cut from the image's largest variant and saved as a new image in the library: the source
     * stays as it is, so pages that use it do not change and published versions never do.
     */
    async crop(
      actorUserId: string,
      input: {
        workspaceId: unknown;
        projectId: unknown;
        assetId: unknown;
        aspect: unknown;
        x: unknown;
        y: unknown;
      },
    ): Promise<AssetView> {
      const shape = parse(cropSchema, { aspect: input.aspect, x: input.x, y: input.y }, 'crop');
      const s = storage();
      const { row, projectId } = await query(actorUserId, input.workspaceId, 'draft.edit', async (tx) => {
        const p = await project(tx, input.projectId);
        if (p.status === 'archived') throw new WorkspaceError('ARCHIVED');
        return { projectId: p.id, row: await asset(tx, p.id, input.assetId) };
      });
      const widths = (row.variantWidths ?? []) as ImageWidth[];
      const largest = widths[widths.length - 1];
      if (row.status !== 'ready' || !largest) throw new WorkspaceError('ASSET_NOT_READY');
      const bytes = await s.readPublic(
        variantKey(row.workspaceId, row.id, row.storageToken, largest),
        ASSET_LIMITS.maxBytes,
      );
      if (!bytes) throw new WorkspaceError('ASSET_NOT_READY');

      const storageToken = randomBytes(16).toString('base64url');
      const created = await command(
        actorUserId,
        input.workspaceId,
        { action: 'asset.crop_started', capability: 'draft.edit' },
        async (tx, scope) => {
          const made = await tx.asset.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId,
              fileName: `${row.fileName.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 180)} (${shape.aspect}).webp`,
              declaredType: 'image/webp',
              declaredBytes: Math.min(ASSET_LIMITS.maxBytes, Math.max(1, bytes.byteLength)),
              storageToken,
              alt: row.alt,
            },
            select: { id: true, workspaceId: true },
          });
          return {
            result: made,
            audit: audit(projectId, made.id, { sourceAssetId: row.id, aspect: shape.aspect }),
          };
        },
      );
      const outcome = await storeVariants(
        s,
        { ...created, storageToken },
        await processImage(bytes, { crop: shape }),
      );
      return settle(actorUserId, input.workspaceId, projectId, created.id, outcome, {
        sourceAssetId: row.id,
      });
    },

    /**
     * Variant URLs for the asset ids a config uses (hidden ones included: a page that uses an image keeps it).
     * Ids that are not this project's ready assets are left out, so the renderer shows its placeholder.
     */
    async renderAssets(
      actorUserId: string,
      workspaceId: unknown,
      projectId: unknown,
      assetIds: readonly string[],
    ): Promise<RenderAssets> {
      const out: RenderAssets = new Map();
      const s = deps.storage();
      const ids = [...new Set(assetIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500);
      if (!s || ids.length === 0) return out;
      const rows = await query(actorUserId, workspaceId, 'projects.view', async (tx) => {
        const p = await project(tx, projectId);
        return tx.asset.findMany({
          where: { projectId: p.id, id: { in: ids }, status: 'ready' },
          select: { id: true, workspaceId: true, storageToken: true, variantWidths: true },
        });
      });
      for (const r of rows) {
        const urls: Partial<Record<ImageWidth, string>> = {};
        for (const w of r.variantWidths as ImageWidth[]) {
          urls[w] = s.publicUrl(variantKey(r.workspaceId, r.id, r.storageToken, w));
        }
        out.set(r.id, urls);
      }
      return out;
    },
  };
}

export type AssetService = ReturnType<typeof createAssetService>;

/** Every asset id a site config refers to (images, gallery items, logo, social image), wherever it sits. */
export function assetIdsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) assetIdsIn(v, out);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['assetId'] === 'string') out.add(record['assetId']);
    for (const v of Object.values(record)) assetIdsIn(v, out);
  }
  return out;
}
