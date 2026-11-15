/** Client-safe shapes of the asset library (P3 S6). Mirrors AssetView in @platform/workspaces with JSON dates. */
export type ImageWidth = 400 | 800 | 1200 | 1600;

export interface AssetView {
  id: string;
  status: 'pending' | 'ready' | 'rejected';
  fileName: string;
  alt: string;
  width: number | null;
  height: number | null;
  widths: ImageWidth[];
  bytes: number | null;
  thumbnailUrl: string | null;
  rejectMessage: string | null;
  createdAt: string;
}

export interface SignedUploadView {
  url: string;
  headers: Record<string, string>;
}

/** Approved 2026-11-15: the browser checks these first for a quick answer; the server checks them again. */
export const UPLOAD_RULES = {
  types: ['image/jpeg', 'image/png', 'image/webp'] as const,
  maxBytes: 10 * 1024 * 1024,
  accept: 'image/jpeg,image/png,image/webp',
} as const;
