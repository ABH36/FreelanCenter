'use server';
/**
 * Asset library server actions (P3 S6, module 05; FR-BLD-05). Thin wrappers over the asset service
 * (packages/workspaces/src/assets.ts): the user id comes from the server-side session, every id is only a selector,
 * and the service authorizes, validates the file, signs the upload and checks the result. The file itself never
 * passes through these actions: the browser PUTs it to the signed URL. Each action is registered with the IDOR
 * harness in tests/isolation/src/actions.ts.
 */
import type { AssetView as ServiceAssetView } from '@platform/workspaces';
import type { AssetView, SignedUploadView } from '@/lib/asset-types';
import { type EditorResult, runEditor } from '@/lib/editor-run';
import { assetService } from '@/lib/workspaces';

interface Target {
  workspaceId: string;
  projectId: string;
}

/** Step 1: a signed URL for one file of this type and size. */
export async function requestAssetUploadAction(
  input: Target & { fileName: string; contentType: string; size: number },
): Promise<EditorResult<{ assetId: string; upload: SignedUploadView }>> {
  return runEditor(async (userId) => {
    const { assetId, upload } = await (
      await assetService()
    ).requestUpload(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      fileName: input?.fileName,
      contentType: input?.contentType,
      size: input?.size,
    });
    return { assetId, upload: { url: upload.url, headers: upload.headers } };
  });
}

/** Step 2: the server checks and processes the uploaded file. */
export async function finishAssetUploadAction(
  input: Target & { assetId: string },
): Promise<EditorResult<AssetView>> {
  return runEditor(async (userId) =>
    plain(
      await (
        await assetService()
      ).finishUpload(userId, {
        workspaceId: input?.workspaceId,
        projectId: input?.projectId,
        assetId: input?.assetId,
      }),
    ),
  );
}

export async function listAssetsAction(input: Target): Promise<EditorResult<AssetView[]>> {
  return runEditor(async (userId) =>
    (await (await assetService()).list(userId, input?.workspaceId, input?.projectId)).map(plain),
  );
}

export async function describeAssetAction(
  input: Target & { assetId: string; alt: string },
): Promise<EditorResult<AssetView>> {
  return runEditor(async (userId) =>
    plain(
      await (
        await assetService()
      ).describe(userId, {
        workspaceId: input?.workspaceId,
        projectId: input?.projectId,
        assetId: input?.assetId,
        alt: input?.alt,
      }),
    ),
  );
}

export async function hideAssetAction(input: Target & { assetId: string }): Promise<EditorResult> {
  return runEditor(async (userId) => {
    await (
      await assetService()
    ).hide(userId, {
      workspaceId: input?.workspaceId,
      projectId: input?.projectId,
      assetId: input?.assetId,
    });
    return undefined;
  });
}

/** Dates as ISO strings: the client gets plain JSON. */
function plain(a: ServiceAssetView): AssetView {
  return { ...a, createdAt: a.createdAt.toISOString() };
}

/** S6 part 2: a crop (1:1, 4:3, 16:9) saved as a new image in the library. */
export async function cropAssetAction(
  input: Target & { assetId: string; aspect: string; x: number; y: number },
): Promise<EditorResult<AssetView>> {
  return runEditor(async (userId) =>
    plain(
      await (
        await assetService()
      ).crop(userId, {
        workspaceId: input?.workspaceId,
        projectId: input?.projectId,
        assetId: input?.assetId,
        aspect: input?.aspect,
        x: input?.x,
        y: input?.y,
      }),
    ),
  );
}
