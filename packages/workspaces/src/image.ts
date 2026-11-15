/**
 * P3 S6: image checks and re-encoding (FR-BLD-05, SEC-08, ADR-009; approved 2026-11-15). An upload is untrusted
 * until this module has:
 *   - sniffed its first bytes: JPEG, PNG or WebP only (SVG, HEIC, GIF, PDF and everything else are refused,
 *     whatever the browser claimed);
 *   - decoded it under a pixel limit (a small file that expands into a huge bitmap is refused before decoding);
 *   - turned it upright (EXIF orientation) and re-encoded it as WebP in the fixed widths 400/800/1200/1600, which
 *     drops every metadata block (EXIF, GPS, XMP, ICC: sharp writes none unless asked) and any trailing bytes.
 * The original is never served: only these variants are.
 */
import type { Sharp, SharpOptions } from 'sharp';

/** Loaded on first use: only the upload finisher needs the native module, not every dashboard page. */
let sharpModule: Promise<(input: Uint8Array, options: SharpOptions) => Sharp> | undefined;
const loadSharp = () => (sharpModule ??= import('sharp').then((m) => m.default));

export const IMAGE_WIDTHS = [400, 800, 1200, 1600] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export const IMAGE_LIMITS = {
  /** Approved 2026-11-15. */
  maxBytes: 10 * 1024 * 1024,
  /** 40 megapixels: any phone photo, not a decompression bomb. */
  maxPixels: 40_000_000,
  /** Spike E: WebP q78 is visually clean at about a third of JPEG's bytes. */
  webpQuality: 78,
} as const;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export type RejectReason =
  'upload_missing' | 'too_large' | 'unsupported_type' | 'too_many_pixels' | 'not_an_image';

export interface ImageVariant {
  /** The width slot (srcset descriptor). A slot above the original holds the original width, never upscaled. */
  width: ImageWidth;
  body: Uint8Array;
}

export type ProcessedImage =
  | { ok: true; type: AcceptedImageType; width: number; height: number; variants: ImageVariant[] }
  | { ok: false; reason: RejectReason };

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);

/** The real type from the first bytes, or null for anything that is not a JPEG, PNG or WebP. */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/**
 * The width slots for an image `width` pixels wide: every preset up to it, plus the next preset above it (filled
 * with the original width) so the largest variant keeps the original's detail. At least one slot.
 */
export function variantSlots(width: number): ImageWidth[] {
  const slots: ImageWidth[] = [];
  for (const w of IMAGE_WIDTHS) {
    slots.push(w);
    if (w >= width) break;
  }
  return slots;
}

/** Approved 2026-11-15 (S6 part 2): the crop shapes the templates' image slots use. */
export const CROP_ASPECTS = { '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9 } as const;
export type CropAspect = keyof typeof CROP_ASPECTS;

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest rectangle of `aspect` inside a `width` x `height` image, placed by `x` and `y` (0 = left/top edge,
 * 50 = centre, 100 = right/bottom edge). Always inside the image and at least 1 pixel.
 */
export function cropRect(width: number, height: number, aspect: CropAspect, x: number, y: number): CropRect {
  const ratio = CROP_ASPECTS[aspect];
  let w = width;
  let h = Math.round(width / ratio);
  if (h > height) {
    h = height;
    w = Math.round(height * ratio);
  }
  w = Math.max(1, Math.min(w, width));
  h = Math.max(1, Math.min(h, height));
  const clamp = (v: number) => Math.min(100, Math.max(0, Number.isFinite(v) ? v : 50)) / 100;
  return {
    left: Math.round((width - w) * clamp(x)),
    top: Math.round((height - h) * clamp(y)),
    width: w,
    height: h,
  };
}

const pixelLimit = (error: unknown) => error instanceof Error && /pixel limit/i.test(error.message);

export async function processImage(
  bytes: Uint8Array,
  options: {
    maxBytes?: number;
    maxPixels?: number;
    /** S6 part 2: cut this shape out of the upright image before the variants are made. */
    crop?: { aspect: CropAspect; x: number; y: number };
  } = {},
): Promise<ProcessedImage> {
  const maxBytes = options.maxBytes ?? IMAGE_LIMITS.maxBytes;
  const maxPixels = options.maxPixels ?? IMAGE_LIMITS.maxPixels;
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, reason: 'unsupported_type' };

  const input = { limitInputPixels: maxPixels, failOn: 'error' as const, pages: 1 };
  const sharp = await loadSharp();
  let width: number;
  let height: number;
  try {
    const meta = await sharp(bytes, input).metadata();
    // The decoder must agree with the magic bytes (a JPEG header glued to something else is not a JPEG).
    const format =
      meta.format === 'jpeg'
        ? 'image/jpeg'
        : meta.format === 'png'
          ? 'image/png'
          : meta.format === 'webp'
            ? 'image/webp'
            : null;
    if (format !== type || !meta.width || !meta.height) return { ok: false, reason: 'not_an_image' };
    if (meta.width * meta.height > maxPixels) return { ok: false, reason: 'too_many_pixels' };
    // Orientations 5-8 rotate by 90 degrees: the upright image has the sides swapped.
    const swapped = (meta.orientation ?? 1) >= 5;
    width = swapped ? meta.height : meta.width;
    height = swapped ? meta.width : meta.height;
  } catch (error) {
    return { ok: false, reason: pixelLimit(error) ? 'too_many_pixels' : 'not_an_image' };
  }

  try {
    let upright = sharp(bytes, input).rotate();
    if (options.crop) {
      // extract() after rotate() needs the rotation applied first: materialise the upright image once.
      const rect = cropRect(width, height, options.crop.aspect, options.crop.x, options.crop.y);
      const flat = await upright.raw().toBuffer({ resolveWithObject: true });
      upright = sharp(flat.data, {
        raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels },
      }).extract(rect);
      width = rect.width;
      height = rect.height;
    }
    const variants: ImageVariant[] = [];
    for (const slot of variantSlots(width)) {
      const body = await upright
        .clone()
        .resize({ width: Math.min(slot, width), withoutEnlargement: true })
        .webp({ quality: IMAGE_LIMITS.webpQuality, effort: 4 })
        .toBuffer();
      variants.push({ width: slot, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) });
    }
    return { ok: true, type, width, height, variants };
  } catch (error) {
    // A pixel-limit error can also surface here (a header that lied about its size).
    return { ok: false, reason: pixelLimit(error) ? 'too_many_pixels' : 'not_an_image' };
  }
}
