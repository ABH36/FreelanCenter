import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cropRect, processImage, sniffImageType, variantSlots } from './image';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
const bytes = (b: Buffer) => new Uint8Array(b);

describe('sniffImageType (SEC-08)', () => {
  it('knows JPEG, PNG and WebP by their first bytes only', async () => {
    expect(sniffImageType(bytes(await solid(8, 8).jpeg().toBuffer()))).toBe('image/jpeg');
    expect(sniffImageType(bytes(await solid(8, 8).png().toBuffer()))).toBe('image/png');
    expect(sniffImageType(bytes(await solid(8, 8).webp().toBuffer()))).toBe('image/webp');
  });

  it('refuses SVG, HEIC, GIF, PDF and HTML whatever they are called', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(
      sniffImageType(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    ).toBeNull();
    expect(sniffImageType(enc('<!doctype html><html>'))).toBeNull();
    expect(sniffImageType(enc('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(enc('GIF89a'))).toBeNull();
    // HEIC: an ISO-BMFF box `ftypheic`.
    expect(
      sniffImageType(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])),
    ).toBeNull();
    expect(sniffImageType(bytes(await solid(8, 8).gif().toBuffer()))).toBeNull();
  });
});

describe('variantSlots (ADR-009)', () => {
  it('every preset up to the width plus the next one, never empty', () => {
    expect(variantSlots(300)).toEqual([400]);
    expect(variantSlots(400)).toEqual([400]);
    expect(variantSlots(1000)).toEqual([400, 800, 1200]);
    expect(variantSlots(1600)).toEqual([400, 800, 1200, 1600]);
    expect(variantSlots(6000)).toEqual([400, 800, 1200, 1600]);
  });
});

describe('processImage', () => {
  it('re-encodes to WebP in the fixed widths without upscaling', async () => {
    const result = await processImage(bytes(await solid(1000, 500).jpeg().toBuffer()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ type: 'image/jpeg', width: 1000, height: 500 });
    const sizes = await Promise.all(
      result.variants.map(async (v) => ({ slot: v.width, ...(await sharp(v.body).metadata()) })),
    );
    expect(sizes.map((s) => [s.slot, s.format, s.width, s.height])).toEqual([
      [400, 'webp', 400, 200],
      [800, 'webp', 800, 400],
      [1200, 'webp', 1000, 500],
    ]);
  });

  it('strips EXIF (GPS included) and turns the image upright', async () => {
    // 600x300 stored, orientation 6 (rotate 90 degrees): upright it is 300x600.
    const withExif = await solid(600, 300)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: 'Secret Person' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const result = await processImage(bytes(withExif));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.width, result.height]).toEqual([300, 600]);
    for (const v of result.variants) {
      const meta = await sharp(v.body).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(Buffer.from(v.body).includes('Secret Person')).toBe(false);
    }
    expect((await sharp(result.variants[0]!.body).metadata()).height).toBeGreaterThan(
      (await sharp(result.variants[0]!.body).metadata()).width!,
    );
  });

  it('refuses files over the size limit, non-images, mislabelled files and pixel bombs', async () => {
    const png = bytes(await solid(2000, 2000).png().toBuffer());
    expect(await processImage(png, { maxBytes: 100 })).toEqual({ ok: false, reason: 'too_large' });
    expect(await processImage(new TextEncoder().encode('<svg/>'))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    // JPEG magic bytes on a body that is not a JPEG.
    const fake = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('<script>x</script>')]);
    expect(await processImage(fake)).toEqual({ ok: false, reason: 'not_an_image' });
    // A truncated JPEG fails to decode.
    const jpeg = bytes(await solid(800, 800).jpeg().toBuffer());
    expect((await processImage(jpeg.slice(0, Math.floor(jpeg.length / 3)))).ok).toBe(false);
    // 4 megapixels of one colour compress to a few kB: refused under a 1-megapixel limit before decoding.
    expect(await processImage(png, { maxPixels: 1_000_000 })).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
  });

  it('takes the first frame of an animated WebP', async () => {
    const animated = await sharp({
      create: { width: 50, height: 100, channels: 3, background: 'red' },
    })
      .webp()
      .toBuffer();
    const result = await processImage(bytes(animated));
    expect(result.ok && result.variants.length).toBe(1);
  });
});

describe('crop (S6 part 2)', () => {
  it('cropRect: the largest rectangle of the shape, placed by the offsets, always inside', () => {
    expect(cropRect(1600, 1200, '16:9', 50, 50)).toEqual({ left: 0, top: 150, width: 1600, height: 900 });
    expect(cropRect(1600, 1200, '1:1', 0, 50)).toEqual({ left: 0, top: 0, width: 1200, height: 1200 });
    expect(cropRect(1600, 1200, '1:1', 100, 50)).toEqual({ left: 400, top: 0, width: 1200, height: 1200 });
    expect(cropRect(800, 1200, '4:3', 50, 0)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    // Out-of-range or missing offsets stay inside the image.
    expect(cropRect(1600, 1200, '1:1', 500, Number.NaN)).toEqual({
      left: 400,
      top: 0,
      width: 1200,
      height: 1200,
    });
    expect(cropRect(1, 1, '16:9', 50, 50)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('a cropped image has the new shape in every width and keeps the side that was chosen', async () => {
    // Left half red, right half blue: a square cut from the right edge is all blue.
    const half = await sharp({ create: { width: 800, height: 800, channels: 3, background: 'red' } })
      .extend({ right: 800, background: 'blue' })
      .png()
      .toBuffer();
    const result = await processImage(bytes(half), { crop: { aspect: '1:1', x: 100, y: 50 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.width, result.height]).toEqual([800, 800]);
    expect(result.variants.map((v) => v.width)).toEqual([400, 800]);
    const { dominant } = await sharp(result.variants[0]!.body).stats();
    expect(dominant.b).toBeGreaterThan(200);
    expect(dominant.r).toBeLessThan(60);
    const wide = await processImage(bytes(half), { crop: { aspect: '16:9', x: 50, y: 50 } });
    // 1600 x 800 is wider than 16:9: the full height is kept.
    expect(wide.ok && [wide.width, wide.height]).toEqual([1422, 800]);
  });
});
